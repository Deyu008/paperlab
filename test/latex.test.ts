import { describe, it, expect } from "vitest";
import { parsePdflatexLog, compileLatex } from "../src/tools/latex.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Double-quoted lines: LaTeX logs mix backticks and apostrophes freely.
const LOG = [
  "This is pdfTeX, Version 3.141592653-2.6-1.40.25",
  '("main.tex"',
  "LaTeX Warning: Citation `doe2021study' on page 1 undefined on input line 42.",
  "LaTeX Warning: Reference `fig:results' on page 2 undefined on input line 88.",
  "! Undefined control sequence.",
  "l.88 \\badcommand",
  "File `figures/missing.png' not found.",
  "LaTeX Warning: There were undefined references.",
  "Overfull \\hbox (12.3pt too wide) in paragraph at lines 10--12",
  "[1] [2]",
  "Output written on main.pdf (7 pages, 34210 bytes).",
].join("\n");

describe("parsePdflatexLog", () => {
  it("extracts errors, citations, references, missing files, pages", () => {
    const { errors, warnings, pages } = parsePdflatexLog(LOG);
    expect(errors.some((e) => e.kind === "error" && e.message.includes("Undefined control sequence"))).toBe(true);
    expect(errors.some((e) => e.kind === "citation" && e.message.includes("doe2021study"))).toBe(true);
    expect(errors.some((e) => e.kind === "reference" && e.message.includes("fig:results"))).toBe(true);
    expect(errors.some((e) => e.kind === "file" && e.message.includes("figures/missing.png"))).toBe(true);
    expect(pages).toBe(7);
    expect(warnings.some((w) => w.includes("Overfull"))).toBe(true);
  });

  it("includes one line of context after hard errors", () => {
    const { errors } = parsePdflatexLog(LOG);
    const err = errors.find((e) => e.kind === "error");
    expect(err?.message).toContain("l.88 \\badcommand");
  });

  it("dedups repeated errors across compile passes", () => {
    const { errors } = parsePdflatexLog(LOG + "\n" + LOG);
    expect(errors.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  it("handles clean logs", () => {
    const clean = parsePdflatexLog("Output written on main.pdf (3 pages, 100 bytes).\n");
    expect(clean.errors).toEqual([]);
    expect(clean.pages).toBe(3);
  });
});

// Env-gated: runs only where a real tectonic binary is available
// (PAPERLAB_TEXTEST=1), e.g. dev machines — not CI.
const tectonicTest = process.env.PAPERLAB_TEXTEST === "1" ? describe : describe.skip;

tectonicTest("compileLatex (tectonic backend)", () => {
  it("compiles with bibtex and reports undefined citations", { timeout: 300_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "paperlab-tex-"));
    try {
      writeFileSync(
        join(dir, "main.tex"),
        [
          "\\documentclass{article}",
          "\\begin{document}",
          "Hello \\cite{doe2021study} and \\cite{missingkey2020}.",
          "\\bibliographystyle{plain}",
          "\\bibliography{references}",
          "\\end{document}",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "references.bib"),
        "@article{doe2021study, title={A Study}, author={Jane Doe}, year={2021}}\n",
      );
      const result = await compileLatex(dir, "main", "tectonic", true);
      expect(result.pdfPath).not.toBeNull();
      expect(result.pages).toBe(1);
      // doe2021study resolves via bibtex; missingkey2020 must be flagged.
      expect(result.errors.some((e) => e.kind === "citation" && e.message.includes("missingkey2020"))).toBe(true);
      expect(result.errors.some((e) => e.kind === "citation" && e.message.includes("doe2021study"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
