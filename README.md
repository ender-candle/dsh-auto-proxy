# dsh-auto-proxy

**三个开关的网络代理插件**：`搜索走代理`、`LLM 走代理`、`网页走代理`，各自独立；
统一前提是——**系统代理开着才可能走代理，系统代理一关立刻全部直连**（绝不回退到手填地址）。

Three independent switches for DeepSeek Harness: proxy search traffic, LLM traffic, and general web traffic
else. All three only take effect while the system proxy is on, and all drop to a **direct
connection** the instant it is switched off.

---

## 三个开关分别管什么

| 开关 | 管什么 | 典型请求 |
|---|---|---|
| **搜索走代理** | "**找**"：搜索引擎 / 搜索服务的接口 | `web_search` 打 `cn.bing.com`、`api.exa.ai`、`api.tavily.com` |
| **LLM 走代理** | "**想**"：模型网关 | 对话请求打 `api.fanfanhenkuai.com` 之类中转域名 |
| **网页走代理** | "**读**"：打开具体网页 + 其余杂项 | 读搜索结果里的 `reuters.com/article`、插件更新检查 |

### 「搜索」和「网页」到底差在哪？

两者都跟"上网查资料"有关，但**是两条不同的链路**：

```
web_search("DeepSeek 价格")        →  打 bing.com          →  归类「搜索」
   ↓ 返回一串 URL
web_fetch("https://reuters.com/…") →  打 reuters.com       →  归类「网页」
```

- **搜索开关管"找"**：只命中内置的搜索服务域名（Bing / Google / DDG / Baidu / Exa / Tavily / Firecrawl / Parallel / Perplexity / Jina …）。它**不**管你随后去读哪个网页。
- **网页开关管"读"**：域名什么都有（新闻站、博客、GitHub、任意网址），没法枚举，所以它接住"既不是搜索服务也不是模型网关"的全部剩余流量。

只开搜索、不开网页会出现这种半吊子状态：**搜得到结果列表，但点开结果是直连，被墙就打不开**。想让"搜索结果也能读"，两个都要开。

## 行为语义

| 场景 | 结果 |
|---|---|
| 开关打开 + 系统代理开 | 该类别走系统代理（默认 3 秒轮询，端口变了自动跟随） |
| 开关打开 + 系统代理**关** / PAC / 读不到 | 该类别直连 |
| 开关关闭 | 该类别始终直连 |
| 三个开关全关 | 全部直连 |

回环地址（`127.0.0.1` / `localhost` / `::1`）与系统代理自带的绕过列表永远直连。

## 请求是怎么归类的

| 顺序 | 判定 | 归类 |
|---|---|---|
| 1 | 路径是 `/tools/search`、`/tools/fetch`（DeepSeek 的 Search/Fetch 端点） | 搜索 |
| 2 | 主机命中搜索域名（内置列表 + `searchHosts`） | 搜索 |
| 3 | 主机命中模型网关（自动发现 + `llmHosts`） | LLM |
| 4 | 其余 | 网页 |

内置搜索域名：`bing.com`、`google.com`、`duckduckgo.com`、`search.brave.com`、`startpage.com`、`ecosia.org`、`mojeek.com`、`yandex.com`、`baidu.com`、`sogou.com`、`so.com`、`exa.ai`、`tavily.com`、`keenable.ai`、`firecrawl.dev`、`parallel.ai`、`perplexity.ai`、`serper.dev`、`serpapi.com`、`serply.io`、`you.com`、`jina.ai`、`zhihu.com`、`toutiao.com`。自建 SearXNG、内网搜索请用 `searchHosts` 追加。

模型网关默认**自动发现**：插件从 DSH 设置里读出所有 provider 的 `baseURL` 主机名（比如你配的第三方中转），不用手填；发现不到时日志会提示，用 `llmHosts` 补。

## 安装

```bash
dsh plugin --profile <你的profile> add github:<你的用户名>/dsh-auto-proxy
```

