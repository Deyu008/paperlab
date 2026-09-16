/**
 * Public API for programmatic use.
 */
export * from "./config.ts";
export { resolveModel, resolveRoleModel, listCatalog, ModelResolutionError } from "./core/models.ts";
export { RunStore, slugify } from "./core/run-store.ts";
export type { RunState, PhaseState, UsageRecord } from "./core/run-store.ts";
export { createRoleSession } from "./core/agent.ts";
export type { RoleSession, RoleSessionOptions } from "./core/agent.ts";
export { ROLES, REVIEWER_PERSONAS, reviewerPrompt } from "./roles/index.ts";
export { Pipeline, PhaseFailedError } from "./orchestrator.ts";
export type { Phase, PhaseContext, RunOptions } from "./orchestrator.ts";
export { buildPipeline } from "./phases/index.ts";
