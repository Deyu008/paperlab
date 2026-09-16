/**
 * Phase 4 — Results interpretation.
 *
 * The postdoc reads the aggregated metrics (injected verbatim — no recall)
 * and writes findings.md: what the numbers show, what they might mean, and
 * honest limitations. Validation ties findings to real experiment names.
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { aggregateMetrics, renderMetricsTable } from "../tools/metrics.ts";
import { runRoleSession } from "./support.ts";

const PHASE_KEY = "04-interpret";

export const interpretPhase: Phase = {
  key: PHASE_KEY,
  name: "Results interpretation",
  dependsOn: ["03-experiment"],
  async run(ctx: PhaseContext): Promise<void> {
    const raw = ctx.store.readText("03-experiment", "metrics.jsonl");
    if (!raw) throw new Error("03-experiment/metrics.jsonl missing — run the experiment phase first");
    const aggregated = aggregateMetrics(raw);
    const knownExperiments = new Set(aggregated.metrics.map((m) => m.experiment));
    const plan = ctx.store.readText("02-plan", "plan.json") ?? "";
    const missingNote = ctx.store.readText("03-experiment", "missing-experiments.txt");

    const result: { saved: boolean } = { saved: false };
    const save_findings = defineTool({
      name: "save_findings",
      label: "Save findings",
      description:
        "Save the results interpretation as findings.md. Must reference the experiments by their exact " +
        "recorded names and quote numbers exactly as they appear in the provided metrics table.",
      parameters: Type.Object({
        markdown: Type.String({ description: "The findings document in markdown" }),
      }),
      async execute(_id, params) {
        const text = params.markdown.trim();
        if (text.length < 300) {
          return text0("Rejected: findings too short — cover each experiment, the key numbers, interpretation, and limitations.");
        }
        const referenced = [...knownExperiments].filter((name) => text.includes(name));
        if (referenced.length === 0) {
          return text0(
            `Rejected: no recorded experiment is mentioned by name. Known experiments: ${[...knownExperiments].join(", ")}.`,
          );
        }
        ctx.store.writeText(PHASE_KEY, "findings.md", text + "\n");
        result.saved = true;
        return text0(`Findings saved (${referenced.length} experiments referenced).`);
      },
    });

    const prompt = [
      `Interpret the experimental results and write findings.md via save_findings.`,
      ``,
      `Research plan:`,
      plan,
      ``,
      `Recorded metrics (the ONLY source of numbers):`,
      renderMetricsTable(aggregated.metrics),
      ``,
      missingNote ? `Planned experiments that produced no records: ${missingNote}` : ``,
      ``,
      `Structure: What was run → What the numbers show (quote exact values) → Interpretation vs the hypothesis → Limitations (be blunt, reviewers see the logs).`,
      `Do not invent numbers; if something is missing, say so.`,
    ]
      .filter((l) => l !== "")
      .join("\n");

    await runRoleSession({ phase: PHASE_KEY, role: "postdoc", ctx, tools: [save_findings] }, prompt);

    if (!result.saved) {
      throw new Error("findings.md was not saved — the agent must call save_findings");
    }
    ctx.log(`  🔍 findings saved (${[...knownExperiments].length} experiments interpreted)`);
  },
};

function text0(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
