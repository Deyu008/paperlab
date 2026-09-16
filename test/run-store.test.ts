import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, slugify } from "../src/core/run-store.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-test-"));
  return () => rmSync(base, { recursive: true, force: true });
});

describe("slugify", () => {
  it("produces filesystem-safe slugs", () => {
    expect(slugify("LoRA Fine-Tuning: A Study of Rank")).toBe("lora-fine-tuning-a-study-of-rank");
    expect(slugify("  🚀 emoji & symbols!! ")).not.toMatch(/[^a-z0-9-]/);
    expect(slugify("")).toBe("run");
  });
});

describe("RunStore", () => {
  it("creates a new run with state.json", () => {
    const store = RunStore.createNew(base, "graph neural networks", null);
    const state = JSON.parse(readFileSync(join(store.root, "state.json"), "utf8"));
    expect(state.topic).toBe("graph neural networks");
    expect(state.phases).toEqual({});
    expect(store.describe()).toContain("graph neural networks");
  });

  it("round-trips phase checkpoints and jsonl artifacts", () => {
    const store = RunStore.createNew(base, "topic", null);
    store.updatePhase("01-literature", "running");
    store.updatePhase("01-literature", "done");
    expect(store.isPhaseDone("01-literature")).toBe(true);

    store.appendJsonl("01-literature", "papers.jsonl", { title: "a" });
    store.appendJsonl("01-literature", "papers.jsonl", { title: "b" });
    expect(store.readJsonl("01-literature", "papers.jsonl")).toEqual([
      { title: "a" },
      { title: "b" },
    ]);

    const reopened = RunStore.open(store.root);
    expect(reopened.topic).toBe("topic");
    expect(reopened.isPhaseDone("01-literature")).toBe(true);
    expect(reopened.readJsonl("01-literature", "papers.jsonl")).toHaveLength(2);
  });

  it("counts attempts across retries", () => {
    const store = RunStore.createNew(base, "topic", null);
    store.updatePhase("03-experiment", "running");
    store.updatePhase("03-experiment", "failed");
    store.updatePhase("03-experiment", "running");
    const phase = store.state.phases["03-experiment"];
    expect(phase?.attempts).toBe(2);
    expect(phase?.status).toBe("running");
  });

  it("writes and reads text artifacts", () => {
    const store = RunStore.createNew(base, "topic", null);
    store.writeText("04-interpret", "findings.md", "# Findings\n");
    expect(store.readText("04-interpret", "findings.md")).toBe("# Findings\n");
    expect(store.readText("04-interpret", "missing.md")).toBeNull();
  });

  it("rejects non-run directories", () => {
    expect(() => RunStore.open(join(base, "nowhere"))).toThrow(/not a paperlab run directory/);
  });
});
