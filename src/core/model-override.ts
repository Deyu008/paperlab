/**
 * Runtime model override (web panel → future sessions).
 *
 * The panel writes `model-override.json` into the run root; session creation
 * applies it over the YAML config. Takes effect for sessions created after
 * the change (running sessions keep their model — pi sessions are immutable
 * that way). The file is a run artifact: the trail shows which model produced
 * what.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PaperlabConfig, ModelRef, RoleKey } from "../config.ts";
import { resolveModel } from "./models.ts";

export type ModelScope = "default" | RoleKey;

export type ModelOverrideMap = Partial<Record<ModelScope, ModelRef>>;

const FILE = "model-override.json";

export function readModelOverride(runRoot: string): ModelOverrideMap {
  const path = join(runRoot, FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ModelOverrideMap;
  } catch {
    return {};
  }
}

/** Validate and persist one scope→model mapping. Throws on unknown models. */
export function writeModelOverride(runRoot: string, scope: ModelScope, ref: ModelRef): void {
  resolveModel(ref); // throws ModelResolutionError when provider/model unknown
  const current = readModelOverride(runRoot);
  current[scope] = ref;
  writeFileSync(join(runRoot, FILE), JSON.stringify(current, null, 2) + "\n");
}

/** Config copy with overrides applied (default first, then per-role). */
export function applyModelOverride(config: PaperlabConfig, runRoot: string): PaperlabConfig {
  const override = readModelOverride(runRoot);
  if (Object.keys(override).length === 0) return config;
  const patched = structuredClone(config);
  if (override.default) patched.models.default = override.default;
  for (const key of Object.keys(override) as ModelScope[]) {
    if (key !== "default") patched.models[key] = override[key]!;
  }
  return patched;
}
