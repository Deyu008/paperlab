/**
 * Phase 2 — Research plan formulation.
 *
 * Postdoc ↔ PhD dialogue over the literature, then the postdoc submits a
 * structured plan via the submit_plan tool. The tool validates (including
 * novelty grounding against saved titles) so the agent iterates until the
 * plan is well-formed; the phase fails if no valid plan lands.
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validatePlan, type ResearchPlan } from "../tools/plan-schema.ts";
import type { PaperRecord } from "../tools/paper-search.ts";
import { openRoleSession } from "./support.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PHASE_KEY = "02-plan";

export const planPhase: Phase = {
  key: PHASE_KEY,
  name: "Research plan formulation",
  dependsOn: ["01-literature"],
  async run(ctx: PhaseContext): Promise<void> {
    const papers = ctx.store.readJsonl<PaperRecord>("01-literature", "papers.jsonl");
    const review = ctx.store.readText("01-literature", "related_work.md") ?? "";
    const rounds = ctx.config.budgets.plan.dialogue_rounds;
    const knownTitles = papers.map((p) => p.title);

    const digest = papers
      .map((p, i) => `[${i + 1}] ${p.title} (${p.year ?? "?"}) — ${p.note ?? "(no note)"}`)
      .join("\n");

    // Holder object: assignments inside the tool closure stay visible to the phase.
    const result: { plan: ResearchPlan | null } = { plan: null };
    const submit_plan: ToolDefinition = defineTool({
      name: "submit_plan",
      label: "Submit research plan",
      description:
        "Submit the final research plan as JSON. Schema: " +
        '{research_question, hypothesis, novelty, experiments: [{name, purpose, procedure, dataset, metric, target, fallback}], success_criteria, risks: [..]}. ' +
        "The novelty field must quote (part of) at least one saved paper title. Validation errors are returned — fix and resubmit.",
      promptSnippet: "submit_plan(plan_json) — submit the validated research plan",
      parameters: Type.Object({
        plan_json: Type.String({ description: "The research plan as a JSON string" }),
      }),
      async execute(_id, params) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(params.plan_json);
        } catch (e) {
          return text(`JSON parse error: ${(e as Error).message}. Resubmit valid JSON.`);
        }
        const errors = validatePlan(parsed, knownTitles);
        if (errors.length > 0) {
          return text(`Plan rejected:\n- ${errors.join("\n- ")}\n\nFix these and resubmit.`);
        }
        result.plan = parsed as ResearchPlan;
        return text("Plan accepted and saved as plan.json.");
      },
    });

    const opening = [
      `Research topic: "${ctx.store.topic}"`,
      ``,
      `Literature library (${papers.length} papers):`,
      digest,
      ``,
      `Related-work review:`,
      review,
      ``,
      `You are in dialogue with the postdoc (your messages are shown to each other).`,
      `Propose a concrete, CPU-feasible research direction: a falsifiable hypothesis, the experiments that would support or refute it, datasets, metrics, and baselines. Keep it small and decisive.`,
    ].join("\n");

    const phd = await openRoleSession({ phase: PHASE_KEY, role: "phd", ctx });
    const postdoc = await openRoleSession({ phase: PHASE_KEY, role: "postdoc", ctx, tools: [submit_plan] });

    try {
      await phd.prompt(opening);
      let lastPhd = phd.session.lastAssistantText() ?? "";
      for (let round = 1; round <= rounds && !result.plan; round++) {
        ctx.log(`  💬 plan dialogue round ${round}/${rounds}`);
        await postdoc.prompt(
          `PhD student:\n\n${lastPhd}\n\n` +
            (round < rounds
              ? `Challenge and refine this (round ${round}/${rounds}). When the direction is solid enough, submit the final plan with submit_plan.`
              : `Final round — submit the plan now with submit_plan.`),
        );
        const postdocReply = postdoc.session.lastAssistantText();
        if (!postdocReply || result.plan) break;
        if (round < rounds) {
          await phd.prompt(
            `Postdoc:\n\n${postdocReply}\n\nRespond: address the critiques, refine the direction, and sharpen the experiment list.`,
          );
          lastPhd = phd.session.lastAssistantText() ?? lastPhd;
        }
      }
    } finally {
      phd.close();
      postdoc.close();
    }

    if (!result.plan) {
      throw new Error(
        "no valid plan submitted — re-run this phase; consider raising budgets.plan.dialogue_rounds",
      );
    }
    writeFileSync(
      join(ctx.store.phaseDir(PHASE_KEY), "plan.json"),
      JSON.stringify(result.plan, null, 2) + "\n",
    );
    ctx.log(`  📋 plan: ${result.plan.experiments.length} experiments — ${result.plan.research_question}`);
  },
};

function text(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
