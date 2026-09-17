/**
 * Phase 5 — Paper writing.
 *
 * The writer session drafts tex/main.tex and figure scripts against the real
 * artifacts (metrics, findings, bibliography). The orchestrator runs the
 * figure scripts, compiles the LaTeX chain, and audits citations; failures
 * are fed back to the writer for a bounded number of reflection rounds.
 */
import type { Phase, PhaseContext } from "../orchestrator.ts";
import { createExperimentTools } from "../tools/experiment-tools.ts";
import { LocalSandbox } from "../tools/sandbox.ts";
import { aggregateMetrics, renderMetricsTable } from "../tools/metrics.ts";
import { compileLatex, probeLatex } from "../tools/latex.ts";
import { auditCitations, extractBibKeys } from "../tools/citation.ts";
import { auditFigures } from "../tools/figure-audit.ts";
import { openRoleSession } from "./support.ts";
import { mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const PHASE_KEY = "05-paper";
const MAIN = "main";

export const paperPhase: Phase = {
  key: PHASE_KEY,
  name: "Paper writing",
  dependsOn: ["04-interpret"],
  async run(ctx: PhaseContext): Promise<void> {
    // Inputs from prior phases.
    const metricsRaw = ctx.store.readText("03-experiment", "metrics.jsonl");
    if (!metricsRaw) throw new Error("03-experiment/metrics.jsonl missing");
    const aggregated = aggregateMetrics(metricsRaw);
    const plan = ctx.store.readText("02-plan", "plan.json") ?? "";
    const findings = ctx.store.readText("04-interpret", "findings.md") ?? "";
    const relatedWork = ctx.store.readText("01-literature", "related_work.md") ?? "";
    const references = ctx.store.readText("01-literature", "references.bib") ?? "";
    if (!references) throw new Error("01-literature/references.bib missing");
    const bibKeys = extractBibKeys(references);

    // Layout.
    const paperDir = ctx.store.phaseDir(PHASE_KEY);
    const texDir = join(paperDir, "tex");
    const figuresDir = join(paperDir, "figures");
    const scriptsDir = join(paperDir, "scripts");
    for (const d of [texDir, figuresDir, scriptsDir]) mkdirSync(d, { recursive: true });
    // The bibliography is assembled by the pipeline, not authored by the writer.
    copyFileSync(join(ctx.store.root, "01-literature", "references.bib"), join(texDir, "references.bib"));

    // Latex backend.
    const backend = await probeLatex(ctx.config.latex);
    if (!backend) {
      throw new Error(
        "no LaTeX backend available — install texlive/tectonic, or set latex: docker in config",
      );
    }
    ctx.log(
      backend === "docker"
        ? `  🖨 latex backend: docker (image ${process.env.PAPERLAB_TEXIMAGE ?? "texlive/texlive"} — first pull is multi-GB)`
        : `  🖨 latex backend: ${backend}`,
    );

    // Tools: sandbox rooted at the whole run dir so figure scripts can read
    // experiment data and write figures.
    const sandbox = new LocalSandbox(ctx.store.root);
    const tools = createExperimentTools({
      sandbox,
      maxToolCalls: Math.max(8, Math.floor(ctx.config.budgets.experiment.max_tool_calls / 3)),
      stepTimeoutSec: ctx.config.budgets.experiment.step_timeout_sec,
    });

    const dataFiles = (() => {
      const dataDir = join(ctx.store.root, "03-experiment", "workspace", "data");
      if (!existsSync(dataDir)) return "(none)";
      const files = readdirSync(dataDir).filter((f) => f.endsWith(".csv"));
      return files.length > 0 ? files.map((f) => `03-experiment/workspace/data/${f}`).join("\n") : "(none)";
    })();

    const opening = [
      `Write the research paper as tex/${MAIN}.tex. Inputs (the ONLY sources you may use):`,
      ``,
      `## Research plan`,
      plan,
      ``,
      `## Findings`,
      findings,
      ``,
      `## Recorded metrics (quote values EXACTLY)`,
      renderMetricsTable(aggregated.metrics),
      ``,
      `## Available citation keys (use ONLY these)`,
      bibKeys.join(", "),
      ``,
      `## Figure data files (figures must load these; do not invent data)`,
      dataFiles,
      ``,
      `## Related-work notes (for background)`,
      relatedWork.slice(0, 6_000),
      ``,
      `Requirements:`,
      `1. ${MAIN}.tex: \\documentclass{article}, \\graphicspath{{../figures/}}, \\bibliographystyle{plain}, \\bibliography{references}.`,
      `2. Structure: abstract, introduction, related work (cite the provided keys), method, experiments (table + numbers from the metrics above), discussion incl. limitations, conclusion.`,
      `3. Figure scripts go in scripts/fig_*.py, must be idempotent, read the CSV data files above, and save to 05-paper/figures/*.png (matplotlib, dpi=150). Install matplotlib first if needed via a bootstrap script (pip). Reference figures from the tex as \\includegraphics{...}.`,
      `4. Every number must come from the metrics table verbatim. If a planned experiment is missing, state it as a limitation.`,
      `5. You may read any run artifact with read_file (e.g. 03-experiment/workspace/...) to ground details.`,
    ].join("\n");

    // Reflection loop: run figures → compile → audit → feed back.
    const maxRounds = ctx.config.budgets.writeup.reflections + 1;
    const writer = await openRoleSession({ phase: PHASE_KEY, role: "writer", ctx, tools });
    let compileOk = false;
    try {
      await writer.session.prompt(opening);
      for (let round = 1; round <= maxRounds; round++) {
        ctx.log(`  📝 write/compile round ${round}/${maxRounds}`);
        const tex = sandbox.readFile(`${PHASE_KEY}/tex/${MAIN}.tex`);
        if (!tex) {
          await writer.session.prompt(
            `tex/${MAIN}.tex does not exist yet. Write it now with write_file.`,
          );
          continue;
        }

        // 1) Run figure scripts (idempotent), collect failures.
        const scriptErrors: string[] = [];
        for (const script of sandbox.listFiles(`${PHASE_KEY}/scripts`)) {
          if (!script.endsWith(".py")) continue;
          const res = await sandbox.exec(["python3", script], 240);
          if (res.exitCode !== 0) {
            scriptErrors.push(`${script}: ${(res.stderr || res.stdout).slice(0, 500)}`);
          }
        }

        // 2) Compile.
        const result = await compileLatex(texDir, MAIN, backend, true);

        // 3) Citation audit (against the pipeline-managed bibliography).
        const audit = auditCitations(tex, references);

        // 4) Figure integrity: referenced PNGs must exist, no placeholder
        //    macros, figure-producing scripts present (live-run lesson).
        const figAudit = auditFigures(tex, figuresDir, scriptsDir);

        const problems: string[] = [];
        for (const e of result.errors) problems.push(`[${e.kind}] ${e.message}`);
        problems.push(...figAudit.problems);
        if (audit.missing.length > 0) {
          problems.push(`[citations] keys used but not in the bibliography: ${audit.missing.join(", ")}`);
        }
        for (const se of scriptErrors) problems.push(`[figure-script] ${se}`);

        if (result.ok && problems.length === 0) {
          compileOk = true;
          ctx.log(`  📄 paper.pdf compiled (${result.pages ?? "?"} pages, ${figAudit.referenced.length} figures)`);
          break;
        }
        if (round === maxRounds) break;
        await writer.session.prompt(
          `Build round ${round} failed. Fix and finish:\n` +
            problems.map((p) => `- ${p}`).join("\n") +
            (audit.missing.length > 0
              ? `\nAvailable citation keys: ${bibKeys.join(", ")}`
              : "") +
            (figAudit.problems.length > 0
              ? `\nFigure requirements: write scripts/fig_*.py that read the real CSVs (${dataFiles}) ` +
                `and save PNGs to 05-paper/figures/; the pipeline runs them automatically; ` +
                `reference with \\includegraphics (no custom wrapper macros).`
              : "") +
            `\nUse write_file to update tex/${MAIN}.tex / scripts, then stop — the pipeline rebuilds.`,
        );
      }
    } finally {
      writer.close();
      await sandbox.destroy();
    }

    if (!compileOk) {
      throw new Error(
        `paper did not build cleanly within ${maxRounds} rounds — ` +
          `resume with --only ${PHASE_KEY} --force after inspecting ${join(texDir, MAIN)}.log`,
      );
    }
  },
};
