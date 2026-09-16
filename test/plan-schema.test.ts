import { describe, it, expect } from "vitest";
import { validatePlan, type ResearchPlan } from "../src/tools/plan-schema.ts";

const TITLES = ["Gradient Boosting Revisited: A Systematic Study", "Tabular Deep Learning Is Not Dead Yet"];

function validPlan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
  return {
    research_question: "Do ensembles beat single models on small tabular data?",
    hypothesis: "Ensembling reduces variance enough to beat single gradient-boosted trees below 5k rows.",
    novelty:
      "Unlike \"Gradient Boosting Revisited: A Systematic Study\", which evaluates large datasets only, we study the small-data regime.",
    experiments: [
      {
        name: "small-data benchmark",
        purpose: "Compare ensemble vs single model across sample sizes",
        procedure: "Train both on subsampled splits with 5 seeds; sklearn only",
        dataset: "OpenML via sklearn fetch_openml, or synthetic make_classification",
        metric: "mean ROC-AUC (higher better)",
        target: "ensemble wins by >= 0.01 AUC at n<=5000",
        fallback: "if not, report where ensembles stop helping",
      },
    ],
    success_criteria: "A clear yes/no with variance across at least 3 dataset sizes",
    risks: ["small datasets may be too noisy", "compute limits seed counts"],
    ...overrides,
  };
}

describe("validatePlan", () => {
  it("accepts a well-formed plan", () => {
    expect(validatePlan(validPlan(), TITLES)).toEqual([]);
  });

  it("requires novelty to engage with a saved paper title", () => {
    const errors = validatePlan(
      validPlan({ novelty: "Our approach is completely new and different from everything." }),
      TITLES,
    );
    expect(errors.some((e) => e.startsWith("novelty:"))).toBe(true);
  });

  it("skips the novelty-title check when the library is empty", () => {
    expect(validatePlan(validPlan({ novelty: "First study of this kind." }), [])).toEqual([]);
  });

  it("rejects empty experiments and missing fields", () => {
    expect(validatePlan(validPlan({ experiments: [] }), TITLES)[0]).toMatch(/at least one experiment/);
    const broken = validPlan();
    broken.experiments[0]!.metric = "";
    expect(validatePlan(broken, TITLES).some((e) => e.includes("metric"))).toBe(true);
  });

  it("rejects non-array risks and non-plan objects", () => {
    expect(validatePlan(validPlan({ risks: [] }), TITLES)[0]).toMatch(/risks/);
    expect(validatePlan({ foo: 1 }, TITLES)[0]).toMatch(/must be an object/);
    expect(validatePlan(null, TITLES)[0]).toMatch(/must be an object/);
  });
});
