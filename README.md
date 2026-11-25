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
| 3 | 路径是模型网关的图像端点（`/v1/images/generations`、`/images/edits` 等） | LLM |
| 4 | 主机命中模型网关（自动发现 + `llmHosts`） | LLM |
| 5 | 其余 | 网页 |

内置搜索域名：`bing.com`、`google.com`、`duckduckgo.com`、`search.brave.com`、`startpage.com`、`ecosia.org`、`mojeek.com`、`yandex.com`、`baidu.com`、`sogou.com`、`so.com`、`exa.ai`、`tavily.com`、`keenable.ai`、`firecrawl.dev`、`parallel.ai`、`perplexity.ai`、`serper.dev`、`serpapi.com`、`serply.io`、`you.com`、`jina.ai`、`zhihu.com`、`toutiao.com`。自建 SearXNG、内网搜索请用 `searchHosts` 追加。

模型网关默认**自动发现**：插件从 DSH 设置里读出所有 provider 的网关地址主机名（比如你配的第三方中转），不用手填。键名按后缀宽松识别——`baseURL`、`base_url`、`apiBase`、`api_base`，以及各插件带前缀的写法（`openaiCompatBaseURL`、`imageBaseURL` 之类）都算。发现不到时日志会留一行线索，用 `llmHosts` 补。

> 第 3 条是为图像端点准备的兜底：图生图（multipart 发 `/v1/images/edits`）和对话走同一个网关，
> 但网关主机若没被发现，它就会掉进「网页」类，被「网页走代理」开关带走。路径判据不依赖配置。

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
| `timeout` | `60000` | 连接 / TLS 握手 / 代理握手的超时（毫秒）。 |
| `llmTimeout` | `600000` | LLM 类请求**等响应**的上限（毫秒），`0` = 不限。生图这类请求要几十秒到几分钟才有第一个字节，不能用连接超时去量。 |

> 超时是两个口径：`timeout` 只量「连不上」，`llmTimeout` 量「连上了但还没回话」。
> 搜索/网页类请求的等待上限沿用 `timeout`；LLM 类（含 `/images/edits` 这类生图端点）用 `llmTimeout`。

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

**请求体**：代理层自己拼 HTTP 报文，请求体得先变成字节。支持 `string`、`Buffer`、TypedArray、`Blob`、
`URLSearchParams`、`FormData`（`multipart` 会带上同一个 boundary 的 content-type）、Node 流；
**转发不了的请求体（例如 Web `ReadableStream`）自动退回直连**——代理只该是「尽力绕行」，
绝不该让本来能成功的请求失败（包装的是全进程 `fetch`，一次误伤就是某个插件功能整体失效）。
`FormData` 会整体编码进内存一次（几 MB 的图片没问题，超大上传请留意内存）。

**平台**：Windows（注册表）、macOS（`scutil --proxy`）、Linux（`HTTPS_PROXY` 等环境变量）。

## 自检

```bash
node test/unit.test.mjs      # 纯函数单测：注册表解析、主机匹配、请求归类、请求体编码、三开关决策
node test/bodies.e2e.mjs     # 本地闭环（不联网）：起最小 forward proxy + origin，验证 FormData/JSON/字符串/表单经代理完整送达
node test/tunnel.e2e.mjs     # 起一个本地最小 CONNECT 代理，验证隧道链路（需联网）
```

已验证：

- 单测全部通过，覆盖：系统代理关闭 → `enabled=false`（本插件与"手填兜底"的分歧点）、搜索域名识别、
  **volatile 开关必须读 `.get()`（直接取引用恒为 true，正是 0.2.4 修的 bug）**、
  `api.deepseek.com` 上按路径区分 `tools/search`（搜索）与 `chat/completions`（LLM）、
  图像端点（`/v1/images/edits`）即使网关未发现也归 LLM、`openaiCompatBaseURL` 这类带前缀的键名能被发现、
  `FormData`/`URLSearchParams`/字符串的编码与 content-type、转发不了的请求体退回直连（且只提示一次）、
  三个开关互不影响（只开「网页」时搜索请求仍直连）；
- 本地闭环：`FormData` 经代理链路送达时 boundary、`Content-Length`、字段与文件字节全部一致；
  JSON / 字符串 / 表单请求体不受影响；慢响应（300ms 才回）在 `responseTimeout` 放宽 / 置 0 时正常返回，
  收紧到 100ms 时按 `ETIMEOUT` 失败；
