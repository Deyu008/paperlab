import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFigures } from "../src/tools/figure-audit.ts";

let base: string;
let figures: string;
let scripts: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-fig-"));
  figures = join(base, "figures");
  scripts = join(base, "scripts");
  mkdirSync(figures, { recursive: true });
  mkdirSync(scripts, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("auditFigures", () => {
  it("passes a clean paper: real includegraphics + existing png + script", () => {
    writeFileSync(join(figures, "fig1.png"), "png");
    writeFileSync(join(scripts, "fig_1.py"), "import matplotlib");
    const tex = `
\\begin{figure}
\\centering
\\includegraphics[width=0.8\\textwidth]{fig1}
\\caption{Real figure.}
\\end{figure}`;
    const audit = auditFigures(tex, figures, scripts);
    expect(audit.problems).toEqual([]);
    expect(audit.referenced).toEqual(["fig1.png"]);
  });

  it("flags the placeholder-macro dodge from the live run", () => {
    writeFileSync(join(figures, "fig_e1.png"), "png");
    const tex = `
\\newcommand{\\includefig}[1]{\\fbox{\\rule{0pt}{2in} placeholder}}
\\begin{figure}
\\includefig{fig_e1.png}
\\caption{Looks like a figure.}
\\end{figure}`;
    const audit = auditFigures(tex, figures, scripts);
    expect(audit.placeholderMacros).toContain("includefig");
    expect(audit.problems.some((p) => p.includes("includefig"))).toBe(true);
    expect(audit.problems.some((p) => p.includes("no scripts"))).toBe(true);
  });

  it("flags referenced images missing from figures/", () => {
    writeFileSync(join(scripts, "fig_1.py"), "x");
    const tex = `\\includegraphics{fig_missing.png}`;
    const audit = auditFigures(tex, figures, scripts);
    expect(audit.missing).toEqual(["fig_missing.png"]);
  });

  it("flags figure environments without any file reference", () => {
    const tex = `
\\begin{figure}
\\centering
\\fbox{placeholder}
\\caption{No image here.}
\\end{figure}`;
    const audit = auditFigures(tex, figures, scripts);
    expect(audit.envsWithoutFile).toBe(1);
  });

  it("demands at least one figure when the paper has none", () => {
    const audit = auditFigures("no figures at all", figures, scripts);
    expect(audit.problems.some((p) => p.includes("no figures at all"))).toBe(true);
  });
});
