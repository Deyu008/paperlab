/**
 * Phase 1 — Literature review (research funnel).
 *
 * The PhD agent runs a real funnel: keyword discovery → anchor selection →
 * citation snowballing (backward for foundations, forward for competitors)
 * → tiered full-text reads → provenance-gated saves → evidence-tiered
 * survey with a "Closest prior work" section.
 *
 * Hard post-conditions (phase fails without them): minimum papers, review
 * present with the closest-prior-work section, at least one snowball call,
 * and at least one full-text attempt. Soft conditions become warnings in a
 * mechanically computed coverage report (tools log; orchestrator computes).
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { createLiteratureTools } from "../tools/literature-tools.ts";
import { RateLimiter, type PaperRecord } from "../tools/paper-search.ts";
import { computeCoverage } from "../tools/coverage.ts";
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
      maxSnowballs: budgets.max_snowballs,
      maxFullReads: budgets.max_full_reads,
      fetchImpl: (url, init) => fetch(url, init),
      s2ApiKey: process.env.S2_API_KEY,
      // S2 Graph API terms of service: at most one request per second.
      limiter: new RateLimiter(1_000),
    });

    const prompt = [
      `Research topic: "${ctx.store.topic}"`,
      ``,
      `Build the literature foundation with the research funnel — this is how a real researcher works:`,
      ``,
      `1. DISCOVER: run ${Math.min(5, budgets.max_searches)} distinct searches (different facets, synonyms, method names).`,
      `2. ANCHORS: pick 2-4 highly relevant hits as anchor papers.`,
      `3. SNOWBALL: expand each anchor with snowball — backward (foundations) AND forward (who cites it: competitors and follow-ups; you need these for the novelty claim). Save the best via save_paper with the found_via tag.`,
      `4. READ DEEP: for the 4-6 most load-bearing papers, read_paper (full text, section by section — at least method and results), then re-save is NOT needed: save once with read_status 'full'. Everything else stays read_status 'abstract'.`,
      `5. DISCIPLINE (mechanically enforced): numbers in notes must appear in the abstract/full text; quotes must be verbatim; read_status 'full' without a prior read_paper is rejected.`,
      `6. SURVEY: write related_work.md via save_review — group by theme; per paper state claim/method/limitation; mark which papers you read in full (📗) vs abstract-only (📄); end with a "Closest prior work" section naming exactly the papers our contribution must differentiate from.`,
      ``,
      `Budgets: ${budgets.max_searches} searches · ${budgets.max_snowballs} snowballs · ${budgets.max_full_reads} full reads.`,
      `Target: ~${budgets.target_papers} papers total.`,
      ``,
      `Papers already in the library: ${alreadySaved.length}.`,
      alreadySaved.length > 0
        ? `The library is retained across retries — only add missing papers, then (re)write the review.`
        : `The library is empty — start searching.`,
    ].join("\n");

    await runRoleSession({ phase: PHASE_KEY, role: "phd", ctx, tools }, prompt);

    // ---- post-conditions ----------------------------------------------------
    const papers = ctx.store.readJsonl<PaperRecord>(PHASE_KEY, "papers.jsonl");
    const review = ctx.store.readText(PHASE_KEY, "related_work.md");
    const minPapers = Math.min(MIN_PAPERS, budgets.target_papers);
    if (papers.length < minPapers) {
      throw new Error(
        `literature review too thin: ${papers.length} papers saved, need ≥ ${minPapers}. ` +
          `Re-run this phase.`,
      );
    }
    if (!review) {
      throw new Error("related_work.md was not written — the agent must call save_review.");
    }
    if (!/closest prior work/i.test(review)) {
      throw new Error("related_work.md lacks a 'Closest prior work' section.");
    }

    // Mechanically computed coverage (tools audit → orchestrator computes).
    const coverage = computeCoverage(ctx.store);
    writeFileSync(
      join(ctx.store.phaseDir(PHASE_KEY), "coverage-report.json"),
      JSON.stringify(coverage, null, 2) + "\n",
    );

    // Hard gates from the audit trail.
    if (coverage.snowballs.total < 1) {
      throw new Error(
        "no snowball call in the audit log — citation-graph expansion is mandatory " +
          "(keyword-only coverage is not acceptable for a novelty claim)",
      );
    }
    if (coverage.reads.attempts < 1) {
      throw new Error(
        "no full-text read attempt in the audit log — the survey cannot rest on abstracts alone " +
          "(papers without arXiv full text must have their attempted reads on record)",
      );
    }

    // Soft warnings: surfaced, not fatal.
    if (coverage.warnings.length > 0) {
      ctx.log(`  ⚠ coverage warnings:\n${coverage.warnings.map((w) => `    - ${w}`).join("\n")}`);
      writeFileSync(
        join(ctx.store.phaseDir(PHASE_KEY), "coverage-warnings.txt"),
        coverage.warnings.join("\n") + "\n",
      );
    }

    const bib = papers.map((p) => p.bibtex).join("\n\n");
    writeFileSync(join(ctx.store.phaseDir(PHASE_KEY), "references.bib"), bib + "\n");
    ctx.log(
      `  📚 ${papers.length} papers ` +
        `(${coverage.funnel.byReadStatus["full"] ?? 0} full / ${coverage.funnel.byReadStatus["abstract"] ?? 0} abstract), ` +
        `review ${review.split(/\s+/).length} words`,
    );
  },
};
