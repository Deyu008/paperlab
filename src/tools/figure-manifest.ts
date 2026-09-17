/**
 * Incremental figure-script execution (phase 5 reflection loop).
 *
 * Reflection rounds used to re-run every fig_*.py each round; scripts are
 * idempotent but not free (matplotlib import alone is ~1 s per run, and a
 * full paper has ~10 scripts × up to 4 rounds). A per-run manifest records
 * each script's content hash and its produced outputs; a script is skipped
 * when the hash is unchanged, the last run succeeded, and every recorded
 * output file still exists.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FigureManifestEntry {
  hash: string;
  ok: boolean;
  /** Output files present in figuresDir when this script last ran. */
  outputs: string[];
  ranAt: string;
}

export type FigureManifest = Record<string, FigureManifestEntry>;

export function hashScript(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

/** Outputs in figuresDir whose mtime falls inside [startMs, endMs]. */
export function outputsProducedDuring(figuresDir: string, startMs: number, endMs: number): string[] {
  if (!existsSync(figuresDir)) return [];
  return readdirSync(figuresDir).filter((f) => {
    try {
      const mtime = statSync(join(figuresDir, f)).mtimeMs;
      return mtime >= startMs && mtime <= endMs + 2_000; // fs mtime granularity
    } catch {
      return false;
    }
  });
}

/** Pure decision: which scripts must run this round? */
export function selectScriptsToRun(
  scripts: Array<{ path: string; content: string }>,
  manifest: FigureManifest,
  figuresDir: string,
): string[] {
  return scripts
    .filter((s) => {
      const entry = manifest[s.path];
      if (!entry) return true;
      if (!entry.ok) return true;
      if (entry.hash !== hashScript(s.content)) return true;
      // Recorded outputs vanished (manual cleanup / failed compile wiped them).
      return entry.outputs.some((out) => !existsSync(join(figuresDir, out)));
    })
    .map((s) => s.path);
}

export function loadFigureManifest(dir: string): FigureManifest {
  const p = join(dir, "figure-manifest.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FigureManifest;
  } catch {
    return {};
  }
}

export function saveFigureManifest(dir: string, manifest: FigureManifest): void {
  writeFileSync(join(dir, "figure-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
