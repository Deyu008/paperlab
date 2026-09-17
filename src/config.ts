/**
 * Configuration loading and validation.
 *
 * Precedence (lowest → highest):
 *   built-in defaults → config file (--config, or ./config.yaml if present)
 *   → selected CLI overrides.
 */
import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";

export type RoleKey =
  | "phd"
  | "postdoc"
  | "mlengineer"
  | "writer"
  | "reviewer"
  | "ac";

export const ROLE_KEYS: readonly RoleKey[] = [
  "phd",
  "postdoc",
  "mlengineer",
  "writer",
  "reviewer",
  "ac",
] as const;

export interface ModelRef {
  provider: string;
  model: string;
}

export interface Budgets {
  literature: { target_papers: number; max_searches: number; max_snowballs: number; max_full_reads: number };
  plan: { dialogue_rounds: number };
  experiment: { max_tool_calls: number; step_timeout_sec: number };
  writeup: { reflections: number };
  review: { revision_rounds: number; accept_threshold: number };
}

export interface WebConfig {
  /** Enable bigmodel MCP web_search/reader when an API key is present. */
  enabled: boolean;
  max_searches: number;
  max_reads: number;
}

export type SandboxMode = "docker" | "local" | "auto";
export type LatexMode = "pdflatex" | "tectonic" | "docker" | "auto";

export interface PaperlabConfig {
  models: { default: ModelRef } & Partial<Record<RoleKey, ModelRef>>;
  budgets: Budgets;
  copilot: boolean;
  web: WebConfig;
  sandbox: SandboxMode;
  latex: LatexMode;
  run_dir: string;
}

export const DEFAULT_CONFIG: PaperlabConfig = {
  models: {
    default: { provider: "deepseek", model: "deepseek-v4-flash" },
  },
  budgets: {
    literature: { target_papers: 12, max_searches: 15, max_snowballs: 6, max_full_reads: 6 },
    plan: { dialogue_rounds: 3 },
    experiment: { max_tool_calls: 60, step_timeout_sec: 600 },
    writeup: { reflections: 3 },
    review: { revision_rounds: 2, accept_threshold: 6.0 },
  },
  copilot: false,
  web: { enabled: true, max_searches: 8, max_reads: 6 },
  sandbox: "auto",
  latex: "auto",
  run_dir: "runs",
};

/** CLI-level overrides applied after file loading. */
export interface CliOverrides {
  sandbox?: SandboxMode;
  copilot?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseModelRef(v: unknown, path: string, errors: string[]): ModelRef | undefined {
  if (!isPlainObject(v)) {
    errors.push(`${path}: expected an object like { provider, model }`);
    return undefined;
  }
  const { provider, model } = v;
  let ok = true;
  if (typeof provider !== "string" || provider.length === 0) {
    errors.push(`${path}.provider: expected a non-empty string`);
    ok = false;
  }
  if (typeof model !== "string" || model.length === 0) {
    errors.push(`${path}.model: expected a non-empty string`);
    ok = false;
  }
  return ok ? { provider: provider as string, model: model as string } : undefined;
}

function parseNumber(
  v: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    errors.push(`${path}: expected a number in [${min}, ${max}]`);
    return undefined;
  }
  return v;
}

/** Like parseNumber but absent values pass through silently. */
function optNumber(
  v: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): number | undefined {
  if (v === undefined) return undefined;
  return parseNumber(v, path, errors, min, max);
}

/**
 * Deep-merge a parsed YAML document over the defaults, collecting human-readable
 * errors instead of throwing on the first problem.
 */