或手工在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: auto-proxy
      name: 'dsh-auto-proxy'
      config:
        proxySearch: true
        proxyLLM: false
        proxyWeb: true
```

重启 DSH 后打开 **设置 → 自动代理**，就是那三个开关，点一下即时生效（不用重启）。

> 界面数据走同源路由 `/_dsh/auto-proxy`（只接受本机请求），写入走 DSH 的 settings 服务并持久化到 profile 的 `cordis.patch.yml`。
> 三个开关字段都声明了 `.volatile()`——这是 DSH 允许表单编辑字段的前提。
> 不想用界面也可以直接改上面的 `cordis.patch.yml`，两种方式等价。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `proxySearch` | `false` | 搜索类请求走代理。 |
| `proxyLLM` | `false` | LLM / 模型网关请求走代理。 |
| `proxyWeb` | `false` | 网页类请求（读网页、抓取、插件更新等）走代理。 |
| `searchHosts` | `[]` | 额外追加的"搜索"域名（后缀匹配，`example.com` 含子域）。 |
| `llmHosts` | `[]` | 额外追加的"LLM"域名；留空时自动从 provider 的 `baseURL` 发现。 |
| `noProxy` | `["127.0.0.1","localhost","::1"]` | 命中则直连；系统绕过列表自动并入。 |
| `pollIntervalMs` | `3000` | 读取系统代理的间隔（1000–60000 毫秒）。 |
| `timeout` | `60000` | 单次经代理请求的超时（毫秒）。 |

匹配规则：`example.com` 命中本体及所有子域，`.example.com` 同义，`*` 命中全部。

## 覆盖范围与限制（请先读这段）

**覆盖**：agent 进程里的 `globalThis.fetch` —— `web_search` 的各家搜索 provider、插件自己发的 HTTP 请求、LLM provider 栈（`llm-pi-ai` 用的就是 `globalThis.fetch`）。

**不覆盖**：

1. **DSH 核心 `web_fetch` 的传输层**。DSH ≥ 0.1.5-rc.1 起，核心 `web_fetch` 的出口由 harness 的代理策略模块 `@deepseek-ai/dsh-http-proxy` 决定，读的是**进程启动时的环境快照**，不经过 `globalThis.fetch`；想让那一层也走代理，需在启动环境里设 `HTTPS_PROXY`。
   （注意：若 `fetchProvider` 被插件接管，例如 `dsh-free-search` 的 `fs-quality-fetch`，抓取就走 `globalThis.fetch` 了，此时归「网页」类。）
2. **MCP stdio 子进程**（blender / easyeda 等）——各自独立进程，自己联网。
3. **Desktop 右侧浏览器**（Electron `<webview>`）——跟随系统代理，与插件无关。
4. **遥测 OTLP**——走 `node:http`，官方文档写明"按设计直连"。
5. **外部命令行**：`git` / `pnpm` / 各自的 CLI —— 读自己的环境变量或系统代理。

**协议**：HTTP / HTTPS CONNECT；注册表里只写了 `socks=` 时走 SOCKS5（支持 RFC1929 账号密码）。

**平台**：Windows（注册表）、macOS（`scutil --proxy`）、Linux（`HTTPS_PROXY` 等环境变量）。

## 自检

```bash
node test/unit.test.mjs      # 纯函数单测：注册表解析、主机匹配、请求归类、三开关决策
node test/tunnel.e2e.mjs     # 起一个本地最小 CONNECT 代理，验证隧道链路（需联网）
```

已验证：

- 单测全部通过，覆盖：系统代理关闭 → `enabled=false`（本插件与"手填兜底"的分歧点）、搜索域名识别、
  `api.deepseek.com` 上按路径区分 `tools/search`（搜索）与 `chat/completions`（LLM）、
  三个开关互不影响（只开「网页」时搜索请求仍直连）；
- 传输层端到端：本地最小 CONNECT 代理 → `proxiedFetch` → 抓取 `myip.ipip.net` 成功，返回真实出口 IP；
- 用真实的 Windows 注册表状态（`ProxyEnable=0` + `ProxyServer` 残留）验证：判定为直连，不会向死端口发请求。

**尚未验证**：没有在 DSH 宿主里实际加载运行过（首次提交时未做安装测试），宿主兼容性请以你的环境为准。

## 与其他代理插件共存

本插件包装 `globalThis.fetch`。如果同时启用另一个也包装 `globalThis.fetch` 的代理插件（例如 `dsh-net-proxy`），
两者会互相覆盖；本插件检测到这种情况会打印警告并**不强行拆除**对方的包装。建议同一时间只启用一个。

## 与 dsh-net-proxy 的关系

`lib/proxy/*`、`lib/proxy-fetch.js`、`lib/system-proxy.js` 的代理传输与系统代理读取代码来自
[dsh-net-proxy](https://github.com/mafeis/dsh-net-proxy)（MIT，© 2026 mafeis），原样保留并致谢。
本仓库重写了入口（`lib/index.js`）、配置 schema、请求归类（`lib/classify.js`、`lib/hosts.js`），
去掉了设置页 UI、流量日志、本地中继、桌面会话代理等模块。

## 目录结构

```
cordis.patch.yml      插件行声明
lib/index.js          入口：schema、系统代理轮询、按类别路由、fetch 装/拆
lib/classify.js       请求归类（搜索 / LLM / 网页）与三开关决策
lib/hosts.js          主机名解析与后缀匹配
lib/system-proxy.js   读取系统代理（Windows 注册表 / macOS scutil / Linux env）
lib/proxy-fetch.js    代理客户端入口
lib/proxy/            HTTP CONNECT / SOCKS5 / HTTP2 传输实现
test/                 单测与端到端自检
```

## 更新日志

### 0.2.0

**修复：桌面端设置页一直显示"正在读取系统代理"、开关点了没反应。**

原因是页面用根相对路径 `fetch("/_dsh/auto-proxy")` 读配置。DSH 桌面端的渲染进程 origin 是
`dsh-app://app`，该路径被解析成 `dsh-app://app/_dsh/auto-proxy`，落到 Electron 的协议处理器上返回
**200 + 空 body**，`res.json()` 抛错后页面就一直停在初始状态；同时点击也被"没有数据就不响应"的逻辑挡住。

改为走 DSH 官方的 `ctx.configForms` RPC 通道（`getSnapshot()` / `mutate(ops, revision)`），
与 DSH 自己的设置页同一条路，桌面端与浏览器端都可工作。另外：

- 修掉错误行把数组当 React children 渲染的 bug —— 之前**即使出错也看不到任何提示**；
- 页面底部新增「诊断信息」，直接显示宿主返回的快照，便于定位；
- 宿主侧 `/_dsh/auto-proxy` 路由保留（`dsh web` 浏览器模式仍可用），并补上 CORS 与 OPTIONS 预检。
## FAQ

**Q：开了「网页走代理」之后，DSH 的「思考过程翻译」显示「翻译暂不可用」？**

翻译插件（`dsh-experimental-translator`）用的是免登录端点：

- Bing：`https://edge.microsoft.com/translate/translatetext`（默认）
- Google：`https://translate.googleapis.com/...`

`edge.microsoft.com` 不在本插件内置的搜索域名表里，会被归到「网页」类；一旦网页类走代理，
这个免登录端点从境外 IP 访问通常会被风控，于是翻译失败。修法是把该主机排除出代理：

```yaml
config:
  noProxy:
    - 127.0.0.1
    - localhost
    - ::1
    - edge.microsoft.com   # Bing 免登录翻译端点，必须直连
```

反过来，如果你用 **Google** 翻译服务，`translate.googleapis.com` 在中国大陆直连不通，
**不要**把它加进 `noProxy`，让它继续走代理才对。

## License

MIT，见 [LICENSE](LICENSE)。
