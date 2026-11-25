import test from "node:test";
import assert from "node:assert/strict";
import { parseRegValues, parseProxyServer, parseBypassList } from "../lib/system-proxy.js";
import { hostnameOf, matchesHost, parseTarget } from "../lib/hosts.js";
import { classify, isSearchPath, isModelPath, decideProxy } from "../lib/classify.js";
import { providerHostsFrom, isBaseUrlKey } from "../lib/provider-hosts.js";
import { readConfigField, readSwitches } from "../lib/config-value.js";
import { normalizeBody, proxiedFetch } from "../lib/proxy/request.js";

const SAMPLE = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:10090
    ProxyOverride    REG_SZ    <local>;*.internal;10.*
    AutoConfigURL    REG_SZ
`;

test("parseRegValues 解析 reg query 输出", () => {
  const v = parseRegValues(SAMPLE);
  assert.equal(v.proxyenable, "0x1");
  assert.equal(v.proxyserver, "127.0.0.1:10090");
  assert.equal(v.proxyoverride, "<local>;*.internal;10.*");
});

test("parseProxyServer 支持单地址与按协议写法", () => {
  assert.deepEqual(parseProxyServer("127.0.0.1:10090"), { protocol: "http", host: "127.0.0.1", port: 10090 });
  assert.deepEqual(parseProxyServer("http=127.0.0.1:8080;socks=1080"), { protocol: "http", host: "127.0.0.1", port: 8080 });
  assert.deepEqual(parseProxyServer("[::1]:7890"), { protocol: "http", host: "::1", port: 7890 });
  assert.equal(parseProxyServer(""), null);
  assert.equal(parseProxyServer(null), null);
});

test("parseBypassList 归一化绕过列表", () => {
  assert.deepEqual(parseBypassList("<local>;*.internal;10.*"), ["<local>", ".internal", "10.*"]);
  assert.deepEqual(parseBypassList(""), []);
});

test("系统代理关闭时 enabled=false（这是本插件与手填兜底的分歧点）", async () => {
  // 模拟 ProxyEnable=0 但 ProxyServer 仍保留旧地址：梯子关掉后注册表的真实样子
  const { readSystemProxy } = await import("../lib/system-proxy.js");
  const sys = await readSystemProxy({
    platform: "win32",
    execFn: async () => `
    HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
        ProxyEnable    REG_DWORD    0x0
        ProxyServer    REG_SZ    127.0.0.1:10090
    `,
  });
  assert.equal(sys.enabled, false);
  assert.equal(sys.mode, "none");
});

test("hostnameOf 支持字符串/URL/Request 三种入参", () => {
  assert.equal(hostnameOf("https://api.fanfanhenkuai.com/v1/chat"), "api.fanfanhenkuai.com");
  assert.equal(hostnameOf(new URL("https://cn.bing.com/search?q=x")), "cn.bing.com");
  assert.equal(hostnameOf({ url: "https://www.google.com/generate_204" }), "www.google.com");
  assert.equal(hostnameOf("not a url"), "");
});

test("matchesHost 精确与后缀语义", () => {
  assert.equal(matchesHost("api.example.com", ["example.com"]), true);
  assert.equal(matchesHost("example.com", [".example.com"]), true);
  assert.equal(matchesHost("badexample.com", ["example.com"]), false);
  assert.equal(matchesHost("anything.io", ["*"]), true);
  assert.equal(matchesHost("", ["example.com"]), false);
});

test("parseTarget 拆出 hostname 与 pathname", () => {
  assert.deepEqual(parseTarget("https://cn.bing.com/search?q=x"), { hostname: "cn.bing.com", pathname: "/search" });
  assert.deepEqual(parseTarget({ url: "https://api.x.com/v1/tools/fetch" }), { hostname: "api.x.com", pathname: "/v1/tools/fetch" });
  assert.deepEqual(parseTarget("garbage"), { hostname: "", pathname: "" });
});

test("classify：搜索域名 / 搜索端点路径 / LLM 网关 / 其他", () => {
  const llmHosts = ["api.fanfanhenkuai.com"];

  // 常见搜索域名
  assert.equal(classify("cn.bing.com", "/search", { llmHosts }), "search");
  assert.equal(classify("api.exa.ai", "/search", { llmHosts }), "search");

  // 同一主机上按路径区分：DeepSeek 的 tools/search 是搜索，chat/completions 是 LLM
  assert.equal(classify("api.deepseek.com", "/v1/tools/search", { llmHosts: ["api.deepseek.com"] }), "search");
  assert.equal(classify("api.deepseek.com", "/v1/tools/fetch", { llmHosts: ["api.deepseek.com"] }), "search");
  assert.equal(classify("api.deepseek.com", "/v1/chat/completions", { llmHosts: ["api.deepseek.com"] }), "llm");

  // 模型网关
  assert.equal(classify("api.fanfanhenkuai.com", "/v1/chat/completions", { llmHosts }), "llm");

  // 其余：既不是搜索服务也不是模型网关
  assert.equal(classify("registry.npmjs.org", "/pkg", { llmHosts }), "web");
  assert.equal(classify("", "/", {}), "web");

  // 用户追加的搜索域名（自建 SearXNG 之类）
  assert.equal(classify("search.mycorp.internal", "/search", { searchHosts: ["mycorp.internal"] }), "search");
});

test("isSearchPath 只认 Search/Fetch 工具端点", () => {
  assert.equal(isSearchPath("/v1/tools/search"), true);
  assert.equal(isSearchPath("/v1/tools/fetch"), true);
  assert.equal(isSearchPath("/v1/chat/completions"), false);
});

test("classify：图像端点归 LLM，不依赖网关主机是否被发现", () => {
  // 回归：图生图（multipart 发 /v1/images/edits）曾被归成「网页」类
  assert.equal(isModelPath("/v1/images/edits"), true);
  assert.equal(isModelPath("/v1/images/generations"), true);
  assert.equal(isModelPath("/v1/images/variations"), true);
  assert.equal(isModelPath("/v1/chat/completions"), false);

  // 主机没被发现时，路径兜底仍然把它归到 LLM
  assert.equal(classify("relay.unknown.example", "/v1/images/edits", {}), "llm");
  assert.equal(classify("relay.unknown.example", "/v1/images/generations", { llmHosts: [] }), "llm");
  // 同主机的对话端点该归「网页」（没人知道它是网关），保持旧行为
  assert.equal(classify("relay.unknown.example", "/v1/chat/completions", {}), "web");
  // 发现到主机之后，整台网关都是 LLM
  assert.equal(classify("relay.unknown.example", "/v1/chat/completions", { llmHosts: ["relay.unknown.example"] }), "llm");
});

test("readSwitches：volatile 开关必须读 .get()，否则对象恒真", () => {
  // 回归：三个开关都声明了 .volatile()，schemastery 会把它们换成 { get() } 引用。
  // 之前直接 !!cfg.proxyLLM，于是永远为 true —— 开关全失效、接口永远显示开着。
  const volatile = (value) => ({ get: () => value });
  const allOff = { proxySearch: volatile(false), proxyLLM: volatile(false), proxyWeb: volatile(false) };
  assert.equal(Boolean(allOff.proxyLLM), true, "直接取引用恒为真（这正是原来的 bug）");
  assert.deepEqual(readSwitches(allOff), { proxySearch: false, proxyLLM: false, proxyWeb: false });

  assert.deepEqual(readSwitches({ proxySearch: volatile(true), proxyLLM: volatile(false), proxyWeb: volatile(true) }), {
    proxySearch: true,
    proxyLLM: false,
    proxyWeb: true,
  });

  // 非 volatile 字段仍是原始值
  assert.deepEqual(readSwitches({ proxySearch: true, proxyLLM: false, proxyWeb: true }), {
    proxySearch: true,
    proxyLLM: false,
    proxyWeb: true,
  });
  // 缺字段 / 引用值为 undefined → false
  assert.deepEqual(readSwitches({}), { proxySearch: false, proxyLLM: false, proxyWeb: false });
  assert.deepEqual(readSwitches({ proxyLLM: volatile(undefined) }), { proxySearch: false, proxyLLM: false, proxyWeb: false });

  // readConfigField：普通值、引用、缺省
  assert.equal(readConfigField(60000, 1), 60000);
  assert.equal(readConfigField(volatile(3000), 1), 3000);
  assert.equal(readConfigField(volatile(undefined), 1), 1);
  assert.equal(readConfigField(undefined, 1), 1);
});

test("decideProxy：开关真实值关闭时不该走代理", () => {
  const volatile = (value) => ({ get: () => value });
  const cfg = { proxySearch: volatile(true), proxyLLM: volatile(false), proxyWeb: volatile(false) };
  const switches = readSwitches(cfg);
  assert.equal(decideProxy("search", switches), true);
  assert.equal(decideProxy("llm", switches), false, "LLM 开关没开，生图请求不该被代理");
  assert.equal(decideProxy("web", switches), false);
});

test("providerHostsFrom：带插件前缀的 baseURL 键名也要认得", () => {
  assert.equal(isBaseUrlKey("openaiCompatBaseURL"), true); // dsh-image-gen 的写法（漏认过一次）
  assert.equal(isBaseUrlKey("baseURL"), true);
  assert.equal(isBaseUrlKey("base_url"), true);
  assert.equal(isBaseUrlKey("apiBase"), true);
  assert.equal(isBaseUrlKey("api_base"), true);
  assert.equal(isBaseUrlKey("downloadUrl"), false);
  assert.equal(isBaseUrlKey("baseURLs"), false);

  const descriptors = [
    { id: "image-gen", value: { openaiCompatBaseURL: "https://api.fanfanhenkuai.com/v1", openaiCompatModel: "gpt-image-2.6-sunburst" } },
    { id: "llm-pi-ai", value: { providers: { fanfan: { baseURL: "https://api.fanfanhenkuai.com/v1" }, other: { api_base: "https://relay.example.com/v1" } } } },
    { id: "noise", value: { downloadUrl: "https://cdn.example.com/x", baseURLs: "https://not-a-base.example.com" } },
    { id: "junk", value: null },
  ];
  assert.deepEqual(providerHostsFrom(descriptors).sort(), ["api.fanfanhenkuai.com", "relay.example.com"]);
  assert.deepEqual(providerHostsFrom([]), []);
  assert.deepEqual(providerHostsFrom(undefined), []);
});

test("normalizeBody：FormData 编码出带 boundary 的字节与 content-type", async () => {
  const form = new FormData();
  form.append("model", "gpt-image-2.6-sunburst");
  form.append("prompt", "a sailboat");
  form.append("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "a.png");

  const { body, contentType } = await normalizeBody(form);
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const boundary = contentType.split("boundary=")[1];
  const text = body.toString("latin1");
  assert.ok(text.startsWith(`--${boundary}`), "请求体应以同一个 boundary 开头");
  assert.ok(text.endsWith(`--${boundary}--\r\n`), "请求体应以终止 boundary 收尾");
  assert.match(text, /name="model"/i);
  assert.match(text, /gpt-image-2\.6-sunburst/);
  assert.match(text, /filename="a\.png"/i);
  assert.match(text, /image\/png/i);
});

test("normalizeBody：其它类型按 fetch 语义补 content-type，未知类型报 EBODY", async () => {
  assert.deepEqual(await normalizeBody("hi"), { body: "hi", contentType: "text/plain;charset=UTF-8" });
  assert.deepEqual(await normalizeBody(new URLSearchParams({ a: "1" })), {
    body: "a=1",
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
  });
  assert.equal((await normalizeBody(Buffer.from("x"))).contentType, null);
  assert.equal((await normalizeBody(null)).body, null);
  await assert.rejects(() => normalizeBody({ not: "a body" }), (e) => e.code === "EBODY");
  await assert.rejects(() => normalizeBody(new ReadableStream()), (e) => e.code === "EBODY");
});

test("proxiedFetch：转发不了的请求体退回直连，绝不让代理打死请求", async () => {
  const calls = [];
  const stubFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("direct-ok", { status: 200 });
  };
  const proxy = { protocol: "http", host: "127.0.0.1", port: 1, noProxy: [], timeout: 1000 };
  const warnings = [];
  const warn = (message) => warnings.push(String(message));

  const stream = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  const res = await proxiedFetch("https://example.com/upload", { method: "POST", body: stream(), duplex: "half" }, proxy, stubFetch, null, warn);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "direct-ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/upload");
  assert.match(warnings[0], /退回直连/);

  // 同类请求体只提示一次，不刷日志
  await proxiedFetch("https://example.com/upload2", { method: "POST", body: stream(), duplex: "half" }, proxy, stubFetch, null, warn);
  assert.equal(warnings.length, 1);
  assert.equal(calls.length, 2);
});

test("decideProxy：三个开关互不影响", () => {
  // 只开搜索：搜索走代理，LLM 与其他直连
  assert.equal(decideProxy("search", { proxySearch: true }), true);
  assert.equal(decideProxy("llm", { proxySearch: true }), false);
  assert.equal(decideProxy("web", { proxySearch: true }), false);

  // 只开「网页」：读网页走代理 —— 这就是它与"搜索开关"的区别（搜索管找，网页管读）
  assert.equal(decideProxy("web", { proxyWeb: true }), true);
  assert.equal(decideProxy("search", { proxyWeb: true }), false);
  assert.equal(decideProxy("llm", { proxyWeb: true }), false);

  // 三个全关 = 全部直连
  for (const category of ["search", "llm", "web"]) {
    assert.equal(decideProxy(category, {}), false);
  }
});
