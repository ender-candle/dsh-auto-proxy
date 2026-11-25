// test/bodies.e2e.mjs — 本地闭环，不联网：本地最小 forward proxy + 本地 origin，
// 验证 proxiedFetch 真的能把 FormData / JSON / 字符串请求体完整送过去。
//
// 为什么必须有这一层：单测证明得了「编码对了」，证明不了「代理链路拼出来的报文对了」
// （boundary、Content-Length、字段顺序任何一处错，服务端看到的都是坏请求）。
// 图生图那次事故（FormData 直接报 EBODY）就属于链路层。
import http from "node:http";
import { once } from "node:events";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** 本地 origin：回显 method / content-type / 关键字段，绝不落盘。 */
const origin = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const text = body.toString("latin1");
    const contentType = String(req.headers["content-type"] || "");
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1] || "";
    const reply = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          contentType,
          length: body.length,
          declaredLength: Number(req.headers["content-length"] || -1),
          fields: {
            model: /name="model"/i.test(text),
            prompt: /name="prompt"/i.test(text),
            image: /name="image"/i.test(text),
            filename: /filename="a\.png"/i.test(text),
            imageType: /image\/png/i.test(text),
            pngMagic: body.includes(PNG_MAGIC),
          },
          boundary,
          boundaryInBody: boundary ? text.includes(`--${boundary}`) : false,
          bodyStart: text.slice(0, 24),
          text: text.length < 400 ? text : "",
          json: contentType.startsWith("application/json") ? text : "",
        })
      );
    };
    // 慢端点：模拟生图这类「服务端算很久才回第一个字节」的请求
    if (req.url.startsWith("/slow")) setTimeout(reply, 300);
    else reply();
  });
});

/** 最小 forward proxy：本插件对 http 目标发的是绝对 URL 形式，直接转发即可。 */
const proxy = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end("absolute URL required");
    return;
  }
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream failed: ${error.message}`);
  });
  req.pipe(upstream);
});

origin.listen(0, "127.0.0.1");
proxy.listen(0, "127.0.0.1");
await Promise.all([once(origin, "listening"), once(proxy, "listening")]);

const originPort = origin.address().port;
const proxyPort = proxy.address().port;
const proxyConfig = { protocol: "http", host: "127.0.0.1", port: proxyPort, noProxy: [], timeout: 15000 };
const editsUrl = `http://127.0.0.1:${originPort}/v1/images/edits`;

let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

try {
  // 1) FormData —— 图生图走的正是这条路
  const form = new FormData();
  form.append("model", "gpt-image-2.6-sunburst");
  form.append("prompt", "a sailboat");
  form.append("image", new Blob([PNG_MAGIC], { type: "image/png" }), "a.png");
  const formEcho = await (await proxiedFetch(editsUrl, { method: "POST", body: form }, proxyConfig, globalThis.fetch)).json();

  console.log("FormData 经代理：");
  check("content-type 是 multipart 且带 boundary", /^multipart\/form-data; boundary=/.test(formEcho.contentType), formEcho.contentType);
  check("boundary 出现在请求体里", formEcho.boundaryInBody, formEcho.boundary);
  check("Content-Length 与实收字节一致", formEcho.length === formEcho.declaredLength, [formEcho.length, formEcho.declaredLength]);
  for (const [field, ok] of Object.entries(formEcho.fields)) check(`字段 ${field} 完整`, ok);

  // 2) JSON 字符串 —— 文生图走的这条路（回归：别为了修 FormData 弄坏它）
  const payload = JSON.stringify({ model: "gpt-image-2.6-sunburst", prompt: "a sailboat" });
  const jsonEcho = await (
    await proxiedFetch(editsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: payload }, proxyConfig, globalThis.fetch)
  ).json();
  console.log("JSON 经代理：");
  check("content-type 保持 json", jsonEcho.contentType.startsWith("application/json"), jsonEcho.contentType);
  check("body 原样送达", jsonEcho.json === payload);
  check("Content-Length 与实收字节一致", jsonEcho.length === jsonEcho.declaredLength);

  // 3) 纯字符串 + 调用方没写 content-type：按 fetch 语义补 text/plain
  const textEcho = await (
    await proxiedFetch(`http://127.0.0.1:${originPort}/plain`, { method: "POST", body: "hello" }, proxyConfig, globalThis.fetch)
  ).json();
  console.log("字符串经代理：");
  check("自动补 text/plain;charset=UTF-8", textEcho.contentType === "text/plain;charset=UTF-8", textEcho.contentType);
  check("body 原样送达", textEcho.text === "hello", textEcho.text);

  // 4) URLSearchParams：表单编码 + 自动 content-type
  const paramsEcho = await (
    await proxiedFetch(`http://127.0.0.1:${originPort}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials" }) }, proxyConfig, globalThis.fetch)
  ).json();
  console.log("URLSearchParams 经代理：");
  check("自动补 form-urlencoded", paramsEcho.contentType === "application/x-www-form-urlencoded;charset=UTF-8", paramsEcho.contentType);
  check("body 是编码后的表单", paramsEcho.text === "grant_type=client_credentials", paramsEcho.text);

  // 5) 慢响应：responseTimeout 决定「等响应」的上限（连接超时不该拿来量生图）
  const slowUrl = `http://127.0.0.1:${originPort}/slow`;
  console.log("慢响应（300ms 才回）：");
  const relaxed = await proxiedFetch(slowUrl, {}, { ...proxyConfig, responseTimeout: 5000 }, globalThis.fetch);
  check("上限放宽后正常返回", relaxed.status === 200, relaxed.status);
  const unlimited = await proxiedFetch(slowUrl, {}, { ...proxyConfig, responseTimeout: 0 }, globalThis.fetch);
  check("responseTimeout=0 表示不限", unlimited.status === 200, unlimited.status);
  const tight = await proxiedFetch(slowUrl, {}, { ...proxyConfig, responseTimeout: 100 }, globalThis.fetch).then(
    () => "resolved",
    (error) => error.code || error.message
  );
  check("上限收紧后按 responseTimeout 超时", tight === "ETIMEOUT", tight);
} catch (error) {
  failed += 1;
  console.error("请求抛错 ->", error);
} finally {
  origin.close();
  proxy.close();
}

if (failed) {
  console.error(`\n${failed} 项不通过`);
  process.exitCode = 1;
} else {
  console.log("\n全部通过：FormData / JSON / 字符串 / 表单经代理链路完整可用");
}
