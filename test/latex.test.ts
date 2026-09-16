import { describe, it, expect } from "vitest";
import { parsePdflatexLog } from "../src/tools/latex.ts";

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
