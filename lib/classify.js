// 请求归类：把一次 fetch 归到「搜索」「LLM」「网页」三类，由三个开关分别决定要不要走代理。
//
// 判定顺序：
//   1. 路径像 DeepSeek 的 Search/Fetch 工具端点（/tools/search、/tools/fetch）→ 搜索
//   2. 主机命中搜索域名（内置列表 + 用户追加）→ 搜索
//   3. 主机命中模型网关域名（用户追加 + 从 DSH 配置里自动发现的 baseURL）→ LLM
//   4. 其余 → 其他（默认直连，不做投机代理）
import { matchesHost } from "./hosts.js";

/** 内置的搜索/抓取域名。自建 SearXNG、企业内网搜索请用 searchHosts 追加。 */
export const SEARCH_HOSTS = [
  "bing.com",
  "google.com",
  "duckduckgo.com",
  "search.brave.com",
  "startpage.com",
  "ecosia.org",
  "mojeek.com",
  "yandex.com",
  "baidu.com",
  "sogou.com",
  "so.com",
  "exa.ai",
  "tavily.com",
  "keenable.ai",
  "firecrawl.dev",
  "parallel.ai",
  "perplexity.ai",
  "serper.dev",
  "serpapi.com",
  "serply.io",
  "you.com",
  "jina.ai",
  "zhihu.com",
  "toutiao.com",
];

/** DeepSeek 官方的搜索/抓取端点路径（同一主机上也有对话端点，所以必须看路径）。 */
const SEARCH_PATH = /\/tools\/(search|fetch)\b/i;

/** 路径是否像搜索/抓取端点。 */
export function isSearchPath(pathname) {
  return SEARCH_PATH.test(String(pathname || ""));
}

/**
 * @returns {"search"|"llm"|"web"}
 */
export function classify(hostname, pathname, { searchHosts = [], llmHosts = [] } = {}) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return "web";
  if (isSearchPath(pathname)) return "search";
  if (matchesHost(host, searchHosts) || matchesHost(host, SEARCH_HOSTS)) return "search";
  if (matchesHost(host, llmHosts)) return "llm";
  return "web";
}

/**
 * 三个开关 → 这一次请求要不要走代理。
 * 搜索/LLM/网页各自独立，互不影响。
 * @param {"search"|"llm"|"web"} category
 */
export function decideProxy(category, { proxySearch = false, proxyLLM = false, proxyWeb = false } = {}) {
  if (category === "search") return Boolean(proxySearch);
  if (category === "llm") return Boolean(proxyLLM);
  return Boolean(proxyWeb);
}
