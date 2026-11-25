// lib/provider-hosts.js — 从 DSH 设置快照里挖出模型网关主机名（LLM 自动发现）
//
// 为什么要单独一个模块：这段逻辑出过一次真事故（dsh-image-gen 图生图全部失败）。
// 旧实现只认四个精确拼法 `baseurl|base_url|apibase|api_base`，而各插件的字段名
// 带自己的前缀——`openaiCompatBaseURL`、`imageBaseURL`、`visionApiBase`……
// 一个都没命中，于是那条请求被归成「网页」类，走进了它不该走的转发路径。
// 现在改成按后缀宽松匹配，并把这段逻辑单独export，便于单测兜住。
import { hostnameOf } from "./hosts.js";

/**
 * provider 配置里表示「网关地址」的键名：*baseURL / *base_url / *apiBase / *api_base（不区分大小写）。
 * 前缀随意（`openaiCompatBaseURL` 也算），只要以这四种结尾。
 */
const BASE_URL_KEY = /base[._-]?url$|api[._-]?base$/i;

/** 这个键名像不像「网关地址」。 */
export function isBaseUrlKey(key) {
  return BASE_URL_KEY.test(String(key || ""));
}

/**
 * 从 settings.describe() 返回的描述符数组里，掘出所有 provider 的 baseURL 主机名。
 * 尽力而为：结构不认识就跳过，绝不抛错（发现失败只影响归类精度，不该影响插件启动）。
 *
 * @param {Array<{value?: unknown}>} descriptors
 * @returns {string[]} 去重后的 hostname 列表
 */
export function providerHostsFrom(descriptors) {
  const hosts = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === "string" && isBaseUrlKey(key)) {
        const host = hostnameOf(val);
        if (host) hosts.add(host);
      } else {
        visit(val, depth + 1);
      }
    }
  };
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) visit(descriptor && descriptor.value, 0);
  return [...hosts];
}
