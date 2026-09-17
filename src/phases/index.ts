/**
 * Phase registry: keys, dependencies, and copilot gates are fixed; phase
 * implementations live in ./N-name.ts files.
 */
import { Pipeline, type Phase } from "../orchestrator.ts";
import { literaturePhase } from "./1-literature.ts";
import { planPhase } from "./2-plan.ts";
import { experimentPhase } from "./3-experiment.ts";
import { interpretPhase } from "./4-interpret.ts";
import { paperPhase } from "./5-paper.ts";
import { reviewPhase } from "./6-review.ts";

/** Gates (human approval points when copilot mode is on). */
const GATES: ReadonlySet<string> = new Set(["02-plan", "05-paper"]);

export function buildPipeline(): Pipeline {
  const phases: Phase[] = [
    literaturePhase,
    planPhase,
    experimentPhase,
    interpretPhase,
    paperPhase,
    reviewPhase,
  ].map((phase) => ({ ...phase, gate: GATES.has(phase.key) }));

  return new Pipeline(phases);
}
