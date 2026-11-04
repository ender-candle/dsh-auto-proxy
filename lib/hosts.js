// 主机匹配：把 URL / Request / 字符串归一成 hostname，并按"精确 或 后缀"匹配规则列表。
// 规则写法：`example.com` 命中 example.com 及其所有子域；`.example.com` 同上；`*` 命中所有。

/** 从 fetch 的第一个参数里取出 hostname；取不到返回空串。 */
export function hostnameOf(input) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(String(input)).hostname.toLowerCase();
    if (input && typeof input === "object") {
      if (typeof input.url === "string") return new URL(input.url).hostname.toLowerCase();
      if (input.href) return new URL(String(input.href)).hostname.toLowerCase();
    }
  } catch {
    /* 非法 URL：当作没有主机名 */
  }
  return "";
}

/** hostname 是否命中 patterns 里的任意一条。 */
export function matchesHost(hostname, patterns) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    let rule = String(raw || "").trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    if (rule.startsWith("*.")) rule = rule.slice(1); // *.example.com -> .example.com
    if (rule.startsWith(".")) {
      const bare = rule.slice(1);
      if (host === bare || host.endsWith(rule)) return true;
    } else if (host === rule || host.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

/** 把 fetch 的第一个参数拆成 { hostname, pathname }；解析失败时两者都为空串。 */
export function parseTarget(input) {
  try {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : input && typeof input === "object"
            ? new URL(String(input.url || input.href || ""))
            : null;
    if (!url) return { hostname: "", pathname: "" };
    return { hostname: url.hostname.toLowerCase(), pathname: url.pathname || "" };
  } catch {
    return { hostname: "", pathname: "" };
  }
}
