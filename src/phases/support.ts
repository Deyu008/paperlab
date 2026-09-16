/**
 * Shared helpers for phase implementations.
 */
import type { PhaseContext } from "../orchestrator.ts";
import { createRoleSession, type RoleSession } from "../core/agent.ts";
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
  const model = resolveRoleModel(ctx.config, role);
  const session = await createRoleSession({
    role: options.systemPrompt ? undefined : role,
    systemPrompt: options.systemPrompt,
    cwd: ctx.store.root,
    model,
    customTools: options.tools,
    transcript: ctx.store.transcript(phase, role),
    onEvent: (event) => {
      const e = event as { type?: string; assistantMessageEvent?: { type?: string } };
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        return; // keep console output readable: deltas are in the transcript
      }
      if (e.type && ["turn_start", "turn_end", "message_start", "message_end"].includes(e.type)) {
        ctx.log(`  · ${role}: ${e.type}`);
      }
    },
  });

  const replies: string[] = [];
  try {
    for (const p of prompts) {
      await session.prompt(p);
      replies.push(session.lastAssistantText() ?? "");
    }
  } finally {
    const usage = session.usage();
    ctx.store.recordUsage({
      ts: new Date().toISOString(),
      phase,
      role,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: null,
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
  close: () => void;
}> {
  const { ctx, phase, role } = options;
  const model = resolveRoleModel(ctx.config, role);
  const session = await createRoleSession({
    role: options.systemPrompt ? undefined : role,
    systemPrompt: options.systemPrompt,
    cwd: ctx.store.root,
    model,
    customTools: options.tools,
    transcript: ctx.store.transcript(phase, role),
  });
  let closed = false;
  return {
    session,
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
        costUsd: null,
      });
      session.session.dispose();
    },
  };
}
