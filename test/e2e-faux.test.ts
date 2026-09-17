/**
 * End-to-end pipeline integration test with a faux LLM provider.
 *
 * Everything is real except the model: real pi sessions, real tools, real
 * rate-limited search (network stubbed), real sandbox python, real store and
 * checkpoints. Phases 1-4 run; phases 5-6 need LaTeX and are exercised by
 * their unit tests + the live demo.
 *
 * The faux provider serves one FIFO response queue across all sessions, so
 * the scripted responses encode the exact turn order of the pipeline.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  fauxToolCall,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerExtraModel, clearExtraModels } from "../src/core/models.ts";
import { setAgentRuntimeOverride } from "../src/core/agent.ts";
import { buildPipeline } from "../src/phases/index.ts";
import { RunStore } from "../src/core/run-store.ts";
import { loadConfig } from "../src/config.ts";

const PROVIDER = "faux-e2e";
const MODEL_ID = "test-model";

let base: string;
let faux: ReturnType<typeof fauxProvider>;
let runtime: ModelRuntime;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "paperlab-e2e-"));
  faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL_ID }] });
  runtime = await ModelRuntime.create();
  runtime.registerNativeProvider(faux.provider);
  registerExtraModel({ provider: PROVIDER, model: MODEL_ID }, faux.getModel());
  setAgentRuntimeOverride(runtime);
});

afterAll(() => {
  setAgentRuntimeOverride(null);
  clearExtraModels();
  if (base && !process.env.PAPERLAB_E2E_DEBUG) rmSync(base, { recursive: true, force: true });
  else if (base) console.log("E2E DEBUG store base kept:", base);
});

// -- scripted conversation ---------------------------------------------------

const PAPERS = [
  { paperId: "s2-1", title: "Gradient Boosting Machines for Tabular Data", authors: [{ name: "Jane Doe" }], year: 2021, venue: "ICML", abstract: "A benchmark study.", externalIds: { ArXiv: "2101.00001", DOI: "10.1/p1" }, citationCount: 40 },
  { paperId: "s2-2", title: "Deep Learning on Tabular Problems", authors: [{ name: "Alan Roe" }], year: 2022, venue: "NeurIPS", abstract: "MLP vs GBDT.", externalIds: { ArXiv: "2201.00002", DOI: "10.1/p2" }, citationCount: 30 },
  { paperId: "s2-3", title: "Ensemble Methods Reconsidered", authors: [{ name: "Ravi Patel" }], year: 2023, venue: "KDD", abstract: "When ensembles help.", externalIds: { ArXiv: "2301.00003", DOI: "10.1/p3" }, citationCount: 12 },
];

function savePaperCall(i: number) {
  const p = PAPERS[i]!;
  const isFull = i === 2; // third paper goes through the full-text funnel
  return fauxToolCall("save_paper", {
    title: p.title,
    authors: p.authors.map((a: { name: string }) => a.name),
    year: p.year,
    venue: p.venue,
    abstract: p.abstract,
    arxiv_id: p.externalIds.ArXiv,
    doi: p.externalIds.DOI,
    citation_count: p.citationCount,
    tldr: null,
    read_status: isFull ? "full" : "abstract",
    found_via: isFull ? "search" : "search",
    quotes: [],
    note: isFull
      ? "Reports 87.3% accuracy for ensembles in the small regime; method is benchmarking; limitation: synthetic focus."
      : `Claims ${p.abstract} Method is benchmarking. Limitation: only large datasets, not the small-data regime we study.`,
  });
}

const REVIEW_MD =
  "# Related work\n\n" +
  PAPERS.map((p) => `- **${p.title}** — ${p.abstract} Limitation: not evaluated on small tabular datasets.`).join("\n") +
  "\n\n## Closest prior work\n\nEnsemble Methods Reconsidered is the closest prior work; our study differs by isolating the small-data regime with variance reporting.";

const PLAN = {
  research_question: "Do bagged ensembles beat single gradient boosting on small tabular datasets?",
  hypothesis: "Bagging reduces variance enough to win below 5000 rows.",
  novelty:
    "Unlike \"Gradient Boosting Machines for Tabular Data\" and \"Ensemble Methods Reconsidered\", which benchmark large datasets, we isolate the small-data regime with seed variance.",
  experiments: [
    {
      name: "small-data-benchmark",
      purpose: "Compare bagged vs single GBDT at several sample sizes",
      procedure: "Train sklearn models on synthetic data with 5 seeds at n=500..5000",
      dataset: "sklearn make_classification (synthetic, seeded)",
      metric: "mean ROC-AUC (higher better)",
      target: "bagged wins by >= 0.01 AUC at n<=5000",
      fallback: "if not, report the crossover point",
    },
  ],
  success_criteria: "Clear win/lose with variance across sizes",
  risks: ["synthetic data may not transfer", "seed count limited by budget"],
};

const EXP_PY = `import json, os
os.makedirs("data", exist_ok=True)
records = [
  {"experiment": "small-data-benchmark", "metric": "roc_auc_bagged", "value": 0.81, "higher_is_better": True, "n": 500, "notes": "bagged, 5 seeds"},
  {"experiment": "small-data-benchmark", "metric": "roc_auc_single", "value": 0.79, "higher_is_better": True, "n": 500, "notes": "single, 5 seeds"},
]
with open("metrics.jsonl", "a") as f:
    for r in records:
        f.write(json.dumps(r) + "\\n")
with open("data/auc_by_size.csv", "w") as f:
    f.write("n,model,auc\\n500,bagged,0.81\\n500,single,0.79\\n")
print("experiment complete")
`;

const FINDINGS_MD =
  "# Findings\n\n" +
  "The small-data-benchmark experiment recorded ROC-AUC 0.81 (bagged) vs 0.79 (single) at n=500. " +
  "Interpretation: bagging's variance reduction helps in the small-data regime, consistent with the hypothesis, " +
  "though the margin (0.02) is modest and only one sample size was run. " +
  "Limitations: synthetic data, single size, 5 seeds. Numbers are quoted verbatim from the metrics table.";

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/citations")) {
      return new Response(
        JSON.stringify({
          data: [
            { citingPaper: { paperId: "c1", title: "A Citing Competitor", citationCount: 15, year: 2025, externalIds: { ArXiv: "2501.00007" } } },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("arxiv.org/html") || u.includes("ar5iv")) {
      return new Response(
        "<html><body><h1>Ensemble Methods Reconsidered</h1>" +
        "<p>Abstract: ensembles help with 87.3% accuracy in the small regime.</p>" +
        "<h2>Method</h2><p>" +
        "Experimental detail. ".repeat(200) +
        "</p></body></html>",
        { status: 200 },
      );
    }
    if (u.includes("semanticscholar")) {
      return new Response(JSON.stringify({ data: PAPERS }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("pipeline e2e (faux LLM, real tools)", () => {
  it("runs phases 1-4 end to end with checkpoints", { timeout: 180_000 }, async () => {
    faux.setResponses([
      // Phase 1 — PhD literature review.
      fauxAssistantMessage([fauxToolCall("search_papers", { query: "gradient boosting tabular", limit: 5 })]),
      fauxAssistantMessage([fauxToolCall("read_paper", { arxiv_id: "2301.00003" })]),
      fauxAssistantMessage([fauxToolCall("snowball", { paper_ref: "arXiv:2301.00003", direction: "forward" })]),
      fauxAssistantMessage([savePaperCall(0), savePaperCall(1), savePaperCall(2)]),
      fauxAssistantMessage([fauxToolCall("save_review", { markdown: REVIEW_MD })]),
      fauxAssistantMessage("Literature review complete."),
      // Phase 2 — dialogue (phd opening, postdoc critique, phd refinement, postdoc submits).
      fauxAssistantMessage("Proposal: benchmark bagged vs single GBDT on small tabular data."),
      fauxAssistantMessage("Critique: define 'small', add seed variance and a success threshold."),
      fauxAssistantMessage("Revised: n=500..5000, 5 seeds, target +0.01 AUC."),
      fauxAssistantMessage([fauxToolCall("submit_plan", { plan_json: JSON.stringify(PLAN) })]),
      fauxAssistantMessage("Plan accepted."),
      // Phase 3 — ML engineer writes and runs the experiment.
      fauxAssistantMessage([fauxToolCall("write_file", { path: "exp1.py", content: EXP_PY })]),
      fauxAssistantMessage([fauxToolCall("run_python", { path: "exp1.py" })]),
      fauxAssistantMessage("Experiments done, metrics recorded."),
      // Phase 4 — postdoc interprets.
      fauxAssistantMessage([fauxToolCall("save_findings", { markdown: FINDINGS_MD })]),
      fauxAssistantMessage("Findings saved."),
    ]);

    const { config } = loadConfig("");
    config.sandbox = "local"; // hermetic test: no docker pull
    config.models.default = { provider: PROVIDER, model: MODEL_ID };

    const store = RunStore.createNew(base, "bagged ensembles on small tabular data", null);
    if (process.env.PAPERLAB_E2E_DEBUG) console.log("E2E store root:", store.root);
    const pipeline = buildPipeline();
    await pipeline.run(
      { config, store, log: () => {}, copilotNotes: new Map() },
      { only: ["01-literature", "02-plan", "03-experiment", "04-interpret"] },
    );

    // Phase 1 artifacts.
    const papers = store.readJsonl<Record<string, unknown>>("01-literature", "papers.jsonl");
    expect(papers).toHaveLength(3);
    const bib = readFileSync(join(store.root, "01-literature", "references.bib"), "utf8");
    expect(bib).toContain("@article{doe2021gradient");
    expect(existsSync(join(store.root, "01-literature", "related_work.md"))).toBe(true);
    const savedPapers = store.readJsonl<{ read_status: string }>("01-literature", "papers.jsonl");
    expect(savedPapers.filter((x) => x.read_status === "full")).toHaveLength(1);
    const audit = store.readJsonl<{ kind: string }>("01-literature", "usage-audit.jsonl");
    expect(audit.some((a) => a.kind === "read_ok")).toBe(true);
    expect(audit.some((a) => a.kind === "snowball")).toBe(true);
    expect(existsSync(join(store.root, "01-literature", "coverage-report.json"))).toBe(true);

    // Phase 2 artifacts.
    const plan = JSON.parse(readFileSync(join(store.root, "02-plan", "plan.json"), "utf8"));
    expect(plan.experiments).toHaveLength(1);
    expect(plan.novelty).toContain("Gradient Boosting Machines");

    // Phase 3 artifacts: real python really ran in the sandbox.
    const metricsRaw = readFileSync(join(store.root, "03-experiment", "metrics.jsonl"), "utf8");
    expect(metricsRaw).toContain("roc_auc");
    const metrics = JSON.parse(readFileSync(join(store.root, "03-experiment", "metrics.json"), "utf8"));
    expect(metrics.metrics).toHaveLength(2);
    const bagged = metrics.metrics.find((m: Record<string, unknown>) => m.metric === "roc_auc_bagged");
    expect(bagged).toMatchObject({ experiment: "small-data-benchmark", value: 0.81, runs: 1 });
    expect(existsSync(join(store.root, "03-experiment", "workspace", "data", "auc_by_size.csv"))).toBe(true);
    expect(existsSync(join(store.root, "03-experiment", "workspace", "exp1.py"))).toBe(true);

    // Phase 4 artifacts.
    const findings = readFileSync(join(store.root, "04-interpret", "findings.md"), "utf8");
    expect(findings).toContain("small-data-benchmark");

    // Checkpoints: 1-4 done, 5-6 untouched; resume reopens.
    const state = store.state;
    for (const key of ["01-literature", "02-plan", "03-experiment", "04-interpret"]) {
      expect(state.phases[key]?.status).toBe("done");
    }
    expect(state.phases["05-paper"]).toBeUndefined();
    const reopened = RunStore.open(store.root);
    expect(reopened.isPhaseDone("03-experiment")).toBe(true);
  });
});
