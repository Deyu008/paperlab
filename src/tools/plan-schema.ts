/**
 * Research plan schema + validation (phase 2).
 *
 * The plan is the contract between the planning dialogue and the experiment
 * phase; validation is enforced in the submit_plan tool so a malformed plan
 * bounces back to the agent instead of corrupting downstream phases.
 */

export interface PlanExperiment {
  name: string;
  purpose: string;
  procedure: string;
  dataset: string;
  metric: string;
  target: string;
  fallback: string;
}

export interface ResearchPlan {
  research_question: string;
  hypothesis: string;
  /** Must reference at least one saved paper by title (novelty grounding). */
  novelty: string;
  experiments: PlanExperiment[];
  success_criteria: string;
  risks: string[];
}

export function isResearchPlan(v: unknown): v is ResearchPlan {
  return (
    typeof v === "object" && v !== null && "research_question" in v && "experiments" in v && Array.isArray((v as { experiments: unknown }).experiments)
  );
}

/**
 * Validate a candidate plan. Returns human-readable errors (empty = valid).
 * `knownTitles` are the titles from papers.jsonl — the novelty statement must
 * engage with at least one of them so "novel compared to what?" has an answer.
 */
export function validatePlan(plan: unknown, knownTitles: string[]): string[] {
  const errors: string[] = [];
  if (!isResearchPlan(plan)) {
    return ["plan must be an object with research_question, hypothesis, novelty, experiments, success_criteria, risks"];
  }
  const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  if (!str(plan.research_question)) errors.push("research_question: required non-empty string");
  if (!str(plan.hypothesis)) errors.push("hypothesis: required non-empty string");
  if (!str(plan.novelty)) errors.push("novelty: required non-empty string");

  const lowerNovelty = plan.novelty.toLowerCase();
  const referenced = knownTitles.filter((t) => {
    // Bag-of-words match on distinctive title words (long titles get paraphrased).
    const words = t.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9-]/g, "")).filter((w) => w.length > 3);
    if (words.length === 0) return false;
    const needed = Math.min(3, words.length);
    const found = words.filter((w) => lowerNovelty.includes(w)).length;
    return found >= needed;
  });
  if (knownTitles.length > 0 && referenced.length === 0) {
    errors.push(
      "novelty: must explicitly compare against at least one saved paper " +
        `(quote (part of) its title); known titles: ${knownTitles.slice(0, 5).map((t) => `"${t}"`).join(", ")}`,
    );
  }

  if (plan.experiments.length === 0) {
    errors.push("experiments: at least one experiment is required");
  }
  plan.experiments.forEach((exp, i) => {
    const prefix = `experiments[${i}]`;
    const required: Array<[keyof PlanExperiment, string]> = [
      ["name", "name"],
      ["purpose", "purpose"],
      ["procedure", "procedure (how to run it, CPU-friendly)"],
      ["dataset", "dataset (source or synthesis procedure)"],
      ["metric", "metric (name + direction)"],
      ["target", "target (what counts as success)"],
      ["fallback", "fallback (what to conclude if it fails)"],
    ];
    for (const [field, label] of required) {
      if (!str(exp[field])) errors.push(`${prefix}.${label}: required non-empty string`);
    }
  });

  if (!str(plan.success_criteria)) errors.push("success_criteria: required non-empty string");
  if (!Array.isArray(plan.risks) || plan.risks.length === 0) {
    errors.push("risks: required non-empty array of strings");
  } else if (plan.risks.some((r) => !str(r))) {
    errors.push("risks: every entry must be a non-empty string");
  }
  return errors;
}
