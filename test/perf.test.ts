import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/core/run-store.ts";
import {
  loadFigureManifest,
  saveFigureManifest,
  selectScriptsToRun,
  hashScript,
  outputsProducedDuring,
} from "../src/tools/figure-manifest.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-perf-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("buffered transcript sinks", () => {
  it("buffers small writes and flushes on flushAll", () => {
    const store = RunStore.createNew(base, "topic", null);
    const sink = store.transcript("01-literature", "phd");
    sink.write({ type: "a" });
    sink.write({ type: "b" });
    const path = sink.path;
    // Below the 32 KB threshold nothing hits the disk yet.
    expect(existsSync(path)).toBe(false);
    store.flushAll();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toEqual([JSON.stringify({ type: "a" }), JSON.stringify({ type: "b" })]);
  });

  it("auto-flushes when the buffer crosses the size threshold", () => {
    const store = RunStore.createNew(base, "topic", null);
    const sink = store.transcript("02-plan", "postdoc");
    const big = "x".repeat(40_000);
    sink.write({ payload: big });
    expect(existsSync(sink.path)).toBe(true);
    expect(readFileSync(sink.path, "utf8").length).toBeGreaterThan(40_000);
  });

  it("separate sessions keep separate files", () => {
    const store = RunStore.createNew(base, "topic", null);
    const a = store.transcript("01-literature", "phd");
    const b = store.transcript("01-literature", "postdoc");
    a.write({ s: "a" });
    b.write({ s: "b" });
    store.flushAll();
    expect(readFileSync(a.path, "utf8")).toContain("{\"s\":\"a\"}");
    expect(readFileSync(b.path, "utf8")).toContain("{\"s\":\"b\"}");
  });
});

describe("figure manifest", () => {
  it("runs new scripts, skips unchanged+ok+outputs-present, reruns on edit/failure/missing outputs", () => {
    const figures = join(base, "figures");
    mkdirSync(figures);
    writeFileSync(join(figures, "fig1.png"), "png");
    const manifest = loadFigureManifest(base);
    const scripts = [
      { path: "fig_1.py", content: "print(1)" },
      { path: "fig_2.py", content: "print(2)" },
    ];

    // Nothing recorded → everything runs.
    expect(selectScriptsToRun(scripts, manifest, figures)).toEqual(["fig_1.py", "fig_2.py"]);

    // Record: fig_1 ok with existing output; fig_2 failed.
    manifest["fig_1.py"] = { hash: hashScript("print(1)"), ok: true, outputs: ["fig1.png"], ranAt: "t" };
    manifest["fig_2.py"] = { hash: hashScript("print(2)"), ok: false, outputs: [], ranAt: "t" };
    expect(selectScriptsToRun(scripts, manifest, figures)).toEqual(["fig_2.py"]);

    // fig_1 edited → reruns.
    manifest["fig_1.py"]!.hash = hashScript("print('edited')");
    expect(selectScriptsToRun(scripts, manifest, figures)).toContain("fig_1.py");

    // fig_1 unchanged+ok but its output vanished → reruns.
    manifest["fig_1.py"]!.hash = hashScript("print(1)");
    rmSync(join(figures, "fig1.png"));
    expect(selectScriptsToRun(scripts, manifest, figures)).toContain("fig_1.py");
  });

  it("manifest round-trips; outputsProducedDuring windows by mtime", async () => {
    const figures = join(base, "figures");
    mkdirSync(figures);
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(figures, "new.png"), "png");
    await new Promise((r) => setTimeout(r, 5));
    const after = Date.now();
    expect(outputsProducedDuring(figures, before, after)).toEqual(["new.png"]);
    expect(outputsProducedDuring(figures, after + 5_000, after + 6_000)).toEqual([]);

    const manifest = { "a.py": { hash: "h", ok: true, outputs: ["new.png"], ranAt: "t" } };
    saveFigureManifest(base, manifest);
    expect(loadFigureManifest(base)).toEqual(manifest);
  });

  it("corrupt manifest is ignored (empty, not a crash)", () => {
    writeFileSync(join(base, "figure-manifest.json"), "{broken");
    expect(loadFigureManifest(base)).toEqual({});
  });
});
