/**
 * Embedded dashboard page for `paperlab watch` — a "living paper" aesthetic.
 * Features: EN/中文 i18n, timestamped activity timeline, in-flight tool
 * banner, always-visible token/cost usage, model override, steering.
 * No build step, no CDN.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>paperlab — run panel</title>
<style>
  :root {
    --paper: #fbfaf7; --card: #ffffff; --ink: #16150f; --muted: #6f6a5e;
    --rule: #d9d4c7; --rule-strong: #16150f;
    --accent: #1a4480; --good: #0f5132; --warn: #8a6100; --bad: #b31b1b;
    --tint-good: #eef4ee; --tint-warn: #f7f1e3; --tint-bad: #f8ecec;
  }
  * { box-sizing: border-box; }
  html { background: var(--paper); }
  body { margin: 0; color: var(--ink); font: 15px/1.55 "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif; }
  .wrap { max-width: 1140px; margin: 0 auto; padding: 28px 32px 64px; }
  header { border-bottom: 2px solid var(--rule-strong); padding-bottom: 14px; margin-bottom: 6px; }
  .masthead { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .brand { font-variant: small-caps; letter-spacing: .18em; font-size: 14px; color: var(--muted); }
  .brand b { color: var(--ink); font-weight: 600; }
  .masthead-right { display: flex; gap: 14px; align-items: baseline; }
  .usage-chip { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); }
  .usage-chip b { color: var(--good); font-weight: 600; }
  .lang-toggle { background: none; border: 1px solid var(--rule); border-radius: 2px; padding: 2px 10px; cursor: pointer; font: 12.5px Charter, Cambria, serif; color: var(--muted); }
  .lang-toggle:hover { border-color: var(--ink); color: var(--ink); }
  .runstate { font-variant: small-caps; letter-spacing: .14em; font-size: 13px; }
  .runstate.running { color: var(--warn); } .runstate.done { color: var(--good); }
  .runstate.failed { color: var(--bad); } .runstate.idle { color: var(--muted); }
  h1.title { font: italic 700 24px/1.3 Charter, Cambria, Georgia, serif; margin: 10px 0 4px; }
  .meta { color: var(--muted); font-size: 13.5px; }
  .protocol { display: flex; flex-wrap: wrap; gap: 0; margin: 18px 0 26px; }
  .step { flex: 1 1 150px; min-width: 150px; padding: 10px 12px 12px; border-top: 3px solid var(--rule); }
  .step .no { font-variant: small-caps; letter-spacing: .12em; color: var(--muted); font-size: 11.5px; display:block; }
  .step .nm { font-size: 14px; }
  .step .st { font-size: 12px; color: var(--muted); }
  .step.done { border-top-color: var(--good); } .step.done .st { color: var(--good); }
  .step.running { border-top-color: var(--warn); background: var(--tint-warn); }
  .step.running .st { color: var(--warn); } .step.running .st::after { content: " ●"; animation: blink 1.2s infinite; }
  .step.failed { border-top-color: var(--bad); background: var(--tint-bad); } .step.failed .st { color: var(--bad); }
  @keyframes blink { 50% { opacity: .2; } }
  section { margin-top: 30px; }
  h2 { font: 600 15px Charter, Cambria, Georgia, serif; margin: 0 0 4px; border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
  h2 .sn { color: var(--muted); font-weight: 400; margin-right: 10px; }
  h2 .aside { float: right; font-weight: 400; color: var(--muted); font-size: 12.5px; }
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 34px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  thead th { border-top: 2px solid var(--rule-strong); border-bottom: 1px solid var(--rule-strong); text-align: left; padding: 6px 10px; font-weight: 600; }
  tbody td { padding: 5px 10px; }
  tbody tr:last-child td { border-bottom: 2px solid var(--rule-strong); }
  tbody tr:nth-child(even) { background: #f4f2ec; }
  td.num, th.num { text-align: right; }
  .val { color: var(--good); font-weight: 600; } .val.fail { color: var(--bad); }
  .stats { display: flex; gap: 26px; flex-wrap: wrap; margin-top: 10px; }
  .stat .k { font-variant: small-caps; letter-spacing: .1em; font-size: 11.5px; color: var(--muted); display: block; }
  .stat .v { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16px; }
  .log { border-left: 2px solid var(--rule); margin-left: 4px; padding-left: 18px; max-height: 340px; overflow-y: auto; }
  .log .row { margin: 6px 0; font-size: 13px; }
  .log .ts { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); margin-right: 8px; }
  .log .who { font-variant: small-caps; letter-spacing: .08em; color: var(--accent); font-size: 12px; margin-right: 8px; }
  .log .what { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; }
  .log .what.tool { color: #3b5c97; }
  .log .what.start { color: var(--warn); }
  .inflight { border: 1px solid var(--warn); background: var(--tint-warn); padding: 8px 12px; margin-bottom: 10px; font-size: 13px; }
  .inflight .toolname { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--warn); font-weight: 600; }
  .inflight .elapsed { color: var(--muted); font-style: italic; }
  .intervene textarea { width: 100%; min-height: 72px; background: var(--card); color: var(--ink); border: 1px solid var(--rule); border-radius: 2px; padding: 9px 11px; font: 14px Charter, Cambria, Georgia, serif; }
  .intervene select, .intervene button, .modelrow select, .modelrow button {
    background: var(--card); color: var(--ink); border: 1px solid var(--ink); border-radius: 2px; padding: 6px 14px; font: 13.5px Charter, Cambria, Georgia, serif;
  }
  .intervene button.primary, .modelrow button { background: var(--ink); color: var(--paper); font-weight: 600; cursor: pointer; }
  .intervene button.primary:hover { background: #000; }
  .formrow { display: flex; gap: 10px; margin-top: 9px; align-items: center; flex-wrap: wrap; }
  .status { font-size: 12.5px; color: var(--muted); font-style: italic; }
  .hist { margin-top: 14px; }
  .hist .row { padding: 6px 0; border-top: 1px dotted var(--rule); font-size: 13px; }
  .hist .tgt { font-variant: small-caps; letter-spacing: .08em; color: var(--warn); font-size: 11.5px; }
  .hist .state { font-size: 11.5px; color: var(--muted); }
  .hist .state.delivered { color: var(--good); }
  .modelrow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
  .modelrow .cur { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--accent); }
  .modelnote { font-size: 12.5px; color: var(--muted); font-style: italic; margin-top: 8px; }
  .verdict { font-size: 15px; }
  .verdict b { font-size: 18px; }
  iframe { width: 100%; height: 720px; border: 1px solid var(--rule); background: #fff; margin-top: 10px; }
  .empty { color: var(--muted); font-style: italic; }
  footer { margin-top: 44px; border-top: 1px solid var(--rule); padding-top: 10px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="masthead">
      <div class="brand"><b>paperlab</b> <span data-i18n="brand">· automated research pipeline</span></div>
      <div class="masthead-right">
        <span class="usage-chip" id="usage-chip"></span>
        <span class="runstate idle" id="runstate">—</span>
        <button class="lang-toggle" id="lang-toggle">中文</button>
      </div>
    </div>
    <h1 class="title" id="topic">loading…</h1>
    <div class="meta"><span data-i18n="runLabel">run</span> <span class="mono" id="runroot"></span> · <span class="mono" id="clock"></span></div>
  </header>

  <div class="protocol" id="protocol"></div>

  <section>
    <h2><span class="sn">1</span><span data-i18n="s1">Results — recorded metrics (ground truth for every number in the paper)</span></h2>
    <div style="max-height:300px; overflow:auto"><table id="metrics"></table></div>
    <div class="stats" id="usage"></div>
  </section>

  <div class="cols" style="margin-top:30px">
    <section>
      <h2><span class="sn">2</span><span data-i18n="s2">Experimental log</span><span class="aside" data-i18n="live">live</span></h2>
      <div class="log" id="activity"><span class="empty" data-i18n="waiting">waiting for activity…</span></div>
    </section>
    <section class="intervene">
      <h2><span class="sn">3</span><span data-i18n="s3">Operator intervention</span></h2>
      <div class="meta" style="margin-bottom:8px" data-i18n="s3note">Messages are injected into the agent's next turn or tool result.</div>
      <select id="target"></select>
      <textarea id="text"></textarea>
      <div class="formrow">
        <button class="primary" id="send" data-i18n="send">Send instruction</button>
        <span class="status" id="steer-status"></span>
      </div>
      <div class="hist" id="steer-history"></div>
    </section>
  </div>

  <section>
    <h2><span class="sn">4</span><span data-i18n="s4">Runtime configuration — model override</span></h2>
    <div class="modelrow">
      <select id="m-scope"></select>
      <select id="m-provider"></select>
      <select id="m-model"></select>
      <button id="m-apply" data-i18n="apply">Apply</button>
    </div>
    <div class="modelrow"><span class="cur" id="m-current"></span></div>
    <div class="modelnote" data-i18n="modelNote">Applies to sessions created after the change; running sessions keep their model.</div>
  </section>

  <section>
    <h2><span class="sn">5</span><span data-i18n="s5">Peer review</span></h2>
    <div class="verdict" id="review"><span class="empty" data-i18n="notReviewed">not reviewed yet</span></div>
  </section>

  <section id="pdf-section" style="display:none">
    <h2><span class="sn">6</span><span data-i18n="s6">Manuscript</span><span class="aside" data-i18n="compiled">compiled</span></h2>
    <iframe id="pdf" src="/api/paper"></iframe>
  </section>

  <footer data-i18n="footer">artifacts on disk — the panel only reads them, plus two write paths: steering and model override.</footer>
</div>
<script>
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

var I18N = {
  en: {
    brand: "· automated research pipeline", runLabel: "run",
    phases: { "01-literature": "Literature", "02-plan": "Plan", "03-experiment": "Experiment", "04-interpret": "Interpretation", "05-paper": "Writing", "06-review": "Review" },
    status: { done: "done", running: "running", failed: "failed", pending: "pending" },
    runState: { running: "run · running", done: "run · complete", failed: "run · halted", idle: "idle" },
    min: "min", s1: "Results — recorded metrics (ground truth for every number in the paper)",
    exp: "experiment", metric: "metric", value: "value", runs: "runs", failedVal: "failed", noMetrics: "no metrics recorded yet",
    turns: "llm turns", inTok: "input tokens", outTok: "output tokens", cost: "est. cost",
    s2: "Experimental log", live: "live", waiting: "waiting for activity…",
    running: "running", on: "on", forS: "for",
    s3: "Operator intervention",
    s3note: "Messages are injected into the agent's next turn or tool result — at most one turn of latency.",
    send: "Send instruction", sent: "in the mailbox — delivered on the next turn ✓",
    steerPh: "e.g. The n=1000 stratum is eating the budget — drop it and double the seeds at n=100 instead.",
    delivered: "delivered ✓", pendingMsg: "pending — delivered on next turn", to: "to", noSteer: "no interventions yet",
    targets: [["any","all agents — next prompt, any phase"],["03-experiment","03 · experiment (ml engineer)"],["05-paper","05 · paper (writer)"],["02-plan","02 · plan (postdoc & phd)"],["06-review","06 · review (reviewers & AC)"],["mlengineer","any phase · role: ml engineer"],["writer","any phase · role: writer"],["postdoc","any phase · role: postdoc"]],
    s4: "Runtime configuration — model override",
    scopes: [["default","default (all roles)"],["writer","writer"],["mlengineer","ml engineer"],["reviewer","reviewer"],["postdoc","postdoc"],["phd","phd"],["ac","area chair"]],
    apply: "Apply", current: "current",
    modelNote: "Applies to sessions created after the change; running sessions keep their model. The override is a run artifact (model-override.json).",
    s5: "Peer review", notReviewed: "not reviewed yet", overall: "/10 overall",
    s6: "Manuscript", compiled: "compiled",
    footer: "artifacts on disk: state.json · papers.jsonl · metrics.jsonl · transcripts · steering.jsonl · model-override.json — the panel only reads them, plus two write paths: steering and model override."
  },
  zh: {
    brand: "· 自动化科研流水线", runLabel: "运行",
    phases: { "01-literature": "文献综述", "02-plan": "研究方案", "03-experiment": "实验执行", "04-interpret": "结果解读", "05-paper": "论文写作", "06-review": "同行评审" },
    status: { done: "完成", running: "进行中", failed: "失败", pending: "待开始" },
    runState: { running: "流水线 · 运行中", done: "流水线 · 已完成", failed: "流水线 · 已中止", idle: "空闲" },
    min: "分钟", s1: "结果 —— 已记录指标(论文中每个数字的唯一真值来源)",
    exp: "实验", metric: "指标", value: "数值", runs: "次数", failedVal: "失败", noMetrics: "尚无指标记录",
    turns: "LLM 轮次", inTok: "输入 tokens", outTok: "输出 tokens", cost: "预估成本",
    s2: "实验日志", live: "实时", waiting: "等待活动…",
    running: "正在执行", on: "于", forS: "已",
    s3: "操作员介入",
    s3note: "指令会注入 agent 的下一回合或工具返回——最多延迟一个回合。",
    send: "发送指令", sent: "已进邮箱——下一回合适达 ✓",
    steerPh: "例如:n=1000 档正在消耗预算且无新信号——砍掉它,把 n=100 的种子数翻倍。",
    delivered: "已送达 ✓", pendingMsg: "待送达——下一回合适达", to: "发往", noSteer: "尚无介入",
    targets: [["any","所有 agent——任意阶段的下一个提示"],["03-experiment","03 · 实验(ML 工程师)"],["05-paper","05 · 论文(写作)"],["02-plan","02 · 方案(博士后与博士)"],["06-review","06 · 评审(审稿人与 AC)"],["mlengineer","任意阶段 · 角色:ML 工程师"],["writer","任意阶段 · 角色:写作"],["postdoc","任意阶段 · 角色:博士后"]],
    s4: "运行时配置 —— 模型切换",
    scopes: [["default","默认(全部角色)"],["writer","写作"],["mlengineer","ML 工程师"],["reviewer","审稿人"],["postdoc","博士后"],["phd","博士"],["ac","领域主席"]],
    apply: "应用", current: "当前",
    modelNote: "对之后新建的会话生效;运行中的会话保持原模型。覆盖记录是 run 产物(model-override.json)。",
    s5: "同行评审", notReviewed: "尚未评审", overall: "/10 总分",
    s6: "论文手稿", compiled: "已编译",
    footer: "磁盘产物:state.json · papers.jsonl · metrics.jsonl · transcripts · steering.jsonl · model-override.json —— 面板只读取它们(仅两个写入通道:转向与模型覆盖)。"
  }
};
var LANG = localStorage.getItem("paperlab-lang") || (navigator.language && navigator.language.startsWith("zh") ? "zh" : "en");
function t(k) { return (I18N[LANG] && I18N[LANG][k]) || I18N.en[k]; }
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    var v = t(el.getAttribute("data-i18n"));
    if (typeof v === "string") el.textContent = v;
  });
  $("target").innerHTML = t("targets").map(function (x) { return '<option value="' + x[0] + '">' + x[1] + "</option>"; }).join("");
  $("m-scope").innerHTML = t("scopes").map(function (x) { return '<option value="' + x[0] + '">' + x[1] + "</option>"; }).join("");
  $("text").placeholder = t("steerPh");
  $("lang-toggle").textContent = LANG === "en" ? "中文" : "EN";
  document.documentElement.lang = LANG === "zh" ? "zh" : "en";
}
$("lang-toggle").onclick = function () {
  LANG = LANG === "en" ? "zh" : "en";
  localStorage.setItem("paperlab-lang", LANG);
  applyI18n();
  if (lastState) { renderPhases(lastState.phases); renderSteering(lastState.steering || []); }
};

var lastState = null;
function fmtTs(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString(LANG === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

function renderPhases(phases) {
  $("protocol").innerHTML = phases.map(function (p) {
    var dur = "";
    if (p.startedAt && p.endedAt) dur = " · " + ((new Date(p.endedAt) - new Date(p.startedAt)) / 60000).toFixed(1) + " " + t("min");
    var st = t("status")[p.status] || p.status;
    return '<div class="step ' + p.status + '"><span class="no">' + p.key + "</span>" +
      '<span class="nm">' + (t("phases")[p.key] || p.key) + '</span><br><span class="st">' + st + dur + "</span></div>";
  }).join("");
  var overall = "idle", cls = "idle";
  if (phases.some(function (p) { return p.status === "running"; })) { overall = "running"; cls = "running"; }
  else if (phases.some(function (p) { return p.status === "failed"; })) { overall = "failed"; cls = "failed"; }
  else if (phases.every(function (p) { return p.status === "done"; })) { overall = "done"; cls = "done"; }
  var el = $("runstate"); el.textContent = t("runState")[overall] || overall; el.className = "runstate " + cls;
}

function renderUsage(u) {
  var cost = u.costUsd == null ? "n/a" : "$" + u.costUsd.toFixed(4);
  var totalIn = u.inputTokens + u.cacheReadTokens;
  var hit = totalIn > 0 ? Math.round((u.cacheReadTokens / totalIn) * 100) + "%" : "—";
  $("usage-chip").innerHTML = "tokens <b>" + (u.inputTokens + u.outputTokens).toLocaleString() + "</b> · cache <b>" + hit + "</b> · " + cost;
  $("usage").innerHTML =
    '<div class="stat"><span class="k">' + t("turns") + '</span><span class="v">' + u.turns + "</span></div>" +
    '<div class="stat"><span class="k">' + t("inTok") + '</span><span class="v">' + u.inputTokens.toLocaleString() + "</span></div>" +
    '<div class="stat"><span class="k">' + t("outTok") + '</span><span class="v">' + u.outputTokens.toLocaleString() + "</span></div>" +
    '<div class="stat"><span class="k">cache hit</span><span class="v">' + hit + "</span></div>" +
    '<div class="stat"><span class="k">' + t("cost") + '</span><span class="v">' + cost + "</span></div>";
}

function renderMetrics(ms) {
  var rows = ms.map(function (m) {
    return "<tr><td>" + esc(m.experiment) + "</td><td>" + esc(m.metric) + "</td>" +
      '<td class="num"><span class="val' + (m.value === null ? " fail" : "") + '">' +
      (m.value === null ? t("failedVal") : m.value) + '</span></td><td class="num">' + (m.runs || "") + "</td></tr>";
  }).join("");
  $("metrics").innerHTML = "<thead><tr><th>" + t("exp") + "</th><th>" + t("metric") + '</th><th class=num>' + t("value") + '</th><th class=num>' + t("runs") + "</th></tr></thead><tbody>" +
    (rows || '<tr><td colspan=4 class="empty">' + t("noMetrics") + "</td></tr>") + "</tbody>";
}

function renderActivity(resp) {
  var inflight = (resp.inFlight || []).map(function (x) {
    return '<div class="inflight">' + t("running") + ' <span class="toolname">' + esc(x.tool) + "</span> " + t("on") + " " +
      esc(x.role) + ' <span class="elapsed">' + t("forS") + " " + Math.max(0, Math.round(x.elapsedMs / 1000)) + "s</span></div>";
  }).join("");
  var rows = (resp.activity || []).slice(0, 40).map(function (a) {
    var ts = a.ts ? '<span class="ts">' + fmtTs(a.ts) + "</span>" : "";
    return '<div class="row">' + ts + '<span class="who">' + esc(a.role) + '</span><span class="what ' + a.kind + '">' + esc(a.detail) + "</span></div>";
  }).join("");
  $("activity").innerHTML = inflight + (rows || '<span class="empty">' + t("waiting") + "</span>");
}

function renderSteering(msgs) {
  $("steer-history").innerHTML = msgs.slice(-6).reverse().map(function (m) {
    var state = m.consumedBy.length ? t("delivered") : t("pendingMsg");
    return '<div class="row"><span class="tgt">' + t("to") + " " + esc(m.target) + "</span> · " + esc(m.text.slice(0, 140)) +
      '<br><span class="state' + (m.consumedBy.length ? " delivered" : "") + '">' + state + "</span></div>";
  }).join("") || '<div class="row empty">' + t("noSteer") + "</div>";
}

function renderReview(art) {
  if (!art.meta || !art.meta.decision) return;
  var per = art.reviews.map(function (r) { return esc(r.reviewer.split(" ")[0]) + " " + r.overall + "/10"; }).join(" · ");
  $("review").innerHTML = "<b>" + esc(art.meta.decision) + " — " + art.meta.overall + t("overall") + "</b><br>" +
    '<span class="meta">' + per + "</span>";
  if (art.hasPdf) $("pdf-section").style.display = "";
}

var catalog = null, effective = null;
function renderModel(modelData) {
  if (!modelData) return;
  catalog = modelData.catalog || []; effective = modelData.effective || {};
  if ($("m-provider").dataset.loaded !== "1") {
    $("m-provider").innerHTML = catalog.map(function (c) { return '<option value="' + esc(c.provider) + '">' + esc(c.provider) + "</option>"; }).join("");
    $("m-provider").dataset.loaded = "1";
    syncModels();
  }
  showCurrent();
}
function syncModels() {
  var p = $("m-provider").value;
  var entry = catalog.find(function (c) { return c.provider === p; });
  $("m-model").innerHTML = (entry ? entry.models : []).map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + "</option>"; }).join("");
}
$("m-provider").onchange = syncModels;
function showCurrent() {
  var scope = $("m-scope").value || "default";
  var ref = effective[scope];
  $("m-current").textContent = ref ? t("current") + ": " + ref.provider + " / " + ref.model : "";
}
$("m-scope").onchange = showCurrent;
$("m-apply").onclick = function () {
  fetch("/api/model", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: $("m-scope").value, provider: $("m-provider").value, model: $("m-model").value }),
  }).then(function (r) {
    if (r.ok) { effective[$("m-scope").value] = { provider: $("m-provider").value, model: $("m-model").value }; showCurrent(); }
    return r.json();
  }).then(function (j) { if (j && j.error) alert(j.error); });
};

function poll() {
  Promise.all([
    fetch("/api/state").then(function (r) { return r.json(); }),
    fetch("/api/usage").then(function (r) { return r.json(); }),
    fetch("/api/activity").then(function (r) { return r.json(); }),
    fetch("/api/artifacts").then(function (r) { return r.json(); }),
    fetch("/api/model").then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (rs) {
    var state = rs[0], usage = rs[1], activity = rs[2], artifacts = rs[3], modelData = rs[4];
    lastState = state;
    $("topic").textContent = state.topic;
    $("runroot").textContent = state.runRoot;
    $("clock").textContent = new Date().toLocaleString(LANG === "zh" ? "zh-CN" : "en-US", { hour12: false });
    renderPhases(state.phases);
    renderUsage(usage.totals);
    renderMetrics(artifacts.metrics || []);
    renderActivity(activity);
    renderSteering(state.steering || []);
    renderReview(artifacts);
    renderModel(modelData);
  }).catch(function (e) { $("runstate").textContent = "panel error"; console.error(e); });
}

$("send").onclick = function () {
  var text = $("text").value.trim();
  if (!text) return;
  fetch("/api/steer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: $("target").value, text: text }),
  }).then(function (r) {
    $("steer-status").textContent = r.ok ? t("sent") : "failed (" + r.status + ")";
    if (r.ok) $("text").value = "";
    poll();
  });
};

applyI18n();
poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