- 传输层端到端：本地最小 CONNECT 代理 → `proxiedFetch` → HTTPS 端点，HTTP/2（ALPN h2）与 HTTP/1.1 两条路径都验证过
  `multipart/form-data` 能完整送达并被服务端回显；h2 路径的等响应上限确认走 `responseTimeout`
  （`80ms` → `HTTP/2 request timeout after 80ms`；`20000ms` → 正常 200 并回显表单）。
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
lib/classify.js       请求归类（搜索 / LLM / 网页）、图像端点与三开关决策
lib/hosts.js          主机名解析与后缀匹配
lib/config-value.js   读取配置字段真实值（volatile 字段是 { get() } 引用，必须解引用）
lib/provider-hosts.js 从 DSH 设置里发现模型网关主机（baseURL 键名宽松识别）
lib/system-proxy.js   读取系统代理（Windows 注册表 / macOS scutil / Linux env）
lib/proxy-fetch.js    代理客户端入口
lib/proxy/            HTTP CONNECT / SOCKS5 / HTTP2 传输实现（含请求体编码）
test/                 单测与端到端自检
```

## 更新日志

### 0.2.4

**修复：三个开关从来没真正生效过（`/_dsh/auto-proxy` 永远显示三个都是 `true`，
界面上点了也没反应，用户从没开过「LLM 走代理」却显示开着）。**

三个开关都声明了 `.volatile()`，而 schemastery 会把 volatile 字段在
`apply(ctx, config)` 里换成 cosmokit 的引用对象 `{ get(): T }`，**不是原始值**。
旧代码直接 `!!cfg.proxyLLM` / `Boolean(config.proxyLLM)`——对象恒真，于是：

- 路由里三个开关永远"开着"→ 只要系统代理可用，**什么请求都走代理**（搜索/LLM/网页全走）；
- `/_dsh/auto-proxy` 的 `snapshotConfig()` 永远返回三个 `true`；
- 界面上改开关只更新了引用的值，宿主从没读过 `.get()` → 等于点了没反应；
- 「网页开关未开」的提示分支永远进不去。

修复：新增 `lib/config-value.js`，`readConfigField(ref, fallback)` 统一解引用
（volatile 取 `.get()`，普通字段原样），`readSwitches(config)` 现读三个开关；
所有读取点（路由、快照、日志、超时、轮询间隔）都改用它。另外启动即安装 fetch 包装器
（路由按请求决策），所以**开关改动现在即时生效**，不需要再靠系统代理状态变化来触发。

> 行为变化提示：升级后开关才第一次真正起作用。之前"什么都走代理"是因为开关失灵，
> 不是设计如此；需要走代理的类别请显式打开对应开关。

### 0.2.3

**修复：开了「LLM 走代理」后，dsh-image-gen 的图生图在 60 秒整报
`Error [ETIMEOUT]: HTTP/2 request timeout after 60000ms`。**

代理把 `timeout`（连接超时，默认 60s）当成了「整个请求」的截止时间：h2 路径用一个
从发出请求起算的定时器等响应头，h1 路径用 `ByteStream` 的空闲计时。可生图请求在服务端
算几十秒到几分钟才回第一个字节——连接一直健康，只是没话说，于是被 60s 裁掉。

拆成两个口径：

- `timeout`：只量连接 / TLS 握手 / 代理握手；
- `llmTimeout`（新配置，默认 600000，0 = 不限）：量「连上了但还没回响应」，
  只对 LLM 类请求生效（含按路径识别的 `/images/edits` 等生图端点）。
  搜索 / 网页类仍用 `timeout`，避免死连接长时间占着。

另外把 fetch 包装器的装拆改稳了：**只装一次，之后不再随系统代理开关来回替换**。
包装器本来就按请求决策（没代理时原样直连），拆掉没有收益；而反复改写
`globalThis.fetch` 会让同样改 fetch 的插件（例如 DSH 的 `experimental-inspector`，
它靠「快照 / 栈顶还原」管理包装层）错位，旧层留在链上越叠越深，最终一次 `fetch`
就可能 `Maximum call stack size exceeded`。多插件共用 `globalThis.fetch` 时，
谁少换手一次，链条就少一次错位的机会。

### 0.2.2

**修复：开了「网页走代理」后，插件里所有 `FormData` 请求直接失败**
（现场是 dsh-image-gen 的图生图：`openai image edit request failed after 0.0s: Error [EBODY]:
proxiedFetch: unsupported request body type: FormData`）。

三个独立问题，任何一个都够把请求打死：

1. **请求体白名单缺 `FormData`**。`normalizeBody()` 只认 string / Buffer / TypedArray / Blob /
   `URLSearchParams` / Node 流，`FormData` 一律抛 `EBODY`。现在借 `new Request(url, { body })`
   让 undici 自己编码，顺便拿到带 boundary 的 `content-type` 并写进请求头
   （`Blob` 的 `type`、`URLSearchParams`、string 也按 fetch 语义补）。
2. **转发不了就报错，而不是退回直连**。代理包装的是全进程 `globalThis.fetch`，
   一次 `EBODY` 就等于某个插件功能整体失效。现在遇 `EBODY` 直接走 `originalFetch`（直连），
   并在日志里按请求体类型提示一次。
3. **归类漏了模型网关，图像端点还会被「网页」开关带走**。自动发现只认
   `baseurl|base_url|apibase|api_base` 四个精确拼法，`openaiCompatBaseURL` 这种带插件前缀的写法一个都不命中；
   主机没被发现时，`/v1/images/edits` 又被当成普通网页。现在：
   - 键名按后缀宽松识别（`lib/provider-hosts.js`，并单独导出便于单测）；
   - 新增路径判据：`/images/generations`、`/images/edits`、`/images/variations` 等端点直接归 LLM，
     不依赖配置是否发现得到主机；
   - 自动发现失败时日志会留一行线索（设置项数量），方便用 `llmHosts` 手填。

新增 `test/bodies.e2e.mjs`（本地 forward proxy + origin 闭环，不联网），以及针对上面三点的单测。

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

**Q：三个开关显示全是开着的 / 我从来没开过「LLM 走代理」却显示开着 / 点了开关没反应？**

0.2.4 已修。开关是 `.volatile()` 字段，DSH 在 `apply` 里给到的是 `{ get(): T }` 引用对象，
旧版本按布尔用，对象恒真 → 三个开关全失效、接口永远返回 `true`、界面改动不生效。
升级后 `readSwitches()` 每次现读 `.get()`，开关即时生效。

**Q：图生图报 `Error [ETIMEOUT]: HTTP/2 request timeout after 60000ms`？**

0.2.3 已修。旧版本把 `timeout`（连接超时，60s）当成了整个请求的截止时间，而服务端生图
要几十秒到几分钟才回第一个字节。升级后 LLM 类请求等响应用 `llmTimeout`（默认 10 分钟，
`0` 表示不限），搜索/网页仍用 `timeout`。想继续用旧版本，就把 `timeout` 调大（比如 `600000`），
或者干脆关掉「LLM 走代理」让生图直连。

**Q：用着用着 DSH 宿主直接崩了，日志里是 `Maximum call stack size exceeded`？**

先看崩溃现场：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`。
如果栈里反复出现 `@deepseek-ai/dsh-experimental-inspector` 的 fetch 观察器
（`Reflect.apply(original, ...)` / `return response`），那是 inspector 的 fetch 包装层
叠了太多层——它靠「安装时快照、卸载时栈顶还原」管理包装器，一旦栈顶已被别的插件换过，
还原就放弃，旧层永久留在链上。修法是关掉不用的 Inspector 面板 / 不再加载
`@deepseek-ai/dsh-experimental-inspector-profile` 这个 bundle，然后重启。
本插件 0.2.3 起不再随开关换手 `globalThis.fetch`，减少这类错位，但源头在 inspector 那边。

**Q：开了「网页走代理」之后，dsh-image-gen 的图生图报 `proxiedFetch: unsupported request body type: FormData`？**

0.2.2 已修。原因有三层：代理层不认 `FormData` 请求体、转发不了时直接抛错而不是退回直连、
图像端点 `/v1/images/edits` 在网关主机没被发现时被归成「网页」类。修好后：图像端点直接归 LLM（跟「LLM 走代理」开关走），
`FormData` 能正常转发，即使再遇到转发不了的请求体也会直连而不是失败。

临时绕过（旧版本）：把「网页走代理」关掉，或把网关主机写进 `noProxy`：

```yaml
config:
  noProxy:
    - 127.0.0.1
    - localhost
    - ::1
    - api.fanfanhenkuai.com   # 你的模型/生图网关
```

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
