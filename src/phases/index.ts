/**
 * Phase registry. Phases are implemented milestone by milestone; the
 * pipeline shape (keys + dependencies + gates) is fixed from the start so
 * the CLI, resume logic, and docs stay stable.
 */
import { Pipeline, type Phase } from "../orchestrator.ts";
import { literaturePhase } from "./1-literature.ts";

function notImplemented(key: string, name: string): Phase {
  return {
    key,
    name,
    dependsOn: DEPENDS[key] ?? [],
    async run() {
      throw new Error(`${name} is not implemented yet (milestone in progress)`);
    },
  };
}

const DEPENDS: Record<string, readonly string[]> = {
  "01-literature": [],
  "02-plan": ["01-literature"],
  "03-experiment": ["02-plan"],
  "04-interpret": ["03-experiment"],
  "05-paper": ["04-interpret"],
  "06-review": ["05-paper"],
};

/** Gates (human approval points when copilot mode is on). */
const GATES: ReadonlySet<string> = new Set(["02-plan", "05-paper"]);

export function buildPipeline(): Pipeline {
  const phases: Phase[] = [
    literaturePhase,
    notImplemented("02-plan", "Research plan formulation"),
    notImplemented("03-experiment", "Experiment execution"),
    notImplemented("04-interpret", "Results interpretation"),
    notImplemented("05-paper", "Paper writing"),
    notImplemented("06-review", "Peer review and revision"),
  ].map((phase) => ({ ...phase, gate: GATES.has(phase.key) }));

  return new Pipeline(phases);
}
