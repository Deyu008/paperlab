import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/orchestrator.ts";
import { RunStore } from "../src/core/run-store.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

function makeContext(base: string) {
  const store = RunStore.createNew(base, "test topic", null);
  return {
    config: structuredClone(DEFAULT_CONFIG),
    store,
    log: () => {},
    copilotNotes: new Map<string, string>(),
  };
}

describe("Pipeline", () => {
  it("runs phases in order and checkpoints each", async () => {
    const base = mkdtemp();
    const order: string[] = [];
    const pipeline = new Pipeline([
      { key: "a", name: "A", dependsOn: [], run: () => { order.push("a"); return Promise.resolve(); } },
      { key: "b", name: "B", dependsOn: ["a"], run: () => { order.push("b"); return Promise.resolve(); } },
    ]);
    const ctx = makeContext(base);
    await pipeline.run(ctx);
    expect(order).toEqual(["a", "b"]);
    expect(ctx.store.isPhaseDone("a")).toBe(true);
    expect(ctx.store.isPhaseDone("b")).toBe(true);
  });

  it("skips done phases on resume", async () => {
    const base = mkdtemp();
    let runs = 0;
    const pipeline = new Pipeline([
      { key: "a", name: "A", dependsOn: [], run: () => { runs++; return Promise.resolve(); } },
      { key: "b", name: "B", dependsOn: ["a"], run: () => Promise.resolve() },
    ]);
    const ctx = makeContext(base);
    ctx.store.updatePhase("a", "done");
    await pipeline.run(ctx);
    expect(runs).toBe(0);
  });

  it("re-runs done phases with force", async () => {
    const base = mkdtemp();
    let runs = 0;
    const pipeline = new Pipeline([
      { key: "a", name: "A", dependsOn: [], run: () => { runs++; return Promise.resolve(); } },
    ]);
    const ctx = makeContext(base);
    ctx.store.updatePhase("a", "done");
    await pipeline.run(ctx, { force: true });
    expect(runs).toBe(1);
  });

  it("marks failed phases and wraps the error", async () => {
    const base = mkdtemp();
    const pipeline = new Pipeline([
      {
        key: "a",
        name: "A",
        dependsOn: [],
        run: () => Promise.reject(new Error("boom")),
      },
    ]);
    const ctx = makeContext(base);
    await expect(pipeline.run(ctx)).rejects.toThrow(/phase a failed: boom/);
    expect(ctx.store.state.phases["a"]?.status).toBe("failed");
  });

  it("refuses to run a phase with unfinished dependencies", async () => {
    const base = mkdtemp();
    const pipeline = new Pipeline([
      { key: "a", name: "A", dependsOn: [], run: () => Promise.resolve() },
      { key: "b", name: "B", dependsOn: ["a"], run: () => Promise.resolve() },
    ]);
    const ctx = makeContext(base);
    await expect(pipeline.run(ctx, { only: ["b"] })).rejects.toThrow(
      /unfinished dependencies: a/,
    );
  });

  it("rejects registration with unknown dependencies", () => {
    expect(
      () => new Pipeline([{ key: "x", name: "X", dependsOn: ["ghost"], run: () => Promise.resolve() }]),
    ).toThrow(/unknown phase ghost/);
  });
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "paperlab-pipe-"));
}

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { normalizeMispathedArtifacts } from "../src/phases/5-paper.ts";

describe("normalizeMispathedArtifacts (writer path-confusion self-heal)", () => {
  it("adopts mispathed tex and fig/bootstrap scripts, leaves scaffolding behind", () => {
    const base = mkdtemp();
    try {
      const ctx = makeContext(base);
      const root = ctx.store.root;
      mkdirSync(join(root, "tex"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "tex", "main.tex"), "\\documentclass{article}");
      writeFileSync(join(root, "scripts", "fig_auc.py"), "# fig");
      writeFileSync(join(root, "scripts", "bootstrap_env.py"), "# pip");
      writeFileSync(join(root, "scripts", "patch_tex.py"), "# one-shot patch — must NOT be adopted");

      normalizeMispathedArtifacts(ctx);

      expect(existsSync(join(root, "05-paper", "tex", "main.tex"))).toBe(true);
      expect(existsSync(join(root, "05-paper", "scripts", "fig_auc.py"))).toBe(true);
      expect(existsSync(join(root, "05-paper", "scripts", "bootstrap_env.py"))).toBe(true);
      expect(existsSync(join(root, "tex", "main.tex"))).toBe(false);
      // Scaffolding stays out of the figure-script execution set.
      expect(existsSync(join(root, "05-paper", "scripts", "patch_tex.py"))).toBe(false);

      // Idempotent: a second pass changes nothing and does not throw.
      normalizeMispathedArtifacts(ctx);
      expect(existsSync(join(root, "05-paper", "tex", "main.tex"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
