/**
 * Phase 3 — Experiment execution.
 *
 * The ML engineer session executes the plan inside a sandbox (Docker when
 * available, local venv otherwise) via workspace-scoped tools, under a
 * tool-call budget with error-history nudges. Post-conditions enforce the
 * metrics discipline: metrics.jsonl must exist with valid records covering
 * the planned experiments; the phase then aggregates metrics.json.
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { createExperimentTools } from "../tools/experiment-tools.ts";
import { chooseSandbox, createSandbox } from "../tools/sandbox.ts";
import { aggregateMetrics, renderMetricsJson, renderMetricsTable } from "../tools/metrics.ts";
import { isResearchPlan, type ResearchPlan } from "../tools/plan-schema.ts";
import { SteeringMailbox } from "../core/steering.ts";
import { runRoleSession } from "./support.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PHASE_KEY = "03-experiment";

export const experimentPhase: Phase = {
  key: PHASE_KEY,
  name: "Experiment execution",
  dependsOn: ["02-plan"],
  async run(ctx: PhaseContext): Promise<void> {
    const planRaw = ctx.store.readText("02-plan", "plan.json");
    if (!planRaw) throw new Error("02-plan/plan.json missing — run the plan phase first");
    const plan = JSON.parse(planRaw) as ResearchPlan;
    if (!isResearchPlan(plan)) throw new Error("02-plan/plan.json is not a valid research plan");

    const budgets = ctx.config.budgets.experiment;
    const workspace = join(ctx.store.phaseDir(PHASE_KEY), "workspace");
    const choice = await chooseSandbox(ctx.config.sandbox);
    ctx.log(`  🧪 sandbox: ${choice.mode} (${choice.reason})`);
    const sandbox = await createSandbox(choice, workspace);

    const tools = createExperimentTools({
      sandbox,
      maxToolCalls: budgets.max_tool_calls,
      stepTimeoutSec: budgets.step_timeout_sec,
      steeringDrain: () => new SteeringMailbox(ctx.store.root).drain(PHASE_KEY, "mlengineer"),
    });

    const prompt = [
      `Research plan to execute:`,
      JSON.stringify(plan, null, 2),
      ``,
      `Execute ALL planned experiments in the sandbox workspace. Non-negotiable discipline:`,
      ``,
      `1. Every experiment script APPENDS one JSON record per line to metrics.jsonl:`,
      `   {"experiment": "...", "metric": "...", "value": <number or null>, "higher_is_better": <bool>, "n": <sample count, optional>, "notes": "...", }`,
      `   value=null means the run failed — record it honestly, never fabricate.`,
      `2. Fix random seeds (numpy/sklearn) for reproducibility.`,
      `3. Install packages with run_python on a tiny bootstrap script: subprocess check_call(["python3","-m","pip","install","scikit-learn"]) etc.`,
      `4. Also write per-experiment figure data as CSV (data/<name>.csv) for later plotting.`,
      `5. Work step by step: write_file → run_python → read the error → fix → re-run. Small scripts, one experiment each.`,
      `6. After the experiments, list_files and read_file metrics.jsonl to verify every planned experiment is covered.`,
      ``,
      `Budget: ${budgets.max_tool_calls} tool calls, ${budgets.step_timeout_sec}s per run.`,
    ].join("\n");

    try {
      await runRoleSession({ phase: PHASE_KEY, role: "mlengineer", ctx, tools }, prompt);
    } finally {
      await sandbox.destroy();
    }

    // Post-conditions: metrics discipline.
    const raw = sandbox.readFile("metrics.jsonl") ?? "";
    if (raw.trim().length === 0) {
      throw new Error(
        "no metrics.jsonl produced — the experiments did not record results; re-run this phase",
      );
    }
    const aggregated = aggregateMetrics(raw);
    writeFileSync(join(ctx.store.phaseDir(PHASE_KEY), "metrics.jsonl"), raw);
    writeFileSync(join(ctx.store.phaseDir(PHASE_KEY), "metrics.json"), renderMetricsJson(aggregated));

    const covered = new Set(aggregated.metrics.map((m) => m.experiment));
    const missing = plan.experiments.filter((e) => !covered.has(e.name));
    if (aggregated.metrics.length === 0) {
      throw new Error(
        `metrics.jsonl has no valid records (${aggregated.invalidLines.length} invalid lines)`,
      );
    }
    if (missing.length > 0) {
      ctx.log(
        `  ⚠ planned experiments without records: ${missing.map((e) => e.name).join(", ")} ` +
          `(noted as limitations — pass --force to re-run)`,
      );
      writeFileSync(
        join(ctx.store.phaseDir(PHASE_KEY), "missing-experiments.txt"),
        missing.map((e) => e.name).join("\n") + "\n",
      );
    }
    ctx.log(`  📊 ${aggregated.metrics.length} metrics over ${aggregated.totalLines} records`);
    ctx.log(renderMetricsTable(aggregated.metrics).replace(/^/gm, "  "));
  },
};
