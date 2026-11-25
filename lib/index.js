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

export const name = "auto-proxy";
export const inject = [];

const SWITCH_KEYS = ["proxySearch", "proxyLLM", "proxyWeb"];

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
      .description("单次经代理请求的超时（毫秒）。"),
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

  const llmHosts = () => [...new Set([...(Array.isArray(cfg.llmHosts) ? cfg.llmHosts : []), ...discoveredLlmHosts])];
  const anySwitchOn = () => Boolean(cfg.proxyLLM || cfg.proxySearch || cfg.proxyWeb);

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
      noProxy: [...new Set([...(Array.isArray(cfg.noProxy) ? cfg.noProxy : []), ...bypass])],
      timeout: Number(cfg.timeout) || 60000,
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
      searchHosts: Array.isArray(cfg.searchHosts) ? cfg.searchHosts : [],
      llmHosts: llmHosts(),
    });
    if (decideProxy(category, cfg)) return proxy;

    // 归类为"网页"且网页开关没开：提示一次，避免用户误以为代理失效
    if (category === "web" && !cfg.proxyWeb && !reportedUnknown.has(hostname) && reportedUnknown.size < 20) {
      reportedUnknown.add(hostname);
      info(`[auto-proxy] ${hostname} 属于网页类请求，网页开关未开，已直连`);
    }
    return null;
  }

  /** 系统代理可用性变化时，装 / 拆 fetch 包装器。 */
  function sync() {
    if (disposed) return;
    const proxy = activeProxy();
    if (proxy) {
      if (!wrapper) {
        originalFetch = globalThis.fetch;
        wrapper = (input, init) => {
          const chosen = routeFor(input);
          // warn 传给底层：请求体转发不了时它要提示一次「已退回直连」
          return chosen ? proxiedFetch(input, init, chosen, originalFetch, null, warn) : originalFetch(input, init);
        };
        globalThis.fetch = wrapper;
        info(
          `[auto-proxy] 跟随系统代理：${proxy.protocol}://${proxy.host}:${proxy.port}` +
            `（搜索 ${cfg.proxySearch ? "走代理" : "直连"} / LLM ${cfg.proxyLLM ? "走代理" : "直连"}` +
            ` / 网页 ${cfg.proxyWeb ? "走代理" : "直连"}）`
        );
        if (cfg.proxyLLM && llmHosts().length === 0) {
          warn("[auto-proxy] LLM 开关已打开，但没识别到模型网关域名；请在 llmHosts 里手填（例如 api.example.com）");
        }
      }
      return;
    }
    if (!wrapper) return;
    if (globalThis.fetch === wrapper) {
      globalThis.fetch = originalFetch;
      info("[auto-proxy] 系统代理不可用或三个开关都关了，已恢复直连。");
    } else {
      warn("[auto-proxy] 全局 fetch 已被其他插件包装，未强行拆除；代理可能仍在部分链路生效。");
    }
    wrapper = null;
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
    const base = { proxySearch: !!cfg.proxySearch, proxyLLM: !!cfg.proxyLLM, proxyWeb: !!cfg.proxyWeb };
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
                  () => send(200, { config: snapshotConfig(patch), system: systemInfo() }),
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

  void refresh();
  timer = setInterval(() => void refresh(), Math.max(1000, Number(cfg.pollIntervalMs) || 3000));
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
