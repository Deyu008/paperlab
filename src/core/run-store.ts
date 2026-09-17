/**
 * Run artifact store.
 *
 * Layout:
 *   runs/<topic-slug>/<timestamp>/
 *     state.json                  pipeline checkpoint (resumable)
 *     tokens.jsonl                per-turn usage/cost records
 *     logs/<phase>-<role>.jsonl   full message transcripts
 *     01-literature/ ... 06-review/   phase artifacts
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface PhaseState {
  status: "pending" | "running" | "done" | "failed";
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

export interface RunState {
  topic: string;
  createdAt: string;
  configPath: string | null;
  phases: Record<string, PhaseState>;
}

export interface UsageRecord {
  ts: string;
  phase: string;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Provider-reported prefix-cache hit/miss tokens (0 for older runs). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function slugify(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "run"
  );
}

export class RunStore {
  private constructor(readonly root: string) {
    mkdirSync(join(root, "logs"), { recursive: true });
  }

  static createNew(runDirBase: string, topic: string, configPath: string | null): RunStore {
    const slug = slugify(topic);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = join(runDirBase, slug, stamp);
    mkdirSync(join(root, "logs"), { recursive: true });
    const state: RunState = {
      topic,
      createdAt: new Date().toISOString(),
      configPath,
      phases: {},
    };
    writeFileSync(join(root, "state.json"), JSON.stringify(state, null, 2) + "\n");
    return new RunStore(root);
  }

  /** Re-open an existing run directory (for --resume). */
  static open(path: string): RunStore {
    const statePath = join(path, "state.json");
    if (!existsSync(statePath)) {
      throw new Error(`not a paperlab run directory (state.json missing): ${path}`);
    }
    JSON.parse(readFileSync(statePath, "utf8")) as RunState; // validate shape lazily on first access
    return new RunStore(path);
  }

  get topic(): string {
    return this.state.topic;
  }

  get state(): RunState {
    return JSON.parse(readFileSync(join(this.root, "state.json"), "utf8")) as RunState;
  }

  private writeState(state: RunState): void {
    writeFileSync(join(this.root, "state.json"), JSON.stringify(state, null, 2) + "\n");
  }

  /** Directory for a phase's artifacts, created on demand. */
  phaseDir(phaseKey: string): string {
    const dir = join(this.root, phaseKey);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Mark a phase running/done/failed and bump its attempt counter. */
  updatePhase(phaseKey: string, status: PhaseState["status"]): void {
    const state = this.state;
    const prev = state.phases[phaseKey] ?? { status: "pending", attempts: 0 };
    state.phases[phaseKey] = {
      ...prev,
      status,
      attempts: status === "running" ? prev.attempts + 1 : prev.attempts,
      startedAt: prev.startedAt ?? new Date().toISOString(),
      endedAt: status === "done" || status === "failed" ? new Date().toISOString() : prev.endedAt,
    };
    this.writeState(state);
  }

  isPhaseDone(phaseKey: string): boolean {
    return this.state.phases[phaseKey]?.status === "done";
  }

  /** Append a JSONL record to a phase artifact (e.g. papers.jsonl). */
  appendJsonl(phaseKey: string, name: string, record: unknown): void {
    appendFileSync(join(this.phaseDir(phaseKey), name), JSON.stringify(record) + "\n");
  }

  readJsonl<T>(phaseKey: string, name: string): T[] {
    const p = join(this.root, phaseKey, name);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  }

  writeText(phaseKey: string, name: string, content: string): string {
    const p = join(this.phaseDir(phaseKey), name);
    writeFileSync(p, content);
    return p;
  }

  readText(phaseKey: string, name: string): string | null {
    const p = join(this.root, phaseKey, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** Transcript logger for one (phase, role) session. */
  transcript(phaseKey: string, role: string): {
    path: string;
    write: (record: unknown) => void;
  } {
    const path = join(this.root, "logs", `${phaseKey}-${role}.jsonl`);
    return {
      path,
      write: (record: unknown) => appendFileSync(path, JSON.stringify(record) + "\n"),
    };
  }

  recordUsage(record: UsageRecord): void {
    appendFileSync(join(this.root, "tokens.jsonl"), JSON.stringify(record) + "\n");
  }

  /** Short human-readable summary of the run (used by CLI + copilot mode). */
  describe(): string {
    const state = this.state;
    const phases = Object.entries(state.phases)
      .map(([k, v]) => `${k}:${v.status}`)
      .join(" ");
    return `run ${relative(process.cwd(), this.root)} — "${state.topic}" — ${phases}`;
  }
}
