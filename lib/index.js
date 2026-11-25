// dsh-auto-proxy — 三开关网络代理
//
// 三个用户可见的开关，各自独立：
//   「搜索走代理」 开 → 发往搜索引擎 / 搜索服务的请求走系统代理
//   「LLM 走代理」 开 → 发往模型网关的请求走系统代理
//   「网页走代理」 开 → 读网页（打开搜索结果、抓取页面）及其余非搜索非 LLM 的请求走系统代理
//   关 → 该类别始终直连
//
// 共同前提：系统代理开着才可能走代理；系统代理一关，立刻全部直连（不回退手填地址）。
//
// 覆盖范围：agent 进程的 globalThis.fetch（web_search 各 provider、插件 HTTP、LLM 请求）。
// 不含 web_fetch 的 harness 代理层与 Desktop 右侧浏览器，见 README。
//
// 设置界面：三个开关声明为 `.volatile()`，通过同源路由 /_dsh/auto-proxy 读写；
// 浏览器半侧见 lib/client.js（设置 → 自动代理）。

import z from "@deepseek-ai/schemastery";
import { readSystemProxy } from "./system-proxy.js";
import { proxiedFetch } from "./proxy-fetch.js";
import { matchesHost, parseTarget } from "./hosts.js";
import { classify, decideProxy } from "./classify.js";
import { providerHostsFrom } from "./provider-hosts.js";
import { readConfigField, readSwitches } from "./config-value.js";

export const name = "auto-proxy";
export const inject = [];

const SWITCH_KEYS = ["proxySearch", "proxyLLM", "proxyWeb"];

/** 认领自家的 fetch 包装器；Symbol.for 保证跨插件重载仍是同一个键。 */
const WRAPPER_FLAG = Symbol.for("dsh.auto-proxy.fetch-wrapper");
const WRAPPER_SOURCE = Symbol.for("dsh.auto-proxy.fetch-wrapper.source");

/** 跳过历史上没拆干净的自家包装层，拿到最底层的真实 fetch（避免自我叠加成深链）。 */
function unwrapOwnLayers(current) {
  let base = current;
  for (let i = 0; i < 8 && base && base[WRAPPER_FLAG] && base[WRAPPER_SOURCE]; i++) base = base[WRAPPER_SOURCE];
  return base;
}

export const Config = z
  .object({
    proxyLLM: z
      .boolean()
      .default(false)
      .description("LLM 请求走代理。打开后发往模型网关的请求走系统代理；关闭则始终直连。")
      .volatile(),
    proxySearch: z
      .boolean()
      .default(false)
      .description("搜索请求走代理。打开后发往搜索引擎 / 抓取服务的请求走系统代理；关闭则始终直连。")
      .volatile(),
    proxyWeb: z
      .boolean()
      .default(false)
      .description("网页走代理。打开后读取网页（打开搜索结果、抓取页面）等非搜索非 LLM 的请求走系统代理；关闭则始终直连。")
      .volatile(),
    searchHosts: z
      .array(z.string())
      .default([])
      .description("额外追加的“搜索”域名（自建 SearXNG、内网搜索等）。内置已含 Bing/Google/DDG/Exa/Tavily 等。"),
    llmHosts: z
      .array(z.string())
      .default([])
      .description("额外追加的“LLM”域名。留空时会自动从 DSH 的 provider 配置里读取 baseURL。"),
    noProxy: z
      .array(z.string())
      .default(["127.0.0.1", "localhost", "::1"])
      .description("命中这些主机/后缀的请求直连。系统代理自带的绕过列表会自动并入。"),
    pollIntervalMs: z
      .number()
      .step(500)
      .min(1000)
      .max(60000)
      .default(3000)
      .description("读取系统代理状态的间隔（毫秒）。"),
    timeout: z
      .number()
      .step(1000)
      .min(1000)
      .max(600000)
      .default(60000)
      .description("单次经代理请求的连接/握手超时（毫秒）。"),
    llmTimeout: z
      .number()
      .step(1000)
      .min(0)
      .max(3600000)
      .default(600000)
      .description("LLM 类请求等待响应的上限（毫秒），0 表示不限；连接与握手仍用 timeout。生图这类请求要几十秒到几分钟才回第一个字节。"),
  })
  .default({});

