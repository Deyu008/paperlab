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
import { chooseSandbox, createSandbox } from "../tools/sandbox.ts";
import { aggregateMetrics, renderMetricsTable } from "../tools/metrics.ts";
import { compileLatex, probeLatex } from "../tools/latex.ts";
import { auditCitations, extractBibKeys } from "../tools/citation.ts";
import { auditFigures } from "../tools/figure-audit.ts";
import {
  loadFigureManifest,
  saveFigureManifest,
  selectScriptsToRun,
  hashScript,
  outputsProducedDuring,
} from "../tools/figure-manifest.ts";
import { SteeringMailbox } from "../core/steering.ts";
import { openRoleSession } from "./support.ts";
import { mkdirSync, existsSync, readdirSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const PHASE_KEY = "05-paper";
const MAIN = "main";

/**
 * Self-heal mispathed writer artifacts. A live run showed the writer can
 * interpret the (older, ambiguous) prompt "tex/main.tex" and "scripts/" as
 * run-root-relative and dutifully produce <run>/tex/main.tex and
 * <run>/scripts/*.py while the phase looks under 05-paper/. Instead of
 * discarding that work on resume, adopt it: move the tex file and the
 * figure/bootstrap scripts into their canonical locations. One-shot and
 * idempotent — later runs keep everything canonical from the start.
 */
export function normalizeMispathedArtifacts(ctx: PhaseContext): void {
  const root = ctx.store.root;
  const misTex = join(root, "tex", `${MAIN}.tex`);
  const wantTex = join(root, PHASE_KEY, "tex", `${MAIN}.tex`);
  if (existsSync(misTex) && !existsSync(wantTex)) {
    mkdirSync(join(root, PHASE_KEY, "tex"), { recursive: true });
    renameSync(misTex, wantTex);
    ctx.log("  🔧 adopted mispathed tex/main.tex → 05-paper/tex/main.tex");
  }
  const misScripts = join(root, "scripts");
  const wantScripts = join(root, PHASE_KEY, "scripts");
  if (existsSync(misScripts)) {
    const movable = readdirSync(misScripts).filter((f) => /^fig_.*\.py$/.test(f) || /^bootstrap.*\.py$/.test(f));
    if (movable.length > 0) {
      mkdirSync(wantScripts, { recursive: true });
      for (const f of movable) {
        if (!existsSync(join(wantScripts, f))) renameSync(join(misScripts, f), join(wantScripts, f));
      }
      ctx.log(`  🔧 adopted ${movable.length} mispathed figure script(s) → 05-paper/scripts/`);
    }
  }
}

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
    // experiment data and write figures. Docker preferred — a local run
    // executes agent-authored python with full host permissions (a live-run
    // script once overwrote the host python binary).
    const choice = await chooseSandbox(ctx.config.sandbox);
    ctx.log(`  🧪 figure sandbox: ${choice.mode} (${choice.reason})`);
    const sandbox = await createSandbox(choice, ctx.store.root);
    const tools = createExperimentTools({
      sandbox,
      maxToolCalls: Math.max(8, Math.floor(ctx.config.budgets.experiment.max_tool_calls / 3)),
      stepTimeoutSec: ctx.config.budgets.experiment.step_timeout_sec,
      steeringDrain: () => new SteeringMailbox(ctx.store.root).drain(PHASE_KEY, "writer"),
    });

    const dataFiles = (() => {
      const dataDir = join(ctx.store.root, "03-experiment", "workspace", "data");
      if (!existsSync(dataDir)) return "(none)";
      const files = readdirSync(dataDir).filter((f) => f.endsWith(".csv"));
      return files.length > 0 ? files.map((f) => `03-experiment/workspace/data/${f}`).join("\n") : "(none)";
    })();

    const opening = [
      `Write the research paper as ${PHASE_KEY}/tex/${MAIN}.tex (that exact path — the sandbox root is the run directory, so "tex/main.tex" would land in the wrong place). Inputs (the ONLY sources you may use):`,
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
      `1. ${MAIN}.tex at ${PHASE_KEY}/tex/${MAIN}.tex: \\documentclass{article}, \\graphicspath{{../figures/}}, \\bibliographystyle{plain}, \\bibliography{references}.`,
      `2. Structure: abstract, introduction, related work (cite the provided keys), method, experiments (table + numbers from the metrics above), discussion incl. limitations, conclusion.`,
      `3. Figure scripts go in ${PHASE_KEY}/scripts/fig_*.py (exact path), must be idempotent, read the CSV data files above, and save figures to ${PHASE_KEY}/figures/ (PNG or PDF; matplotlib, dpi=150). A ${PHASE_KEY}/scripts/bootstrap*.py that pip-installs matplotlib may run first. Reference figures from the tex as \\includegraphics{...}.`,
      `4. Every number must come from the metrics table verbatim. If a planned experiment is missing, state it as a limitation.`,
      `5. You may read any run artifact with read_file (e.g. 03-experiment/workspace/...) to ground details.`,
    ].join("\n");

    // Reflection loop: run figures → compile → audit → feed back.
    normalizeMispathedArtifacts(ctx);
    const maxRounds = ctx.config.budgets.writeup.reflections + 1;
    const writer = await openRoleSession({ phase: PHASE_KEY, role: "writer", ctx, tools });
    let compileOk = false;
    try {
      await writer.prompt(opening);
      for (let round = 1; round <= maxRounds; round++) {
        ctx.log(`  📝 write/compile round ${round}/${maxRounds}`);
        const tex = sandbox.readFile(`${PHASE_KEY}/tex/${MAIN}.tex`);
        if (!tex) {
          await writer.prompt(
            `${PHASE_KEY}/tex/${MAIN}.tex does not exist yet (the sandbox root is the run directory — ` +
              `write_file with the full path ${PHASE_KEY}/tex/${MAIN}.tex). Write it now.`,
          );
          continue;
        }

        // 1) Run figure scripts — incrementally. Unchanged, previously
        // successful scripts with their outputs intact are skipped (a full
        // re-run cost ~10 matplotlib startups per reflection round).
        const scriptErrors: string[] = [];
        const manifest = loadFigureManifest(paperDir);
        const scriptEntries = sandbox
          .listFiles(`${PHASE_KEY}/scripts`)
          .filter((f) => f.endsWith(".py"))
          .map((path) => ({ path, content: sandbox.readFile(`${PHASE_KEY}/scripts/${path}`) ?? "" }));
        const toRun = selectScriptsToRun(scriptEntries, manifest, figuresDir);
        if (toRun.length < scriptEntries.length) {
          ctx.log(`  ⏭ ${scriptEntries.length - toRun.length} unchanged figure script(s) skipped`);
        }
        for (const path of toRun) {
          const entry = scriptEntries.find((e) => e.path === path)!;
          const startMs = Date.now();
          const res = await sandbox.exec(["python3", `${PHASE_KEY}/scripts/${path}`], 240);
          manifest[path] = {
            hash: hashScript(entry.content),
            ok: res.exitCode === 0,
            outputs: outputsProducedDuring(figuresDir, startMs, Date.now()),
            ranAt: new Date().toISOString(),
          };
          if (res.exitCode !== 0) {
            scriptErrors.push(`${path}: ${(res.stderr || res.stdout).slice(0, 500)}`);
          }
        }
        saveFigureManifest(paperDir, manifest);

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
        await writer.prompt(
          `Build round ${round} failed. Fix and finish:\n` +
            problems.map((p) => `- ${p}`).join("\n") +
            (audit.missing.length > 0
              ? `\nAvailable citation keys: ${bibKeys.join(", ")}`
              : "") +
            (figAudit.problems.length > 0
              ? `\nFigure requirements: write ${PHASE_KEY}/scripts/fig_*.py (exact path) that read the real CSVs (${dataFiles}) ` +
                `and save figures (PNG or PDF) to ${PHASE_KEY}/figures/; the pipeline runs them automatically; ` +
                `reference with \\includegraphics (no custom wrapper macros).`
              : "") +
            `\nUse write_file to update ${PHASE_KEY}/tex/${MAIN}.tex / ${PHASE_KEY}/scripts, then stop — the pipeline rebuilds.`,
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
