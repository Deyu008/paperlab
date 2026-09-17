/**
 * Phase 6 — Peer review and revision.
 *
 * Three reviewer personas (rigorous methodologist, skeptical verifier,
 * novelty) each see the paper AND the artifacts (code, logs, metrics) and
 * submit structured reviews with recorded artifact checks. The Area Chair
 * consolidates. Below the accept threshold, the writer revises and the paper
 * is re-reviewed — a bounded number of rounds. Every round lands in the
 * artifact trail.
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateReview, validateMetaReview, type ReviewRecord, type MetaReview } from "../tools/review-schema.ts";
import { aggregateMetrics, renderMetricsTable } from "../tools/metrics.ts";
import { compileLatex, probeLatex } from "../tools/latex.ts";
import { createExperimentTools } from "../tools/experiment-tools.ts";
import { LocalSandbox } from "../tools/sandbox.ts";
import { reviewerPrompt, REVIEWER_PERSONAS } from "../roles/index.ts";
import { openRoleSession } from "./support.ts";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PHASE_KEY = "06-review";
const MAIN = "main";

export const reviewPhase: Phase = {
  key: PHASE_KEY,
  name: "Peer review and revision",
  dependsOn: ["05-paper"],
  async run(ctx: PhaseContext): Promise<void> {
    const metricsRaw = ctx.store.readText("03-experiment", "metrics.jsonl") ?? "";
    const metricsTable = renderMetricsTable(aggregateMetrics(metricsRaw).metrics);
    const tex = ctx.store.readText("05-paper", `tex/${MAIN}.tex`);
    if (!tex) throw new Error("05-paper/tex/main.tex missing");
    const experimentCode = collectExperimentCode(ctx);
    const findings = ctx.store.readText("04-interpret", "findings.md") ?? "";
    const metricsJsonl = metricsRaw;

    const materials = [
      `## Paper (LaTeX source)`,
      tex.slice(0, 24_000),
      ``,
      `## Recorded metrics (ground truth for every number in the paper)`,
      metricsTable,
      ``,
      `## metrics.jsonl (raw records)`,
      metricsJsonl.slice(0, 8_000),
      ``,
      `## Experiment code`,
      experimentCode,
      ``,
      `## Authors' findings document`,
      findings.slice(0, 6_000),
    ].join("\n");

    const budgets = ctx.config.budgets.review;
    const allReviews: ReviewRecord[] = [];
    let meta: MetaReview | null = null;
    let currentTex = tex;
    let round = 0;

    const runReviewRound = async (): Promise<{ reviews: ReviewRecord[]; meta: MetaReview }> => {
      const reviews: ReviewRecord[] = [];
      for (let i = 0; i < REVIEWER_PERSONAS.length; i++) {
        const persona = REVIEWER_PERSONAS[i]!;
        const holder: { value: ReviewRecord | null } = { value: null };
        const submit_review: ToolDefinition = defineTool({
          name: "submit_review",
          label: "Submit review",
          description:
            "Submit your structured review as JSON: {reviewer, summary, strengths[], weaknesses[], " +
            "checks: [{item, passed, note}], soundness 1-5, clarity 1-5, novelty 1-5, overall 1-10, " +
            "confidence 1-5, decision: accept|weak-accept|weak-reject|reject}. " +
            "checks records the artifact verifications you actually performed. Validation errors are returned — fix and resubmit.",
          parameters: Type.Object({
            review_json: Type.String({ description: "The review as a JSON string" }),
          }),
          async execute(_id, params) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(params.review_json);
            } catch (e) {
              return toolText(`JSON parse error: ${(e as Error).message}`);
            }
            const errors = validateReview(parsed);
            if (errors.length > 0) return toolText(`Review rejected:\n- ${errors.join("\n- ")}`);
            holder.value = parsed as ReviewRecord;
            return toolText("Review accepted.");
          },
        });

        ctx.log(`  🧑‍⚖️ reviewer: ${persona.key}`);
        const session = await openRoleSession({
          phase: PHASE_KEY,
          role: "reviewer",
          ctx,
          systemPrompt: reviewerPrompt(i),
          tools: [submit_review],
        });
        try {
          await session.prompt(
            `${materials}\n\nReview round ${round + 1}. Persona: ${persona.name}.\n` +
              `You have the paper AND its artifacts. Verify claims against metrics.jsonl (at least 3 explicit checks), ` +
              `then submit via submit_review.`,
          );
        } finally {
          session.close();
        }
        if (holder.value) {
          reviews.push(holder.value);
        } else {
          throw new Error(`reviewer ${persona.key} did not submit a valid review`);
        }
      }

      // Area chair consolidation.
      const metaHolder: { value: MetaReview | null } = { value: null };
      const submit_meta: ToolDefinition = defineTool({
        name: "submit_meta_review",
        label: "Submit meta-review",
        description:
          "Submit the meta-review as JSON: {summary, resolved_disagreements[], overall 1-10, " +
          "decision, required_revisions[] (non-empty unless accept)}.",
        parameters: Type.Object({
          meta_json: Type.String({ description: "The meta-review as a JSON string" }),
        }),
        async execute(_id, params) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(params.meta_json);
          } catch (e) {
            return toolText(`JSON parse error: ${(e as Error).message}`);
          }
          const errors = validateMetaReview(parsed);
          if (errors.length > 0) return toolText(`Meta-review rejected:\n- ${errors.join("\n- ")}`);
          metaHolder.value = parsed as MetaReview;
          return toolText("Meta-review accepted.");
        },
      });

      const ac = await openRoleSession({ phase: PHASE_KEY, role: "ac", ctx, tools: [submit_meta] });
      try {
        await ac.prompt(
          `Reviews to consolidate:\n\n${JSON.stringify(reviews, null, 2)}\n\n` +
            `Recorded metrics (ground truth):\n${metricsTable}\n\n` +
            `Weigh artifact-grounded critiques above style. Resolve contradictions explicitly, then submit_meta.`,
        );
      } finally {
        ac.close();
      }
      if (!metaHolder.value) throw new Error("area chair did not submit a meta-review");
      return { reviews, meta: metaHolder.value };
    };

    const revise = async (reviews: ReviewRecord[], metaReview: MetaReview): Promise<boolean> => {
      const backend = await probeLatex(ctx.config.latex);
      if (!backend) throw new Error("no LaTeX backend for revision recompile");
      const sandbox = new LocalSandbox(ctx.store.root);
      const tools = createExperimentTools({
        sandbox,
        maxToolCalls: 12,
        stepTimeoutSec: 240,
      });
      const writer = await openRoleSession({ phase: PHASE_KEY, role: "writer", ctx, tools });
      let ok = false;
      try {
        await writer.session.prompt(
          `The paper was reviewed below the accept threshold. Revise tex/${MAIN}.tex in place (write_file) — ` +
            `do not change recorded numbers, only presentation, framing, and honest limitations/clarifications. ` +
            `You may not alter metrics or fabricate new results.\n\n` +
            `Meta-review required revisions:\n${metaReview.required_revisions.map((r) => `- ${r}`).join("\n")}\n\n` +
            `Full reviews:\n${JSON.stringify(reviews, null, 2).slice(0, 12_000)}\n\n` +
            `Current tex:\n${currentTex.slice(0, 16_000)}`,
        );
      } finally {
        writer.close();
      }
      const revised = sandbox.readFile(`05-paper/tex/${MAIN}.tex`);
      if (revised) currentTex = revised;
      const texDir = join(ctx.store.root, "05-paper", "tex");
      const result = await compileLatex(texDir, MAIN, backend, true);
      ok = result.ok;
      await sandbox.destroy();
      return ok;
    };

    // Rounds: initial review + bounded revisions.
    while (true) {
      const { reviews, meta: metaResult } = await runReviewRound();
      allReviews.push(...reviews);
      meta = metaResult;
      writeFileSync(
        join(ctx.store.phaseDir(PHASE_KEY), `round${round}-reviews.json`),
        JSON.stringify(reviews, null, 2) + "\n",
      );
      writeFileSync(
        join(ctx.store.phaseDir(PHASE_KEY), `round${round}-meta.json`),
        JSON.stringify(metaResult, null, 2) + "\n",
      );
      ctx.log(`  📋 round ${round}: overall ${metaResult.overall}/10 (${metaResult.decision})`);

      if (metaResult.overall >= budgets.accept_threshold || round >= budgets.revision_rounds) break;

      ctx.log(`  🔧 revising (round ${round + 1})`);
      const recompiled = await revise(reviews, metaResult);
      if (!recompiled) {
        ctx.log(`  ⚠ revision failed to recompile — keeping round ${round} as final`);
        break;
      }
      round++;
    }

    // Final report.
    const finalMeta = meta!;
    writeFileSync(
      join(ctx.store.phaseDir(PHASE_KEY), "reviews-all.json"),
      JSON.stringify(allReviews, null, 2) + "\n",
    );
    const report = [
      `# Review report`,
      ``,
      `Final decision: **${finalMeta.decision}** (overall ${finalMeta.overall}/10, ` +
        `threshold ${budgets.accept_threshold}, ${round} revision round${round === 1 ? "" : "s"})`,
      ``,
      `## Meta-review`,
      finalMeta.summary,
      ``,
      `## Required revisions`,
      ...(finalMeta.required_revisions.length > 0
        ? finalMeta.required_revisions.map((r) => `- ${r}`)
        : ["- (none — accepted)"]),
      ``,
      `## Review scores by round`,
      ...allReviews.map((r) => `- ${r.reviewer}: overall ${r.overall}/10, soundness ${r.soundness}/5 (${r.decision})`),
      ``,
      `## Meta-review (verbatim)`,
      "```json",
      JSON.stringify(finalMeta, null, 2),
      "```",
    ].join("\n");
    ctx.store.writeText(PHASE_KEY, "report.md", report + "\n");
    ctx.log(`  🏁 final: ${finalMeta.decision} (${finalMeta.overall}/10)`);
  },
};

function collectExperimentCode(ctx: PhaseContext): string {
  const dir = join(ctx.store.root, "03-experiment", "workspace");
  const parts: string[] = [];
  const collect = (sub: string) => {
    const p = join(dir, sub);
    if (!existsSync(p)) return;
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const f of entries) {
      if (f.endsWith(".py")) {
        const content = readFileSync(join(p, f), "utf8").slice(0, 6_000);
        parts.push(`### ${sub}/${f}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  };
  collect(".");
  collect("experiments");
  return parts.length > 0 ? parts.join("\n\n").slice(0, 30_000) : "(no experiment code found)";
}

function toolText(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
