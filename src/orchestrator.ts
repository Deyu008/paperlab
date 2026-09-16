/**
 * Phase pipeline orchestrator.
 *
 * Phases are registered by key with explicit dependencies; the runner
 * executes them in order, checkpoints state after each one (so a failed run
 * can be --resume'd), and optionally pauses for human approval (copilot).
 */
import type { PaperlabConfig } from "./config.ts";
import type { RunStore } from "./core/run-store.ts";

export interface PhaseContext {
  config: PaperlabConfig;
  store: RunStore;
  /** Structured console logger (already prefixed by the CLI). */
  log: (message: string) => void;
  /** Copilot notes left after a gated phase (keyed by phase key). */
  copilotNotes: Map<string, string>;
}

export interface Phase {
  /** Directory/artifact key, e.g. "01-literature". */
  key: string;
  name: string;
  dependsOn: readonly string[];
  /** Pause for human approval after success when copilot is on. */
  gate?: boolean;
  run(ctx: PhaseContext): Promise<void>;
}

export class PhaseFailedError extends Error {
  constructor(
    readonly phaseKey: string,
    override readonly cause: unknown,
  ) {
    super(`phase ${phaseKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PhaseFailedError";
  }
}

export interface RunOptions {
  /** Re-run phases even if their checkpoint says done. */
  force?: boolean;
  /** Restrict execution to these phase keys (dependencies still enforced). */
  only?: readonly string[];
}

export class Pipeline {
  constructor(private readonly phases: Phase[]) {
    const keys = new Set(phases.map((p) => p.key));
    for (const phase of phases) {
      for (const dep of phase.dependsOn) {
        if (!keys.has(dep)) {
          throw new Error(`phase ${phase.key} depends on unknown phase ${dep}`);
        }
      }
    }
  }

  phaseKeys(): string[] {
    return this.phases.map((p) => p.key);
  }

  private depsSatisfied(phase: Phase, store: RunStore): boolean {
    return phase.dependsOn.every((dep) => store.isPhaseDone(dep));
  }

  async run(ctx: PhaseContext, options: RunOptions = {}): Promise<void> {
    for (const phase of this.phases) {
      const alreadyDone = ctx.store.isPhaseDone(phase.key);
      if (alreadyDone && !options.force) {
        ctx.log(`↷ skip ${phase.key} (${phase.name}) — already done`);
        continue;
      }
      if (options.only && !options.only.includes(phase.key)) {
        continue;
      }
      if (!this.depsSatisfied(phase, ctx.store)) {
        const missing = phase.dependsOn.filter((d) => !ctx.store.isPhaseDone(d));
        throw new Error(
          `phase ${phase.key} (${phase.name}) has unfinished dependencies: ${missing.join(", ")}`,
        );
      }

      ctx.log(`▶ ${phase.key} (${phase.name})`);
      ctx.store.updatePhase(phase.key, "running");
      const started = Date.now();
      try {
        await phase.run(ctx);
        ctx.store.updatePhase(phase.key, "done");
        ctx.log(`✓ ${phase.key} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (e) {
        ctx.store.updatePhase(phase.key, "failed");
        throw new PhaseFailedError(phase.key, e);
      }

      if (phase.gate && ctx.config.copilot) {
        await copilotGate(phase, ctx);
      }
    }
  }
}

/**
 * Human gate: show the phase summary, accept y (continue), n/q (abort),
 * or free text stored as notes for the next phases to consume.
 */
async function copilotGate(phase: Phase, ctx: PhaseContext): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ctx.log(`⚙ copilot: no TTY, auto-continuing past gate ${phase.key}`);
    return;
  }
  process.stdout.write(
    `\n⚙ copilot gate — ${phase.key} (${phase.name}) finished.\n` +
      `  ${ctx.store.describe()}\n` +
      `  Continue? [y]es · [n]abort · or type notes for the pipeline → `,
  );
  const answer = await readLine();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "n" || trimmed === "q" || trimmed === "abort") {
    throw new Error(`aborted by human at gate ${phase.key}`);
  }
  if (answer.trim() !== "" && trimmed !== "y" && trimmed !== "yes") {
    ctx.copilotNotes.set(phase.key, answer.trim());
    ctx.store.writeText("copilot", `${phase.key}.md`, answer.trim() + "\n");
    ctx.log(`⚙ notes recorded for ${phase.key}`);
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.includes("\n")) {
        process.stdin.removeListener("data", onData);
        resolve(data);
      }
    };
    process.stdin.on("data", onData);
  });
}
