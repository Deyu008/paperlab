import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiteratureTools, extractNumbers } from "../src/tools/literature-tools.ts";
import { computeCoverage } from "../src/tools/coverage.ts";
import { RateLimiter } from "../src/tools/paper-search.ts";
import { RunStore } from "../src/core/run-store.ts";
import type { PaperRecord } from "../src/tools/paper-search.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

let base: string;
let store: RunStore;
const fetchOk = (async () => new Response("{}", { status: 200 })) as typeof fetch;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-lit-"));
  store = RunStore.createNew(base, "test topic", null);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function tools(overrides: Partial<Parameters<typeof createLiteratureTools>[0]> = {}): ToolDefinition[] {
  return createLiteratureTools({
    store,
    maxSearches: 5,
    maxSnowballs: 2,
    maxFullReads: 2,
    fetchImpl: fetchOk,
    arxivLimiter: new RateLimiter(0),
    ...overrides,
  });
}

async function call(tool: ToolDefinition, params: unknown): Promise<string> {
  const result = await tool.execute("call-id", params as never, undefined, undefined, {} as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

function toolByName(list: ToolDefinition[], name: string): ToolDefinition {
  const def = list.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

const ABSTRACT_PAPER = {
  title: "Gradient Boosting Revisited",
  authors: ["Jane Doe"],
  year: 2021,
  venue: "ICML",
  abstract: "We benchmark boosting on 40 datasets and report a 12.5% average gain.",
  arxiv_id: "2101.00001",
  doi: null,
  citation_count: 10,
  tldr: "Boosting benchmark across many datasets.",
  read_status: "abstract" as const,
  found_via: "search",
  note: "Benchmarks boosting on 40 datasets with a 12.5% average gain; method is empirical benchmarking; limitation: no small-data stratification.",
};

describe("save_paper provenance gates", () => {
  it("accepts an abstract-level paper whose numbers are grounded in the abstract", async () => {
    const out = await call(toolByName(tools(), "save_paper"), ABSTRACT_PAPER);
    expect(out).toMatch(/Saved as ABSTRACT/);
    const saved = store.readJsonl<PaperRecord>("01-literature", "papers.jsonl");
    expect(saved[0]).toMatchObject({ read_status: "abstract", found_via: "search" });
  });

  it("rejects numbers absent from the abstract", async () => {
    const out = await call(toolByName(tools(), "save_paper"), {
      ...ABSTRACT_PAPER,
      note: "Claims a 33.7% average gain on benchmarks; limitation unknown.",
    });
    expect(out).toMatch(/not found in the abstract.*33\.7/);
    expect(store.readJsonl("01-literature", "papers.jsonl")).toHaveLength(0);
  });

  it("full read_status requires a prior successful read_paper", async () => {
    const out = await call(toolByName(tools(), "save_paper"), { ...ABSTRACT_PAPER, read_status: "full" });
    expect(out).toMatch(/requires a successful read_paper/);
  });

  it("rejects verbatim-quote mismatches and accepts grounded quotes", async () => {
    const bad = await call(toolByName(tools(), "save_paper"), {
      ...ABSTRACT_PAPER,
      quotes: ["a gain of 99.9 percent on every dataset"],
    });
    expect(bad).toMatch(/quote not found verbatim/);
    const good = await call(toolByName(tools(), "save_paper"), {
      ...ABSTRACT_PAPER,
      quotes: ["report a 12.5% average gain"],
    });
    expect(good).toMatch(/Saved as ABSTRACT/);
  });
});

describe("read_paper + full tier", () => {
  const PAPER_HTML =
    "<html><body><h1>Deep Tabular Study</h1><p>Abstract: we reach 88.8% accuracy.</p>" +
    "<h2>Method</h2><p>MLP with ensembling across 25 seeds. " +
    "We describe the architecture in detail. " + "Additional detail follows. ".repeat(300) + "</p>" +
    "<h2>Results</h2><p>Beats GBDT by 3.1 points on average.</p></body></html>";
  const fetchWithHtml = (async () => new Response(PAPER_HTML, { status: 200 })) as typeof fetch;

  it("read then save(full) grounds numbers in the full text", async () => {
    const list = tools({ fetchImpl: fetchWithHtml });
    const read = await call(toolByName(list, "read_paper"), { arxiv_id: "2401.00009" });
    expect(read).toContain("TOC");
    expect(read).toContain("88.8% accuracy");
    const save = await call(toolByName(list, "save_paper"), {
      title: "Deep Tabular Study",
      authors: ["R. Ai"],
      year: 2024,
      venue: null,
      abstract: "We reach 88.8% accuracy.",
      arxiv_id: "2401.00009",
      doi: null,
      citation_count: 1,
      tldr: null,
      read_status: "full",
      found_via: "search",
      note: "Reports 88.8% accuracy and a 3.1-point average win over GBDT using 25 seeds.",
    });
    expect(save).toMatch(/Saved as FULL/);
    const saved = store.readJsonl<PaperRecord>("01-literature", "papers.jsonl");
    expect(saved[0]!.read_status).toBe("full");
  });

  it("full-read budget counts distinct papers, not pages", async () => {
    const list = tools({ fetchImpl: fetchWithHtml });
    const read = toolByName(list, "read_paper");
    await call(read, { arxiv_id: "2401.00001" });
    await call(read, { arxiv_id: "2401.00001", section: "Method" }); // same paper: free
    await call(read, { arxiv_id: "2401.00002" });
    const blocked = await call(read, { arxiv_id: "2401.00003" });
    expect(blocked).toMatch(/FULL-READ BUDGET EXHAUSTED/);
  });

  it("reports unavailable full text and keeps the audit trail", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as typeof fetch;
    const list = tools({ fetchImpl: notFound });
    const out = await call(toolByName(list, "read_paper"), { arxiv_id: "2101.00009" });
    expect(out).toMatch(/No full text/);
    const audit = store.readJsonl<{ kind: string }>("01-literature", "usage-audit.jsonl");
    expect(audit.some((a) => a.kind === "read_failed")).toBe(true);
  });
});

describe("snowball", () => {
  it("returns ranked citations with found_via tag and audits identities", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/citations")) {
        return new Response(
          JSON.stringify({
            data: [
              { citingPaper: { paperId: "c1", title: "Follower A", citationCount: 30, year: 2024, externalIds: { ArXiv: "2401.00001" } } },
              { citingPaper: { paperId: "c2", title: "Follower B", citationCount: 90, year: 2023, externalIds: { DOI: "10.2/b" } } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const list = tools({ fetchImpl });
    const out = await call(toolByName(list, "snowball"), {
      paper_ref: "2101.00001",
      direction: "forward",
    });
    expect(out).toContain("2 forward papers");
    expect(out).toContain("Follower B"); // higher citations first
    const audit = store.readJsonl<{ kind: string; returned: string[] }>("01-literature", "usage-audit.jsonl");
    const record = audit.find((a) => a.kind === "snowball");
    expect(record?.returned).toHaveLength(2);
  });

  it("enforces its own budget", async () => {
    const list = tools();
    const sb = toolByName(list, "snowball");
    await call(sb, { paper_ref: "2101.00001", direction: "forward" });
    await call(sb, { paper_ref: "2101.00001", direction: "backward" });
    const third = await call(sb, { paper_ref: "2101.00001", direction: "forward" });
    expect(third).toMatch(/SNOWBALL BUDGET EXHAUSTED/);
  });
});

describe("coverage computation", () => {
  it("computes funnel stats and warnings from the audit log", async () => {
    const list = tools({ fetchImpl: fetchOk });
    await call(toolByName(list, "search_papers"), { query: "ensembles" });
    await call(toolByName(list, "snowball"), { paper_ref: "2101.00001", direction: "forward" });
    await call(toolByName(list, "save_paper"), ABSTRACT_PAPER);

    const coverage = computeCoverage(store);
    expect(coverage.searches.total).toBe(1);
    expect(coverage.snowballs.total).toBe(1);
    expect(coverage.funnel.saved).toBe(1);
    expect(coverage.reads.attempts).toBe(0);
    expect(coverage.warnings.length).toBeGreaterThan(0);
    expect(coverage.warnings.join(" ")).toMatch(/citation snowballing|full-text tier/);
  });

  it("marks non-snowball papers without graph overlap as orphans", () => {
    store.appendJsonl("01-literature", "usage-audit.jsonl", {
      ts: "t",
      kind: "snowball",
      paper_ref: "arXiv:1",
      direction: "forward",
      returned: ["doi:10.1/known"],
    });
    store.appendJsonl("01-literature", "papers.jsonl", {
      title: "Unconnected Paper", authors: ["A"], year: 2020, venue: null,
      abstract: null, arxiv_id: null, doi: "10.9/other", citation_count: 0,
      source: "semantic-scholar", note: "n", bibtex: "b",
      read_status: "abstract", tldr: null, found_via: "search", quotes: [],
    });
    const coverage = computeCoverage(store);
    expect(coverage.funnel.orphans).toEqual(["Unconnected Paper"]);
  });
});

describe("extractNumbers", () => {
  it("extracts meaningful numbers, excludes years", () => {
    expect(extractNumbers("gained 12.5% over 40 datasets since 2021 (see 3,000 runs)")).toEqual([
      "12.5%",
      "40",
      "3,000",
    ]);
  });
});
