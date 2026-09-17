/**
 * Shared helpers for phase implementations.
 */
import type { PhaseContext } from "../orchestrator.ts";
import { createRoleSession, type RoleSession } from "../core/agent.ts";
import { SteeringMailbox, withSteering } from "../core/steering.ts";
import { applyModelOverride } from "../core/model-override.ts";
import { resolveRoleModel } from "../core/models.ts";
import type { RoleKey } from "../config.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface RunSessionOptions {
  phase: string;
  role: RoleKey;
  ctx: PhaseContext;
  tools?: ToolDefinition[];
  /** Ad-hoc system prompt override (e.g. reviewer personas). */
  systemPrompt?: string;
  /** Extra cache-affinity disambiguator (e.g. reviewer round or persona). */
  affinitySuffix?: string;
}

/**
 * Stable cache-affinity id: one per (run, phase, role[, suffix]) session
 * family. Same id across turns of a session keeps the provider replica (and
 * its implicit prefix cache) pinned; see docs/cache-optimization.md.
 */
function affinityIdFor(options: RunSessionOptions): string {
  const suffix = options.affinitySuffix ? `:${options.affinitySuffix}` : "";
  return `${options.ctx.store.root}:${options.phase}:${options.role}${suffix}`;
}

/**
 * Create a role session for a phase, wire the transcript, run the given user
 * prompts sequentially, record usage, and dispose. Returns the session's
 * final assistant text per prompt.
 */
export async function runRoleSession(
  options: RunSessionOptions,
  ...prompts: string[]
): Promise<{ session: RoleSession; replies: string[] }> {
  const { ctx, phase, role } = options;
  const model = resolveRoleModel(applyModelOverride(ctx.config, ctx.store.root), role);
  const session = await createRoleSession({
    role: options.systemPrompt ? undefined : role,
    systemPrompt: options.systemPrompt,
    cwd: ctx.store.root,
    model,
    customTools: options.tools,
    transcript: ctx.store.transcript(phase, role),
    cacheAffinityId: affinityIdFor(options),
    onEvent: (event) => {
      const e = event as { type?: string };
      // Full streams and message boundaries live in the transcript; the
      // console only notes completed tool work.
      if (e.type === "tool_execution_end") {
        const t = event as { toolName?: string };
        ctx.log(`  · ${role}: ${t.toolName ?? "tool"} done`);
      }
    },
  });

  const replies: string[] = [];
  const mailbox = new SteeringMailbox(ctx.store.root);
  try {
    for (const p of prompts) {
      await session.prompt(withSteering(mailbox.drain(phase, role), p));
      replies.push(session.lastAssistantText() ?? "");
    }
  } finally {
    ctx.store.flushAll();
    const usage = session.usage();
    ctx.store.recordUsage({
      ts: new Date().toISOString(),
      phase,
      role,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
    session.session.dispose();
  }
  return { session, replies };
}

/** Render usage stats for a run (used in phase summaries and final report). */
export async function readTotalUsage(ctx: PhaseContext): Promise<{ inputTokens: number; outputTokens: number }> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const p = join(ctx.store.root, "tokens.jsonl");
  if (!existsSync(p)) return { inputTokens: 0, outputTokens: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { inputTokens: number; outputTokens: number };
    inputTokens += rec.inputTokens;
    outputTokens += rec.outputTokens;
  }
  return { inputTokens, outputTokens };
}

/**
 * Open a role session the phase keeps across several prompts (dialogues).
 * Call close() when done — it records usage and disposes.
 */
export async function openRoleSession(options: RunSessionOptions): Promise<{
  session: RoleSession;
  /** Prompt with automatic steering injection (see SteeringMailbox). */
  prompt: (text: string) => Promise<void>;
  close: () => void;
}> {
  const { ctx, phase, role } = options;
  const model = resolveRoleModel(applyModelOverride(ctx.config, ctx.store.root), role);
  const session = await createRoleSession({
    role: options.systemPrompt ? undefined : role,
    systemPrompt: options.systemPrompt,
    cwd: ctx.store.root,
    model,
    customTools: options.tools,
    transcript: ctx.store.transcript(phase, role),
    onEvent: (event) => {
      const e = event as { type?: string };
      if (e.type === "tool_execution_end") {
        const t = event as { toolName?: string };
        ctx.log(`  · ${role}: ${t.toolName ?? "tool"} done`);
      }
    },
  });
  const mailbox = new SteeringMailbox(ctx.store.root);
  let closed = false;
  return {
    session,
    prompt: (text: string) => session.prompt(withSteering(mailbox.drain(phase, role), text)),
    close: () => {
      if (closed) return;
      closed = true;
      const u = session.usage();
      ctx.store.recordUsage({
        ts: new Date().toISOString(),
        phase,
        role,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costUsd: u.costUsd,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
      });
      session.session.dispose();
    },
  };
}
