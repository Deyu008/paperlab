/**
 * Embedded dashboard page for `paperlab watch` — a "living paper" aesthetic:
 * paper-white, serif headings, booktabs tables, protocol-style pipeline.
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
  body {
    margin: 0; color: var(--ink);
    font: 15px/1.55 "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
  .wrap { max-width: 1140px; margin: 0 auto; padding: 28px 32px 64px; }

  /* masthead — journal style */
  header { border-bottom: 2px solid var(--rule-strong); padding-bottom: 14px; margin-bottom: 6px; }
  .masthead { display: flex; justify-content: space-between; align-items: baseline; }
  .brand { font-variant: small-caps; letter-spacing: .18em; font-size: 14px; color: var(--muted); }
  .brand b { color: var(--ink); font-weight: 600; }
  .runstate { font-variant: small-caps; letter-spacing: .14em; font-size: 13px; }
  .runstate.running { color: var(--warn); } .runstate.done { color: var(--good); }
  .runstate.failed { color: var(--bad); } .runstate.idle { color: var(--muted); }
  h1.title { font: italic 700 24px/1.3 Charter, Cambria, Georgia, serif; margin: 10px 0 4px; }
  .meta { color: var(--muted); font-size: 13.5px; }
  .meta .mono { color: var(--muted); }

  /* protocol steps */
  .protocol { display: flex; flex-wrap: wrap; gap: 0; margin: 18px 0 26px; }
  .step { flex: 1 1 150px; min-width: 150px; padding: 10px 12px 12px; border-top: 3px solid var(--rule); position: relative; }
  .step .no { font-variant: small-caps; letter-spacing: .12em; color: var(--muted); font-size: 11.5px; display:block; }
  .step .nm { font-size: 14px; }
  .step .st { font-size: 12px; color: var(--muted); }
  .step.done { border-top-color: var(--good); } .step.done .st { color: var(--good); }
  .step.running { border-top-color: var(--warn); background: var(--tint-warn); }
  .step.running .st { color: var(--warn); } .step.running .st::after { content: " ●"; animation: blink 1.2s infinite; }
  .step.failed { border-top-color: var(--bad); background: var(--tint-bad); } .step.failed .st { color: var(--bad); }
  @keyframes blink { 50% { opacity: .2; } }

  /* sections — numbered like a paper */
  section { margin-top: 30px; }
  h2 {
    font: 600 15px Charter, Cambria, Georgia, serif; margin: 0 0 4px;
    border-bottom: 1px solid var(--rule); padding-bottom: 6px;
  }
  h2 .sn { color: var(--muted); font-weight: 400; margin-right: 10px; }
  h2 .aside { float: right; font-weight: 400; color: var(--muted); font-size: 12.5px; }

  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 34px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }

  /* booktabs tables */
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  thead th { border-top: 2px solid var(--rule-strong); border-bottom: 1px solid var(--rule-strong); text-align: left; padding: 6px 10px; font-weight: 600; }
  tbody td { padding: 5px 10px; border-bottom: 0; }
  tbody tr:last-child td { border-bottom: 2px solid var(--rule-strong); }
  tbody tr:nth-child(even) { background: #f4f2ec; }
  td.num, th.num { text-align: right; }
  .val { color: var(--good); font-weight: 600; } .val.fail { color: var(--bad); }

  .stats { display: flex; gap: 26px; flex-wrap: wrap; margin-top: 10px; }
  .stat .k { font-variant: small-caps; letter-spacing: .1em; font-size: 11.5px; color: var(--muted); display: block; }
  .stat .v { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16px; }

  /* lab log */
  .log { border-left: 2px solid var(--rule); margin-left: 4px; padding-left: 18px; max-height: 300px; overflow-y: auto; }
  .log .row { margin: 7px 0; font-size: 13px; }
  .log .who { font-variant: small-caps; letter-spacing: .08em; color: var(--accent); font-size: 12px; margin-right: 8px; }
  .log .what { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--ink); }
  .log .what.tool { color: #3b5c97; }

  /* intervention */
  .intervene textarea {
    width: 100%; min-height: 72px; background: var(--card); color: var(--ink);
    border: 1px solid var(--rule); border-radius: 2px; padding: 9px 11px; font: 14px Charter, Cambria, Georgia, serif;
  }
  .intervene select, .intervene button {
    background: var(--card); color: var(--ink); border: 1px solid var(--ink);
    border-radius: 2px; padding: 6px 14px; font: 13.5px Charter, Cambria, Georgia, serif;
  }
  .intervene button.primary { background: var(--ink); color: var(--paper); font-weight: 600; cursor: pointer; }
  .intervene button.primary:hover { background: #000; }
  .formrow { display: flex; gap: 10px; margin-top: 9px; align-items: center; flex-wrap: wrap; }
  .status { font-size: 12.5px; color: var(--muted); font-style: italic; }
  .hist { margin-top: 14px; }
  .hist .row { padding: 6px 0; border-top: 1px dotted var(--rule); font-size: 13px; }
  .hist .tgt { font-variant: small-caps; letter-spacing: .08em; color: var(--warn); font-size: 11.5px; }
  .hist .state { font-size: 11.5px; color: var(--muted); }
  .hist .state.delivered { color: var(--good); }

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
      <div class="brand"><b>paperlab</b> · automated research pipeline</div>
      <div class="runstate idle" id="runstate">—</div>
    </div>
    <h1 class="title" id="topic">loading…</h1>
    <div class="meta">run <span class="mono" id="runroot"></span> · <span class="mono" id="clock"></span></div>
  </header>

  <div class="protocol" id="protocol"></div>

  <section>
    <h2><span class="sn">1</span>Results — recorded metrics (ground truth for every number in the paper)</h2>
    <div style="max-height:300px; overflow:auto"><table id="metrics"></table></div>
    <div class="stats" id="usage"></div>
  </section>

  <div class="cols" style="margin-top:30px">
    <section>
      <h2><span class="sn">2</span>Experimental log<span class="aside">live</span></h2>
      <div class="log" id="activity"><span class="empty">waiting for activity…</span></div>
    </section>
    <section class="intervene">
      <h2><span class="sn">3</span>Operator intervention</h2>
      <div class="meta" style="margin-bottom:8px">Messages are injected into the agent's next turn or tool result — at most one turn of latency.</div>
      <select id="target">
        <option value="any">all agents — next prompt, any phase</option>
        <option value="03-experiment">03 · experiment (ml engineer)</option>
        <option value="05-paper">05 · paper (writer)</option>
        <option value="02-plan">02 · plan (postdoc & phd)</option>
        <option value="06-review">06 · review (reviewers & AC)</option>
        <option value="mlengineer">any phase · role: ml engineer</option>
        <option value="writer">any phase · role: writer</option>
        <option value="postdoc">any phase · role: postdoc</option>
      </select>
      <textarea id="text" placeholder="e.g. The n=1000 stratum is eating the budget with no new signal — drop it and double the seeds at n=100 instead."></textarea>
      <div class="formrow">
        <button class="primary" id="send">Send instruction</button>
        <span class="status" id="steer-status"></span>
      </div>
      <div class="hist" id="steer-history"></div>
    </section>
  </div>

  <section>
    <h2><span class="sn">4</span>Peer review</h2>
    <div class="verdict" id="review"><span class="empty">not reviewed yet</span></div>
  </section>

  <section id="pdf-section" style="display:none">
    <h2><span class="sn">5</span>Manuscript<span class="aside">compiled</span></h2>
    <iframe id="pdf" src="/api/paper"></iframe>
  </section>

  <footer>artifacts on disk: state.json · papers.jsonl · metrics.jsonl · transcripts · steering.jsonl — the panel only reads them (plus the one write path: steering).</footer>
</div>
<script>
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
var NAMES = { "01-literature": "Literature", "02-plan": "Plan", "03-experiment": "Experiment", "04-interpret": "Interpretation", "05-paper": "Writing", "06-review": "Review" };
var lastData = null;

function renderPhases(phases) {
  $("protocol").innerHTML = phases.map(function (p) {
    var dur = "";
    if (p.startedAt && p.endedAt) {
      dur = " · " + ((new Date(p.endedAt) - new Date(p.startedAt)) / 1000 / 60).toFixed(1) + " min";
    }
    return '<div class="step ' + p.status + '"><span class="no">' + p.key + "</span>" +
      '<span class="nm">' + NAMES[p.key] + '</span><br><span class="st">' + p.status + dur + "</span></div>";
  }).join("");
  var overall = "idle", cls = "idle";
  if (phases.some(function (p) { return p.status === "running"; })) { overall = "running"; cls = "running"; }
  else if (phases.some(function (p) { return p.status === "failed"; })) { overall = "halted"; cls = "failed"; }
  else if (phases.every(function (p) { return p.status === "done"; })) { overall = "complete"; cls = "done"; }
  var el = $("runstate"); el.textContent = "run " + overall; el.className = "runstate " + cls;
}

function renderUsage(u) {
  $("usage").innerHTML =
    '<div class="stat"><span class="k">llm turns</span><span class="v">' + u.totals.turns + "</span></div>" +
    '<div class="stat"><span class="k">input tokens</span><span class="v">' + u.totals.inputTokens.toLocaleString() + "</span></div>" +
    '<div class="stat"><span class="k">output tokens</span><span class="v">' + u.totals.outputTokens.toLocaleString() + "</span></div>" +
    '<div class="stat"><span class="k">est. cost</span><span class="v">' + (u.totals.costUsd == null ? "n/a" : "$" + u.totals.costUsd.toFixed(4)) + "</span></div>";
}

function renderMetrics(ms) {
  var rows = ms.map(function (m) {
    return "<tr><td>" + esc(m.experiment) + "</td><td>" + esc(m.metric) + "</td>" +
      '<td class="num"><span class="val' + (m.value === null ? " fail" : "") + '">' +
      (m.value === null ? "failed" : m.value) + '</span></td><td class="num">' + (m.runs || "") + "</td></tr>";
  }).join("");
  $("metrics").innerHTML = "<thead><tr><th>experiment</th><th>metric</th><th class=num>value</th><th class=num>runs</th></tr></thead><tbody>" +
    (rows || '<tr><td colspan=4 class="empty">no metrics recorded yet</td></tr>') + "</tbody>";
}

function renderActivity(list) {
  $("activity").innerHTML = list.slice(0, 40).map(function (a) {
    return '<div class="row"><span class="who">' + esc(a.role) + '</span><span class="what ' + a.kind + '">' + esc(a.detail) + "</span></div>";
  }).join("") || '<span class="empty">waiting for activity…</span>';
}

function renderSteering(msgs) {
  $("steer-history").innerHTML = msgs.slice(-6).reverse().map(function (m) {
    var state = m.consumedBy.length ? "delivered ✓" : "pending — delivered on next turn";
    return '<div class="row"><span class="tgt">to ' + esc(m.target) + "</span> · " + esc(m.text.slice(0, 140)) +
      '<br><span class="state ' + (m.consumedBy.length ? "delivered" : "") + '">' + state + "</span></div>";
  }).join("") || '<div class="row empty">no interventions yet</div>';
}

function renderReview(art) {
  if (!art.meta || !art.meta.decision) return;
  var per = art.reviews.map(function (r) { return esc(r.reviewer.split(" ")[0]) + " " + r.overall + "/10"; }).join(" · ");
  $("review").innerHTML = "<b>" + esc(art.meta.decision) + " — " + art.meta.overall + "/10 overall</b><br>" +
    '<span class="meta">' + per + "</span>";
  if (art.hasPdf) $("pdf-section").style.display = "";
}

function poll() {
  Promise.all([
    fetch("/api/state").then(function (r) { return r.json(); }),
    fetch("/api/usage").then(function (r) { return r.json(); }),
    fetch("/api/activity").then(function (r) { return r.json(); }),
    fetch("/api/artifacts").then(function (r) { return r.json(); }),
  ]).then(function (rs) {
    var state = rs[0], usage = rs[1], activity = rs[2], artifacts = rs[3];
    lastData = state;
    $("topic").textContent = state.topic;
    $("runroot").textContent = state.runRoot;
    $("clock").textContent = new Date().toLocaleTimeString();
    renderPhases(state.phases);
    renderUsage(usage);
    renderMetrics(artifacts.metrics || []);
    renderActivity(activity.activity || []);
    renderSteering(state.steering || []);
    renderReview(artifacts);
  }).catch(function (e) { $("runstate").textContent = "panel error"; console.error(e); });
}

$("send").onclick = function () {
  var text = $("text").value.trim();
  if (!text) return;
  $("steer-status").textContent = "sending…";
  fetch("/api/steer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: $("target").value, text: text }),
  }).then(function (r) {
    $("steer-status").textContent = r.ok ? "in the mailbox — delivered on the next turn ✓" : "failed (" + r.status + ")";
    if (r.ok) $("text").value = "";
    poll();
  });
};

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