/** 只接受本机发来的设置请求（GUI 与 agent 都在本机）。 */
function isLocalRequest(req) {
  const address = String((req && req.socket && req.socket.remoteAddress) || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function apply(ctx, config) {
  const cfg = config || {};
  const logger = ctx && ctx.logger && typeof ctx.logger.error === "function" ? ctx.logger : console;
  const info = (...args) => (typeof logger.info === "function" ? logger.info(...args) : logger.error(...args));
  const warn = (...args) => (typeof logger.warn === "function" ? logger.warn(...args) : info(...args));

  let systemProxy = null; // 最近一次系统代理快照
  let discoveredLlmHosts = []; // 从 DSH 配置里读到的模型网关主机
  let settingsCtx = null; // settings 服务：发现模型网关 + 写回开关
  const reportedUnknown = new Set(); // 只提示一次的"网页类未代理"主机
  let originalFetch = globalThis.fetch;
  let wrapper = null;
  let timer = null;
  let disposed = false;

  const switches = () => readSwitches(cfg);
  /** 配置里的数组字段（可能是 volatile 引用，也可能直接是数组）。 */
  const listField = (ref) => {
    const value = readConfigField(ref, []);
    return Array.isArray(value) ? value : [];
  };
  const numberField = (ref, fallback) => {
    const value = Number(readConfigField(ref, fallback));
    return Number.isFinite(value) ? value : fallback;
  };

  const llmHosts = () => [...new Set([...listField(cfg.llmHosts), ...discoveredLlmHosts])];
  const anySwitchOn = () => {
    const current = switches();
    return current.proxySearch || current.proxyLLM || current.proxyWeb;
  };
  /** LLM 类请求等响应的上限：0 = 不限（交给调用方的 AbortSignal）。 */
  const llmResponseTimeout = () => Math.max(0, numberField(cfg.llmTimeout, 600000));

  /** 当前系统代理；返回 null 表示此刻任何请求都不该被代理。 */
  function activeProxy() {
    if (!anySwitchOn()) return null;
    const sys = systemProxy;
    if (!sys || sys.supported === false || sys.mode === "pac" || !sys.enabled) return null;
    if (!sys.host || !sys.port) return null;
    const bypass = Array.isArray(sys.bypass) ? sys.bypass : [];
    return {
      protocol: sys.protocol || "http",
      host: sys.host,
      port: Number(sys.port),
      noProxy: [...new Set([...listField(cfg.noProxy), ...bypass])],
      timeout: numberField(cfg.timeout, 60000) || 60000,
    };
  }

  /** 单次请求的决策：返回代理配置（走代理）或 null（直连）。 */
  function routeFor(input) {
    const proxy = activeProxy();
    if (!proxy) return null;
    const { hostname, pathname } = parseTarget(input);
    if (!hostname) return null;
    if (matchesHost(hostname, proxy.noProxy)) return null;

    const category = classify(hostname, pathname, {
      searchHosts: listField(cfg.searchHosts),
      llmHosts: llmHosts(),
    });
    const current = switches();
    if (decideProxy(category, current)) {
      // 按归类给「等响应」的上限：LLM/生图可能分钟级才有响应头，搜索/网页仍用短超时
      return { ...proxy, responseTimeout: category === "llm" ? llmResponseTimeout() : proxy.timeout };
    }

    // 归类为"网页"且网页开关没开：提示一次，避免用户误以为代理失效
    if (category === "web" && !current.proxyWeb && !reportedUnknown.has(hostname) && reportedUnknown.size < 20) {
      reportedUnknown.add(hostname);
      info(`[auto-proxy] ${hostname} 属于网页类请求，网页开关未开，已直连`);
    }
    return null;
  }

  /**
   * 挂上 fetch 包装器（幂等，只在第一次真正安装）。启动时就装，之后再不随
   * 系统代理开关装拆——路由是「按请求决策」的，装拆没有任何收益。
   *
   * 为什么不再拆：反复改写 `globalThis.fetch` 会让同样改 fetch 的插件（例如 DSH 的
   * `experimental-inspector`，它靠「快照 / 栈顶还原」管理自己的包装层）错位：还原时
   * 发现栈顶不是自己就放弃，旧层留在链上，宿主下次再装又叠一层。本次 DSH 崩溃的栈
   * 全部在 inspector 内部（不是本插件），但少改一次全局 fetch，就少一次把别人链路
   * 搞乱的机会——包装器越少换手，越稳。
   */
  function installWrapper() {
    if (disposed || wrapper) return;
    const baseFetch = globalThis.fetch;
    // 上一个实例没拆干净：跳过自家遗留层，别自我叠加
    originalFetch = baseFetch && baseFetch[WRAPPER_FLAG] ? unwrapOwnLayers(baseFetch) : baseFetch;
    wrapper = (input, init) => {
      const chosen = routeFor(input);
      // warn 传给底层：请求体转发不了时它要提示一次「已退回直连」
      return chosen ? proxiedFetch(input, init, chosen, originalFetch, null, warn) : originalFetch(input, init);
    };
    wrapper[WRAPPER_FLAG] = true;
    wrapper[WRAPPER_SOURCE] = originalFetch;
    globalThis.fetch = wrapper;
    info("[auto-proxy] 已挂上 fetch 包装器：按请求决策，开关改动即时生效（不再随系统代理装拆）");
    if (switches().proxyLLM && llmHosts().length === 0) {
      warn("[auto-proxy] LLM 开关已打开，但没识别到模型网关域名；请在 llmHosts 里手填（例如 api.example.com）");
    }
  }

  /** 系统代理 / 开关状态变化时，只输出一行状态（包装器早已装好）。 */
  function sync() {
    if (disposed) return;
    installWrapper();
    const proxy = activeProxy();
    const state = switches();
    const summary =
      `搜索 ${state.proxySearch ? "走代理" : "直连"} / LLM ${state.proxyLLM ? "走代理" : "直连"}` +
      ` / 网页 ${state.proxyWeb ? "走代理" : "直连"}`;
    if (proxy) info(`[auto-proxy] 跟随系统代理：${proxy.protocol}://${proxy.host}:${proxy.port}（${summary}）`);
    else info(`[auto-proxy] 系统代理不可用：后续请求直连（${summary}）`);
  }

  async function refresh() {
    if (disposed) return;
    try {
      const next = await readSystemProxy();
      const changed = JSON.stringify(next) !== JSON.stringify(systemProxy);
      systemProxy = next;
      if (changed) sync();
    } catch (error) {
      warn(`[auto-proxy] 读取系统代理失败：${(error && error.message) || error}`);
    }
  }

  // ── 设置页数据快照 ───────────────────────────────────────────────────────
  function snapshotConfig(patch) {
    // 必须读 volatile 引用的真实值：之前用 !!cfg.proxyLLM 让这个接口永远返回三个 true
    const base = switches();
    return patch ? { ...base, ...patch } : base;
  }

  function systemInfo() {
    const sys = systemProxy;
    if (!sys) return { state: "unknown" };
    if (sys.supported === false) return { state: "unavailable" };
    if (sys.mode === "pac") return { state: "pac", url: sys.pacUrl || "" };
    if (!sys.enabled) return { state: "off" };
    return { state: "ok", proxy: `${sys.protocol || "http"}://${sys.host}:${sys.port}` };
  }

  // ── services ─────────────────────────────────────────────────────────────
  try {
    if (ctx && typeof ctx.inject === "function") {
      ctx.inject(["settings"], (sctx) => {
        settingsCtx = sctx;
        try {
          const descriptors = sctx.settings.describe({ redactSecrets: true });
          const found = providerHostsFrom(descriptors);
          discoveredLlmHosts = found;
          if (found.length) {
            info(`[auto-proxy] 已从配置识别模型网关：${found.join(", ")}`);
          } else {
            // 发现不到不代表归类一定错（图像端点还有路径兜底），但值得留一行线索
            info(
              `[auto-proxy] 未从 ${Array.isArray(descriptors) ? descriptors.length : 0} 项设置里识别到模型网关 baseURL；` +
                `LLM 类请求可用 llmHosts 手填（例如 api.example.com）`
            );
          }
        } catch (error) {
          warn(`[auto-proxy] 读取 provider 配置失败，LLM 归类可能不准：${(error && error.message) || error}`);
        }
      });
    }
  } catch (error) {
    warn(`[auto-proxy] 无法挂载 settings 服务：${(error && error.message) || error}`);
  }

  try {
    if (ctx && typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (webCtx) => {
        webCtx.effect(() => {
          const dispose = webCtx.webServer.register({
            kind: "exact",
            path: "/_dsh/auto-proxy",
            handler: (req, res) => {
              const send = (status, body) => {
                res.statusCode = status;
                res.setHeader("content-type", "application/json; charset=utf-8");
                res.setHeader("cache-control", "no-store");
                // 浏览器模式（dsh web）下页面与路由同源；带上 CORS 头可兼容被 iframe 包裹的场景
                res.setHeader("access-control-allow-origin", "*");
                res.setHeader("access-control-allow-headers", "content-type,accept");
                res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
                res.end(JSON.stringify(body));
              };
              if (req.method === "OPTIONS") return send(204, {});
              if (!isLocalRequest(req)) return send(403, { error: "forbidden" });

              if (req.method === "GET") {
                return send(200, {
                  config: snapshotConfig(),
                  system: systemInfo(),
                  active: Boolean(activeProxy()),
                  llmHosts: llmHosts(),
                });
              }
              if (req.method !== "POST") return send(405, { error: "method not allowed" });

              let raw = "";
              req.on("data", (chunk) => {
                raw += chunk;
                if (raw.length > 8192) req.destroy();
              });
              req.on("end", () => {
                let body;
                try {
                  body = JSON.parse(raw || "{}");
                } catch {
                  return send(400, { error: "invalid json" });
                }
                const patch = {};
                const ops = [];
                for (const key of SWITCH_KEYS) {
                  if (typeof body[key] === "boolean") {
                    patch[key] = body[key];
                    ops.push({ op: "set", path: [key], value: body[key] });
                  }
                }
                if (ops.length === 0) return send(400, { error: "no known field" });
                if (!settingsCtx || typeof settingsCtx.settings.mutate !== "function") {
                  return send(503, { error: "settings service unavailable" });
                }
                Promise.resolve(settingsCtx.settings.mutate(name, ops)).then(
                  () => {
                    sync(); // volatile 值已就地更新，这里只是把新状态写一行日志
                    send(200, { config: snapshotConfig(patch), system: systemInfo() });
                  },
                  (error) => send(500, { error: String((error && error.message) || error) })
                );
              });
            },
          });
          return () => {
            try {
              if (typeof dispose === "function") dispose();
            } catch {
              /* 卸载时忽略 */
            }
          };
        }, "auto-proxy: settings route");
      });
    }
  } catch (error) {
    warn(`[auto-proxy] 无法注册设置路由：${(error && error.message) || error}`);
  }

  // 启动即安装包装器：路由按请求读开关，所以启停不需要再动 globalThis.fetch
  sync();
  void refresh();
  timer = setInterval(() => void refresh(), Math.max(1000, numberField(cfg.pollIntervalMs, 3000) || 3000));
  if (typeof timer.unref === "function") timer.unref();

  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearInterval(timer);
    if (wrapper && globalThis.fetch === wrapper) globalThis.fetch = originalFetch;
    wrapper = null;
  };

  if (ctx && typeof ctx.effect === "function") ctx.effect(() => disposeAll);
  else process.once("exit", disposeAll);
}
