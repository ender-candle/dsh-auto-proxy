// 端到端隧道自检：本地起一个最小 CONNECT 代理，验证 lib/proxy 的转发链路真的能用。
// 需要联网；用法：node test/tunnel.e2e.mjs [proxyHost proxyPort]
import net from "node:net";
import http from "node:http";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const PORT = 18080;
const server = http.createServer((req, res) => res.writeHead(400).end("CONNECT only"));
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = String(req.url).split(":");
  const upstream = net.connect(Number(port) || 443, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (e) => clientSocket.destroy(e));
  clientSocket.on("error", () => upstream.destroy());
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const proxy = { protocol: "http", host: "127.0.0.1", port: PORT, noProxy: ["127.0.0.1"], timeout: 15000 };
try {
  const res = await proxiedFetch("https://myip.ipip.net/", {}, proxy, globalThis.fetch);
  console.log("tunnel OK ->", (await res.text()).trim().replace(/\s+/g, " "));
} catch (error) {
  console.error("tunnel FAILED ->", error.message);
  process.exitCode = 1;
} finally {
  server.close();
}
