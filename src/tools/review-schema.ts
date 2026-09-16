/**
 * Review schemas (phase 6).
 *
 * Reviews are structured so downstream consumers (AC, revision, report) can
 * reason about them programmatically. The `checks` field records artifact
 * verifications the reviewer performed — the anti-fabrication centerpiece:
 * a review that checked nothing is a weak review.
 */

export type Decision = "accept" | "weak-accept" | "weak-reject" | "reject";

export interface ArtifactCheck {
  item: string;
  passed: boolean;
  note: string;
}

export interface ReviewRecord {
  reviewer: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  checks: ArtifactCheck[];
  soundness: number; // 1-5
  clarity: number; // 1-5
  novelty: number; // 1-5
  overall: number; // 1-10
  confidence: number; // 1-5
  decision: Decision;
}

export interface MetaReview {
  summary: string;
  resolved_disagreements: string[];
  overall: number; // 1-10, consistent with soundness
  decision: Decision;
  required_revisions: string[];
}

const DECISIONS: Decision[] = ["accept", "weak-accept", "weak-reject", "reject"];

function score(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

export function validateReview(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return ["review must be an object"];
  const r = raw as Partial<ReviewRecord>;
  const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  if (!str(r.reviewer)) errors.push("reviewer: required non-empty string");
  if (!str(r.summary)) errors.push("summary: required non-empty string");
  if (!Array.isArray(r.strengths) || r.strengths.length === 0) errors.push("strengths: required non-empty array");
  if (!Array.isArray(r.weaknesses) || r.weaknesses.length === 0) errors.push("weaknesses: required non-empty array");
  if (!Array.isArray(r.checks) || r.checks.length === 0) {
    errors.push("checks: required non-empty array — record the artifact checks you performed (e.g. numbers vs metrics.json)");
  } else {
    r.checks.forEach((c, i) => {
      if (typeof c !== "object" || c === null || !str(c.item) || typeof c.passed !== "boolean" || !str(c.note)) {
        errors.push(`checks[${i}]: each needs {item, passed, note}`);
      }
    });
  }
  if (!score(r.soundness, 1, 5)) errors.push("soundness: required number in [1,5]");
  if (!score(r.clarity, 1, 5)) errors.push("clarity: required number in [1,5]");
  if (!score(r.novelty, 1, 5)) errors.push("novelty: required number in [1,5]");
  if (!score(r.overall, 1, 10)) errors.push("overall: required number in [1,10]");
  if (!score(r.confidence, 1, 5)) errors.push("confidence: required number in [1,5]");
  if (!DECISIONS.includes(r.decision as Decision)) {
    errors.push(`decision: must be one of ${DECISIONS.join("|")}`);
  }
  // Consistency guard: sound science cannot coexist with a stellar overall.
  if (typeof r.soundness === "number" && typeof r.overall === "number" && r.soundness <= 2 && r.overall >= 8) {
    errors.push("inconsistency: soundness <= 2 but overall >= 8 — soundness must dominate");
  }
  return errors;
}

export function validateMetaReview(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return ["meta-review must be an object"];
  const m = raw as Partial<MetaReview>;
  const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  if (!str(m.summary)) errors.push("summary: required non-empty string");
  if (!Array.isArray(m.resolved_disagreements)) errors.push("resolved_disagreements: required array (may be empty)");
  if (!score(m.overall, 1, 10)) errors.push("overall: required number in [1,10]");
  if (!DECISIONS.includes(m.decision as Decision)) {
    errors.push(`decision: must be one of ${DECISIONS.join("|")}`);
  }
  if (!Array.isArray(m.required_revisions)) {
    errors.push("required_revisions: required array (empty only if decision is accept)");
  } else if (m.decision !== "accept" && m.required_revisions.length === 0) {
    errors.push("required_revisions: non-accept decisions must list revisions");
  }
  return errors;
}
