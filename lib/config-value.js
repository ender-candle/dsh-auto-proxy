// lib/config-value.js — 读取 DSH 配置字段的真实值
//
// 事故记录（0.2.4 修复）：三个开关都声明了 `.volatile()`，而 schemastery 会把 volatile
// 字段在 `apply(ctx, config)` 里换成 cosmokit 的引用对象 `{ get(): T }`，不是原始值。
// 于是 `!!cfg.proxyLLM` 恒为 true（对象恒真）：
//   · 三个开关在路由里全部"生效"→ 只要系统代理开着，什么请求都走代理；
//   · `/_dsh/auto-proxy` 永远显示三个开关都是 true，用户从没开过 LLM 也显示开着；
//   · 界面上点开关只改了引用的值，宿主从来没读过 `.get()`，等于点了没反应。
// 非 volatile 字段仍是原始值，两种都要能读。

/**
 * 读一个配置字段：volatile 引用取 `.get()`，普通值原样返回；缺省时用 fallback。
 * @param {unknown} ref 配置字段（可能是 `{ get(): T }` 引用）
 * @param {unknown} fallback 字段缺失 / 引用值为 undefined 时的默认值
 */
export function readConfigField(ref, fallback) {
  if (ref == null) return fallback;
  if (typeof ref === "object" && typeof ref.get === "function") {
    const value = ref.get();
    return value === undefined ? fallback : value;
  }
  return ref;
}

/**
 * 三个开关的当前值。volatile 值会随用户实时改写，所以必须每次现读，不能缓存。
 * @returns {{proxySearch: boolean, proxyLLM: boolean, proxyWeb: boolean}}
 */
export function readSwitches(config) {
  return {
    proxySearch: Boolean(readConfigField(config && config.proxySearch, false)),
    proxyLLM: Boolean(readConfigField(config && config.proxyLLM, false)),
    proxyWeb: Boolean(readConfigField(config && config.proxyWeb, false)),
  };
}
