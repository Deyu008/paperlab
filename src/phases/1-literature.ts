/**
 * Phase 1 — Literature review.
 *
 * A PhD-student session searches (rate-limited S2/OpenAlex), saves validated
 * papers with generated BibTeX, and writes the related-work review. The phase
 * fails (and can be retried/resumed) when the artifact trail is too thin.
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { createLiteratureTools } from "../tools/literature-tools.ts";
import type { PaperRecord } from "../tools/paper-search.ts";
import { runRoleSession } from "./support.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PHASE_KEY = "01-literature";
const MIN_PAPERS = 3;

export const literaturePhase: Phase = {
  key: PHASE_KEY,
  name: "Literature review",
  dependsOn: [],
  async run(ctx: PhaseContext): Promise<void> {
    const budgets = ctx.config.budgets.literature;
    const alreadySaved = ctx.store.readJsonl<PaperRecord>(PHASE_KEY, "papers.jsonl");
    const tools = createLiteratureTools({
      store: ctx.store,
      maxSearches: budgets.max_searches,
      fetchImpl: (url, init) => fetch(url, init),
      s2ApiKey: process.env.S2_API_KEY,
    });

    const prompt = [
      `Research topic: "${ctx.store.topic}"`,
      "",
      `Build the literature foundation for this topic.`,
      ``,
      `1. Search with several distinct queries (different aspects, synonyms, method names) until you have saved about ${budgets.target_papers} papers or the search budget (${budgets.max_searches}) is exhausted.`,
      `2. For every relevant paper call save_paper with fields copied EXACTLY from the search results and a substantive note (claim, method, limitation).`,
      `3. Then write the survey with save_review: group papers by theme; per paper state its claim, method, and the limitation that matters for our topic; finish with "The gap" — what prior work does not answer that our research will.`,
      ``,
      `Papers already in the library: ${alreadySaved.length}.`,
      alreadySaved.length > 0
        ? `The library is retained across retries — only add papers that are missing, then (re)write the review.`
        : `The library is empty — start searching.`,
    ].join("\n");

    await runRoleSession({ phase: PHASE_KEY, role: "phd", ctx, tools }, prompt);

    // Post-conditions: the phase is "done" only with a usable artifact trail.
    const papers = ctx.store.readJsonl<PaperRecord>(PHASE_KEY, "papers.jsonl");
    const review = ctx.store.readText(PHASE_KEY, "related_work.md");
    const minPapers = Math.min(MIN_PAPERS, budgets.target_papers);
    if (papers.length < minPapers) {
      throw new Error(
        `literature review too thin: ${papers.length} papers saved, need ≥ ${minPapers}. ` +
          `Re-run this phase (search queries may have been too narrow).`,
      );
    }
    if (!review) {
      throw new Error("related_work.md was not written — the agent must call save_review.");
    }

    // Aggregate bibliography for the writing phase.
    const bib = papers.map((p) => p.bibtex).join("\n\n");
    writeFileSync(join(ctx.store.phaseDir(PHASE_KEY), "references.bib"), bib + "\n");
    ctx.log(`  📚 ${papers.length} papers, review ${review.split(/\s+/).length} words`);
  },
};
