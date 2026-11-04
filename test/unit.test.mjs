import test from "node:test";
import assert from "node:assert/strict";
import { parseRegValues, parseProxyServer, parseBypassList } from "../lib/system-proxy.js";
import { hostnameOf, matchesHost, parseTarget } from "../lib/hosts.js";
import { classify, isSearchPath, decideProxy } from "../lib/classify.js";

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
