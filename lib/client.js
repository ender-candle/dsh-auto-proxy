// dsh-auto-proxy — 浏览器半侧：设置 → 自动代理
// 三个开关 + 系统代理状态；数据来自同源路由 /_dsh/auto-proxy（见 lib/index.js）。
window.__ModuleLoader__.load({
  id: "dsh-auto-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var NS = "auto-proxy";
    var ENDPOINT = "/_dsh/auto-proxy";

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
        stateOk: "系统代理：",
        stateOff: "系统代理已关闭 —— 此刻全部直连",
        statePac: "系统使用 PAC，暂不支持跟随 —— 全部直连",
        stateUnavailable: "读不到系统代理设置 —— 全部直连",
        stateUnknown: "正在读取系统代理…",
        active: "已生效：按开关分流",
        inactive: "未生效：直连",
        refresh: "刷新",
        failed: "读取失败",
        saveFailed: "切换失败",
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
        stateOk: "System proxy: ",
        stateOff: "System proxy is off — everything is direct right now",
        statePac: "System uses PAC; following is unsupported — everything is direct",
        stateUnavailable: "Cannot read system proxy settings — everything is direct",
        stateUnknown: "Reading system proxy…",
        active: "Active: traffic split by the switches",
        inactive: "Inactive: direct",
        refresh: "Refresh",
        failed: "Failed to load",
        saveFailed: "Failed to switch",
      },
    };

    var S = {
      root: { display: "flex", flexDirection: "column", gap: "12px" },
      title: { fontSize: "18px", fontWeight: 650, margin: 0, color: "var(--dsw-alias-label-primary,#e6e6e6)" },
      intro: { fontSize: "12.5px", margin: 0, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary,#9aa0a6)" },
      status: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "8px 12px",
        borderRadius: "8px",
        fontSize: "12.5px",
        color: "var(--dsw-alias-label-secondary,#c8cbd0)",
        background: "var(--dsw-alias-bg-layer-2,#1a1e26)",
        border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)",
      },
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
      btn: {
        appearance: "none",
        cursor: "pointer",
        fontSize: "12px",
        padding: "4px 10px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2,#2a2f3a)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary,#c8cbd0)",
      },
      err: { fontSize: "12px", color: "var(--dsw-alias-label-danger,#e74c3c)" },
    };

    function statusText(t, system) {
      if (!system || system.state === "unknown") return t("stateUnknown");
      if (system.state === "ok") return t("stateOk") + (system.proxy || "");
      if (system.state === "off") return t("stateOff");
      if (system.state === "pac") return t("statePac");
      return t("stateUnavailable");
    }

    function AutoProxySection(props) {
      var t = props.t;
      var loading = React.useState(true);
      var setLoading = loading[1];
      var data = React.useState(null);
      var setData = data[1];
      var error = React.useState(null);
      var setError = error[1];

      function load() {
        return fetch(ENDPOINT, { headers: { accept: "application/json" } })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (json) {
            setData(json);
            setError(null);
          })
          .catch(function (e) {
            setError(String((e && e.message) || e));
          })
          .then(function () {
            setLoading(false);
          });
      }

      React.useEffect(function () {
        void load();
        var timer = setInterval(function () {
          void load();
        }, 4000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      function toggle(key) {
        if (!data || !data.config) return;
        var next = {};
        next[key] = !data.config[key];
        var optimistic = Object.assign({}, data);
        optimistic.config = Object.assign({}, data.config, next);
        setData(optimistic);
        fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(next),
        })
          .then(function (res) {
            return res.json().then(function (json) {
              if (!res.ok) throw new Error(json && json.error ? json.error : "HTTP " + res.status);
              setData(function (prev) {
                return Object.assign({}, prev, json);
              });
              setError(null);
            });
          })
          .catch(function (e) {
            setError(t("saveFailed") + ": " + String((e && e.message) || e));
            void load();
          });
      }

      var cfg = (data && data.config) || {};
      var system = data && data.system;
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
            checked: Boolean(cfg[item.key]),
            disabled: loading[0],
            onChange: function () {
              toggle(item.key);
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

      return h(
        "div",
        { style: S.root },
        h("h2", { style: S.title }, t("title")),
        h("p", { style: S.intro }, t("intro")),
        h(
          "div",
          { style: S.status },
          h("span", null, statusText(t, system)),
          h(
            "span",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", { style: S.hint }, data && data.active ? t("active") : t("inactive")),
            h(
              "button",
              {
                type: "button",
                style: S.btn,
                onClick: function () {
                  void load();
                },
              },
              t("refresh")
            )
          )
        ),
        h("div", { style: S.panel }, rows),
        error ? h("div", { style: S.err }, error) : null
      );
    }

    exports.inject = ["slots", "locale"];

    exports.apply = function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, DICTS);
      }, "auto-proxy: dictionaries");
      ctx.slots.inject("settings.section", function () {
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
              return { t: t };
            },
          },
          AutoProxySection
        );
      });
    };

    return module.exports;
  },
});
