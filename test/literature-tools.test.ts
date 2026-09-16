import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiteratureTools } from "../src/tools/literature-tools.ts";
import { RunStore } from "../src/core/run-store.ts";
import type { PaperRecord } from "../src/tools/paper-search.ts";

let base: string;
let store: RunStore;
const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-lit-"));
  store = RunStore.createNew(base, "test topic", null);
  return () => rmSync(base, { recursive: true, force: true });
});

async function call(tool: "search_papers" | "save_paper" | "save_review", params: unknown): Promise<string> {
  const tools = createLiteratureTools({ store, maxSearches: 2, fetchImpl });
  return callOn(tools, tool, params);
}

/** Search budget is phase-scoped state — tests that count calls must reuse one toolset. */
async function callOn(
  tools: ReturnType<typeof createLiteratureTools>,
  tool: "search_papers" | "save_paper" | "save_review",
  params: unknown,
): Promise<string> {
  const def = tools.find((t) => t.name === tool);
  if (!def) throw new Error(`tool ${tool} not found`);
  const result = await def.execute("call-id", params as never, undefined, undefined, {} as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

const goodPaper = {
  title: "Gradient Boosting Revisited",
  authors: ["Jane Doe", "John Roe"],
  year: 2021,
  venue: "ICML",
  abstract: "We study gradient boosting.",
  arxiv_id: "2101.1",
  doi: null,
  citation_count: 10,
  note: "Claims boosted trees remain SOTA on tabular data; method is empirical benchmarking; limitation: small datasets only.",
};

describe("save_paper", () => {
  it("accepts a well-formed paper and generates bibtex", async () => {
    const out = await call("save_paper", goodPaper);
    expect(out).toMatch(/Saved \(1 total\)/);
    const saved = store.readJsonl<PaperRecord>("01-literature", "papers.jsonl");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.bibtex).toContain("@article{doe2021gradient");
    expect(saved[0]?.bibtex).toContain("eprint = {2101.1}");
  });

  it("rejects duplicates by title identity", async () => {
    await call("save_paper", goodPaper);
    const out = await call("save_paper", { ...goodPaper, note: goodPaper.note + " Still the same paper." });
    expect(out).toMatch(/duplicate/i);
    expect(store.readJsonl<PaperRecord>("01-literature", "papers.jsonl")).toHaveLength(1);
  });

  it("rejects thin notes and empty authors", async () => {
    expect(await call("save_paper", { ...goodPaper, note: "ok paper" })).toMatch(/note too short/i);
    expect(await call("save_paper", { ...goodPaper, authors: [] })).toMatch(/authors/i);
  });
});

describe("search_papers budget", () => {
  it("enforces the search budget", async () => {
    const tools = createLiteratureTools({ store, maxSearches: 2, fetchImpl });
    const first = await callOn(tools, "search_papers", { query: "a" });
    expect(first).toContain("Searches used: 1/2");
    const second = await callOn(tools, "search_papers", { query: "b" });
    expect(second).toContain("Searches used: 2/2");
    const third = await callOn(tools, "search_papers", { query: "c" });
    expect(third).toContain("SEARCH BUDGET EXHAUSTED");
  });
});

describe("save_review", () => {
  it("accepts a substantive review and stores it", async () => {
    const markdown = "# Related work\n\n" + "word ".repeat(80);
    const out = await call("save_review", { markdown });
    expect(out).toMatch(/Review saved/);
    expect(store.readText("01-literature", "related_work.md")).toContain("# Related work");
  });

  it("rejects a too-short review", async () => {
    expect(await call("save_review", { markdown: "short" })).toMatch(/too short/i);
  });
});