export function loadConfig(rawYaml: string): { config: PaperlabConfig; errors: string[] } {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parse(rawYaml);
  } catch (e) {
    return { config: structuredClone(DEFAULT_CONFIG), errors: [`YAML parse error: ${(e as Error).message}`] };
  }
  if (doc === null || doc === undefined) {
    return { config: structuredClone(DEFAULT_CONFIG), errors };
  }
  if (!isPlainObject(doc)) {
    return { config: structuredClone(DEFAULT_CONFIG), errors: ["config root must be a mapping"] };
  }

  const config = structuredClone(DEFAULT_CONFIG);

  if (isPlainObject(doc.models)) {
    const def = parseModelRef(doc.models.default, "models.default", errors);
    if (def) config.models.default = def;
    for (const key of ROLE_KEYS) {
      const raw = doc.models[key];
      if (raw === undefined) continue;
      const ref = parseModelRef(raw, `models.${key}`, errors);
      if (ref) config.models[key] = ref;
    }
    // Flag unknown role keys early rather than silently ignoring them.
    const known = new Set<string>(["default", ...ROLE_KEYS]);
    for (const key of Object.keys(doc.models)) {
      if (!known.has(key)) errors.push(`models.${key}: unknown role (known: ${[...known].join(", ")})`);
    }
  }

  if (isPlainObject(doc.budgets)) {
    const b = doc.budgets;
    if (isPlainObject(b.literature)) {
      const t = optNumber(b.literature.target_papers, "budgets.literature.target_papers", errors, 1, 200);
      const m = optNumber(b.literature.max_searches, "budgets.literature.max_searches", errors, 1, 200);
      const sb = optNumber(b.literature.max_snowballs, "budgets.literature.max_snowballs", errors, 0, 100);
      const fr = optNumber(b.literature.max_full_reads, "budgets.literature.max_full_reads", errors, 0, 100);
      if (t) config.budgets.literature.target_papers = t;
      if (m) config.budgets.literature.max_searches = m;
      if (sb !== undefined) config.budgets.literature.max_snowballs = sb;
      if (fr !== undefined) config.budgets.literature.max_full_reads = fr;
    }
    if (isPlainObject(b.plan)) {
      const r = optNumber(b.plan.dialogue_rounds, "budgets.plan.dialogue_rounds", errors, 1, 10);
      if (r) config.budgets.plan.dialogue_rounds = r;
    }
    if (isPlainObject(b.experiment)) {
      const t1 = optNumber(b.experiment.max_tool_calls, "budgets.experiment.max_tool_calls", errors, 1, 1000);
      const t2 = optNumber(b.experiment.step_timeout_sec, "budgets.experiment.step_timeout_sec", errors, 1, 86400);
      if (t1) config.budgets.experiment.max_tool_calls = t1;
      if (t2) config.budgets.experiment.step_timeout_sec = t2;
    }
    if (isPlainObject(b.writeup)) {
      const r = optNumber(b.writeup.reflections, "budgets.writeup.reflections", errors, 0, 10);
      if (r !== undefined) config.budgets.writeup.reflections = r;
    }
    if (isPlainObject(b.review)) {
      const r = optNumber(b.review.revision_rounds, "budgets.review.revision_rounds", errors, 0, 10);
      const th = optNumber(b.review.accept_threshold, "budgets.review.accept_threshold", errors, 0, 10);
      if (r !== undefined) config.budgets.review.revision_rounds = r;
      if (th !== undefined) config.budgets.review.accept_threshold = th;
    }
  }

  if (isPlainObject(doc.web)) {
    if (typeof doc.web.enabled === "boolean") config.web.enabled = doc.web.enabled;
    const ms = optNumber(doc.web.max_searches, "web.max_searches", errors, 0, 100);
    const mr = optNumber(doc.web.max_reads, "web.max_reads", errors, 0, 100);
    if (ms !== undefined) config.web.max_searches = ms;
    if (mr !== undefined) config.web.max_reads = mr;
  }

  if (typeof doc.copilot === "boolean") config.copilot = doc.copilot;
  if (doc.sandbox !== undefined) {
    if (doc.sandbox === "docker" || doc.sandbox === "local" || doc.sandbox === "auto") {
      config.sandbox = doc.sandbox;
    } else {
      errors.push(`sandbox: expected docker|local|auto, got ${String(doc.sandbox)}`);
    }
  }
  if (doc.latex !== undefined) {
    if (doc.latex === "pdflatex" || doc.latex === "tectonic" || doc.latex === "docker" || doc.latex === "auto") {
      config.latex = doc.latex;
    } else {
      errors.push(`latex: expected pdflatex|tectonic|docker|auto, got ${String(doc.latex)}`);
    }
  }
  if (typeof doc.run_dir === "string" && doc.run_dir.length > 0) config.run_dir = doc.run_dir;

  return { config, errors };
}

/** Load config from an explicit path, or ./config.yaml when it exists. */
export function loadConfigFromDisk(
  explicitPath?: string,
  overrides?: CliOverrides,
): { config: PaperlabConfig; errors: string[]; source: string | null } {
  let source: string | null = explicitPath ?? (existsSync("config.yaml") ? "config.yaml" : null);
  if (explicitPath && !existsSync(explicitPath)) {
    return { config: structuredClone(DEFAULT_CONFIG), errors: [`config file not found: ${explicitPath}`], source };
  }
  const raw = source ? readFileSync(source, "utf8") : "";
  const { config, errors } = loadConfig(raw);
  if (overrides?.sandbox) config.sandbox = overrides.sandbox;
  if (overrides?.copilot !== undefined) config.copilot = overrides.copilot;
  return { config, errors, source };
}

/** Resolve the effective model for a role (role override → default). */
export function modelRefForRole(config: PaperlabConfig, role: RoleKey): ModelRef {
  return config.models[role] ?? config.models.default;
}
