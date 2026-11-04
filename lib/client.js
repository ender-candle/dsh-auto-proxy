// dsh-auto-proxy — 浏览器半侧：设置 → 自动代理（v0.2.1）
//
// 开关走 DSH 官方的 configForms RPC 通道（桌面端唯一可用的通道）：
//   form = ctx.configForms.get("auto-proxy")
//   form.getSnapshot() / form.mutate([{ op: "set", path: [key], value }], revision)
//
// 顶部「当前策略」由三个开关即时推导，不依赖宿主；「系统代理」一行在能连到宿主同源路由时
// 显示真实地址（dsh web 浏览器模式），桌面端（dsh-app://app）显示说明文字。
window.__ModuleLoader__.load({
  id: "dsh-auto-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var NAME = "auto-proxy";
    var NS = "auto-proxy";
    var STATUS_URL = "/_dsh/auto-proxy";

    var DICTS = {
      zh: {
        nav: "自动代理",
        title: "自动代理",
        intro:
          "三个开关各自独立：打开的那一类走系统代理，其余始终直连。系统代理关闭时，无论开关如何都全部直连。",
        searchLabel: "搜索走代理",
        searchHint: "找资料：发往搜索引擎 / 搜索服务的请求（Bing、Google、Exa、Tavily…）。",
        llmLabel: "LLM 走代理",
        llmHint: "和模型说话：发往模型网关的请求（自动从 provider 的 baseURL 识别）。",
        webLabel: "网页走代理",
        webHint: "读内容：打开搜索结果里的网页、抓取页面，以及其余不属于上面两类的请求。",
        policyOn: "走代理",
        policyOff: "直连",
        policyPrefix: "当前策略",
        sysLoading: "系统代理：正在读取…",
        sysOk: "系统代理：",
        sysOff: "系统代理已关闭 —— 此刻全部直连",
        sysPac: "系统代理使用 PAC —— 不支持跟随，全部直连",
        sysUnknown: "系统代理状态在桌面端不显示；宿主仍每 3 秒检测，关闭时自动全部直连",
        unavailable: "宿主尚未提供该插件配置（重启 DSH 后再看）。",
        saveFailed: "切换失败",
        diag: "诊断信息",
      },
      en: {
        nav: "Auto proxy",
        title: "Auto proxy",
        intro:
          "Three independent switches. A kind that is on goes through the system proxy; everything else stays direct. When the system proxy is off, all traffic is direct no matter what.",
        searchLabel: "Proxy search",
        searchHint: "Finding: requests to search engines and search APIs (Bing, Google, Exa, Tavily…).",
        llmLabel: "Proxy LLM",
        llmHint: "Talking to the model: requests to the model gateway (auto-detected from provider baseURL).",
        webLabel: "Proxy web pages",
        webHint: "Reading: opening result pages, fetches, and anything that is neither search nor LLM.",
        policyOn: "proxy",
        policyOff: "direct",
        policyPrefix: "Policy",
        sysLoading: "System proxy: reading…",
        sysOk: "System proxy: ",
        sysOff: "System proxy is off — everything is direct right now",
        sysPac: "System proxy uses PAC — following unsupported, everything is direct",
        sysUnknown: "System proxy state is not shown in the desktop app; the host still checks every 3s and goes direct when it is off",
        unavailable: "The host is not serving this plugin's config yet (restart DSH and check again).",
        saveFailed: "Failed to switch",
        diag: "Diagnostics",
      },
    };

    var S = {
      root: { display: "flex", flexDirection: "column", gap: "12px" },
      title: { fontSize: "18px", fontWeight: 650, margin: 0, color: "var(--dsw-alias-label-primary,#e6e6e6)" },
      intro: { fontSize: "12.5px", margin: 0, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary,#9aa0a6)" },
      status: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "9px 12px",
        borderRadius: "8px",
        fontSize: "12.5px",
        lineHeight: 1.5,
        color: "var(--dsw-alias-label-secondary,#c8cbd0)",
        background: "var(--dsw-alias-bg-layer-2,#1a1e26)",
        border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)",
      },
      strong: { color: "var(--dsw-alias-label-primary,#e6e6e6)", fontWeight: 600 },
      panel: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "14px 16px",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-2,#1a1e26)",
        border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)",
      },
      row: { display: "flex", gap: "10px", alignItems: "flex-start" },
      checkbox: { width: "16px", height: "16px", marginTop: "2px", cursor: "pointer" },
      label: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e6e6)" },
      hint: { fontSize: "11.5px", lineHeight: 1.55, color: "var(--dsw-alias-label-tertiary,#9aa0a6)" },
      err: { fontSize: "12px", color: "var(--dsw-alias-label-danger,#e74c3c)" },
      diag: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary,#9aa0a6)" },
      pre: {
        margin: "6px 0 0",
        padding: "8px 10px",
        borderRadius: "8px",
        fontSize: "11px",
        lineHeight: 1.5,
        maxHeight: "180px",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        background: "var(--dsw-alias-bg-layer-1,#12151b)",
        border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)",
        color: "var(--dsw-alias-label-secondary,#c8cbd0)",
      },
    };

    // ── 快照兼容读取 ──────────────────────────────────────────────────────
    function valuesOf(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return {};
      var bags = [snapshot.value, snapshot.config, snapshot.values, snapshot.current];
      for (var i = 0; i < bags.length; i += 1) {
        if (bags[i] && typeof bags[i] === "object" && !Array.isArray(bags[i])) return bags[i];
      }
      if (Array.isArray(snapshot.fields)) {
        var fromFields = {};
        snapshot.fields.forEach(function (field) {
          if (field && typeof field.name === "string") {
            fromFields[field.name] = field.value !== undefined ? field.value : field.text;
          }
        });
        if (Object.keys(fromFields).length) return fromFields;
      }
      return snapshot;
    }

    function revisionOf(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return undefined;
      if (snapshot.revision !== undefined) return snapshot.revision;
      if (snapshot.rev !== undefined) return snapshot.rev;
      if (snapshot.version !== undefined) return snapshot.version;
      return undefined;
    }

    function truthy(value) {
      return value === true || value === "true" || value === 1;
    }

    function safeJson(value) {
      try {
        return JSON.stringify(
          value,
          function (key, val) {
            if (typeof val === "function") return "[function]";
            return val;
          },
          2
        ).slice(0, 4000);
      } catch (error) {
        return String(value);
      }
    }

    // 「当前策略」由三个开关推导，不依赖宿主
    function policyLine(t, values) {
      return [
        t("searchLabel") + " " + (truthy(values.proxySearch) ? t("policyOn") : t("policyOff")),
        t("llmLabel") + " " + (truthy(values.proxyLLM) ? t("policyOn") : t("policyOff")),
        t("webLabel") + " " + (truthy(values.proxyWeb) ? t("policyOn") : t("policyOff")),
      ].join(" · ");
    }

    function AutoProxySection(props) {
      var t = props.t;
      var form = props.form;

      var statePair = React.useState({ snapshot: null, error: null, busy: false });
      var state = statePair[0];
      var setState = statePair[1];

      // 宿主系统代理状态：仅在能连到同源路由时可用（dsh web 浏览器模式）
      var sysPair = React.useState({ state: "loading", proxy: "" });
      var sys = sysPair[0];
      var setSys = sysPair[1];

      function read() {
        if (!form || typeof form.getSnapshot !== "function") {
          setState({ snapshot: null, error: "configForms form unavailable", busy: false });
          return;
        }
        try {
          setState({ snapshot: form.getSnapshot(), error: null, busy: false });
        } catch (error) {
          setState({ snapshot: null, error: String((error && error.message) || error), busy: false });
        }
      }

      function readHostStatus() {
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, 1500) : null;
        fetch(STATUS_URL, {
          headers: { accept: "application/json" },
          signal: controller ? controller.signal : undefined,
        })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (json) {
            var system = (json && json.system) || {};
            setSys({ state: system.state || "unknown", proxy: system.proxy || "" });
          })
          .catch(function () {
            setSys({ state: "unknown", proxy: "" });
          })
          .then(function () {
            if (timer) clearTimeout(timer);
          });
      }

      React.useEffect(function () {
        read();
        readHostStatus();
        var timer = setInterval(read, 1500);
        var sysTimer = setInterval(readHostStatus, 5000);
        return function () {
          clearInterval(timer);
          clearInterval(sysTimer);
        };
      }, []);

      function toggle(key, nextValue) {
        if (!form || typeof form.mutate !== "function") return;
        var snapshot = state.snapshot;
        var revision = revisionOf(snapshot);
        setState({ snapshot: snapshot, error: null, busy: true });
        var ops = [{ op: "set", path: [key], value: nextValue }];
        Promise.resolve(form.mutate(ops, revision))
          .then(function () {
            read();
          })
          .catch(function (error) {
            setState({
              snapshot: snapshot,
              error: t("saveFailed") + ": " + String((error && error.message) || error),
              busy: false,
            });
          });
      }

      var values = valuesOf(state.snapshot);
      var rows = [
        { key: "proxySearch", label: t("searchLabel"), hint: t("searchHint") },
        { key: "proxyLLM", label: t("llmLabel"), hint: t("llmHint") },
        { key: "proxyWeb", label: t("webLabel"), hint: t("webHint") },
      ].map(function (item) {
        return h(
          "label",
          { key: item.key, style: S.row },
          h("input", {
            type: "checkbox",
            style: S.checkbox,
            checked: truthy(values[item.key]),
            disabled: state.busy,
            onChange: function (event) {
              toggle(item.key, Boolean(event.target.checked));
            },
          }),
          h(
            "span",
            { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            h("span", { style: S.label }, item.label),
            h("span", { style: S.hint }, item.hint)
          )
        );
      });

      function systemText() {
        if (sys.state === "loading") return t("sysLoading");
        if (sys.state === "ok") return t("sysOk") + sys.proxy;
        if (sys.state === "off") return t("sysOff");
        if (sys.state === "pac") return t("sysPac");
        return t("sysUnknown");
      }

      return h(
        "div",
        { style: S.root },
        h("h2", { style: S.title }, t("title")),
        h("p", { style: S.intro }, t("intro")),
        h(
          "div",
          { style: S.status },
          h("div", null, h("span", { style: S.strong }, t("policyPrefix") + "："), policyLine(t, values)),
          h("div", { style: S.hint }, systemText())
        ),
        h("div", { style: S.panel }, state.snapshot ? rows : h("div", { style: S.hint }, t("unavailable"))),
        state.error ? h("div", { style: S.err }, String(state.error)) : null,
        h(
          "details",
          { style: S.diag },
          h("summary", null, t("diag")),
          h("pre", { style: S.pre }, safeJson(state.snapshot))
        )
      );
    }

    exports.inject = ["slots", "locale", "configForms"];

    exports.apply = function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, DICTS);
      }, "auto-proxy: dictionaries");

      function form() {
        try {
          return ctx.configForms.get(NAME);
        } catch (error) {
          return null;
        }
      }

      ctx.effect(function () {
        var mount = function () {
          return ctx.slots.inject("settings.section", function () {
            return ctx.slots.register(
              {
                name: "settings.section",
                id: "auto-proxy",
                order: 60,
                label: function () {
                  return t("nav");
                },
                locale: NS,
                inject: function () {
                  return { t: t, form: form() };
                },
              },
              AutoProxySection
            );
          });
        };
        var serve = typeof ctx.configForms.whileServed === "function" ? ctx.configForms.whileServed.bind(ctx.configForms) : null;
        return serve ? serve([NAME], mount) : mount();
      }, "auto-proxy: page");
    };

    return module.exports;
  },
});
