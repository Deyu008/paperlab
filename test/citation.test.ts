import { describe, it, expect } from "vitest";
import { extractCiteKeys, extractBibKeys, auditCitations } from "../src/tools/citation.ts";

const TEX = `
As shown by prior work \\cite{doe2021study, smith2020deep}, and also
\\citep[see][p. 3]{jones2022wide} and \\textcite*{lee2019fast}, methods differ.
`;

const BIB = `
@article{doe2021study,
  title = {A Study},
}
@article{smith2020deep,
  title = {Deep Stuff},
}
@article{lee2019fast,
  title = {Fast Things},
}
@article{unused2023paper, title={Never Cited}}
`;

describe("citation audit", () => {
  it("extracts keys from all cite variants", () => {
    expect(extractCiteKeys(TEX).sort()).toEqual(["doe2021study", "jones2022wide", "lee2019fast", "smith2020deep"]);
  });

  it("extracts bib keys", () => {
    expect(extractBibKeys(BIB)).toEqual(["doe2021study", "smith2020deep", "lee2019fast", "unused2023paper"]);
  });

  it("flags missing and uncited keys", () => {
    const audit = auditCitations(TEX, BIB);
    expect(audit.missing).toEqual(["jones2022wide"]);
    expect(audit.uncited).toEqual(["unused2023paper"]);
  });

  it("clean paper audits clean", () => {
    const audit = auditCitations("Simple \\cite{doe2021study}.", "@article{doe2021study, title={X}}");
    expect(audit.missing).toEqual([]);
    expect(audit.uncited).toEqual([]);
  });
});
