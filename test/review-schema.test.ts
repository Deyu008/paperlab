import { describe, it, expect } from "vitest";
import { validateReview, validateMetaReview, type ReviewRecord, type MetaReview } from "../src/tools/review-schema.ts";

function validReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewer: "Reviewer A",
    summary: "A modest but honest study.",
    strengths: ["claims match artifacts", "limitations stated"],
    weaknesses: ["single dataset family", "no error bars on one table"],
    checks: [
      { item: "Table 1 AUC 0.82 vs metrics.jsonl", passed: true, note: "exact match" },
      { item: "baseline number 0.76", passed: true, note: "found in records" },
      { item: "claimed 10% improvement", passed: false, note: "records show 6%" },
    ],
    soundness: 4,
    clarity: 4,
    novelty: 2,
    overall: 5,
    confidence: 4,
    decision: "weak-reject",
    ...overrides,
  };
}

function validMeta(overrides: Partial<MetaReview> = {}): MetaReview {
  return {
    summary: "Honest but incremental; the artifact trail is solid.",
    resolved_disagreements: ["Reviewer A flagged novelty, Reviewer C accepted it — delta over prior work is thin"],
    overall: 5,
    decision: "weak-reject",
    required_revisions: ["reframe contribution claims", "add error bars"],
    ...overrides,
  };
}

describe("validateReview", () => {
  it("accepts a well-formed review", () => {
    expect(validateReview(validReview())).toEqual([]);
  });

  it("requires recorded artifact checks", () => {
    expect(validateReview(validReview({ checks: [] }))[0]).toMatch(/checks/);
  });

  it("rejects inconsistent soundness/overall", () => {
    expect(validateReview(validReview({ soundness: 2, overall: 9 }))[0]).toMatch(/inconsistency/);
  });

  it("validates every field", () => {
    const broken = validReview();
    delete (broken as Partial<ReviewRecord>).summary;
    expect(validateReview(broken).some((e) => e.startsWith("summary"))).toBe(true);
    expect(validateReview(validReview({ decision: "maybe" as never }))[0]).toMatch(/decision/);
    expect(validateReview(validReview({ overall: 11 }))[0]).toMatch(/overall/);
    expect(validateReview("nope")[0]).toMatch(/must be an object/);
  });
});

describe("validateMetaReview", () => {
  it("accepts a well-formed meta-review", () => {
    expect(validateMetaReview(validMeta())).toEqual([]);
  });

  it("requires revisions for non-accept decisions", () => {
    expect(validateMetaReview(validMeta({ required_revisions: [] }))[0]).toMatch(/required_revisions/);
    expect(validateMetaReview(validMeta({ decision: "accept", required_revisions: [] }))).toEqual([]);
  });

  it("validates score ranges", () => {
    expect(validateMetaReview(validMeta({ overall: 0 }))[0]).toMatch(/overall/);
  });
});
