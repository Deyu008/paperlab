/**
 * Thin, typed wrapper around the pi coding-agent SDK.
 *
 * paperlab drives agents programmatically: each (phase, role) gets a fresh
 * in-memory session with a role system prompt, a minimal tool surface
 * (custom tools only by default — built-ins are opt-in), a transcript
 * logger, and usage accounting.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
  type CreateAgentSessionResult,
  type ToolDefinition,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ROLES } from "../roles/index.ts";
import type { RoleKey } from "../config.ts";

/**
 * Runtime override (embedding/tests): when set, every session uses this
 * ModelRuntime — e.g. one with a faux provider registered.
 */
let runtimeOverride: ModelRuntime | null = null;

export function setAgentRuntimeOverride(runtime: ModelRuntime | null): void {
  runtimeOverride = runtime;
}

export interface RoleSessionOptions {
  /** Role from the registry, or a raw system prompt for ad-hoc sessions. */
  role?: RoleKey;
  systemPrompt?: string;
  /** Working directory for the session (affects built-in tools' scope). */
  cwd: string;
  model: Model<any>;
  /** Custom tools to register. */
  customTools?: ToolDefinition[];
  /** Built-in tool names to enable. Empty/undefined = custom tools only. */
  builtinTools?: string[];
  /** Called for every session event (streaming, tool execution, ...). */
  onEvent?: (event: unknown) => void;
  /** Optional JSONL transcript sink (e.g. RunStore#transcript). */
  transcript?: { path: string; write: (record: unknown) => void };
}

export interface RoleSession extends CreateAgentSessionResult {
  /** Send one user turn and run the agent loop to completion. */
  prompt(text: string): Promise<void>;
  /** Last assistant text (or null). */
  lastAssistantText(): string | null;
  /** Summed token usage of the session so far. */
  usage(): UsageSummary;
  /** Transcript path when a sink was attached, else null. */
  readonly transcriptPath: string | null;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  model: string;
}

/** pi-ai Usage shape: { input, output, cacheRead, cacheWrite, cost: { total } }. */
interface AssistantLike {
  role: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}

interface TranscriptLike {
  write: (record: unknown) => void;
}

export async function createRoleSession(options: RoleSessionOptions): Promise<RoleSession> {
  const systemPrompt =
    options.systemPrompt ?? (options.role ? ROLES[options.role].systemPrompt : undefined);
  if (!systemPrompt) {
    throw new Error("createRoleSession: provide either `role` or `systemPrompt`");
  }

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  // Tool surface: custom tools are always enabled; built-ins are opt-in.
  // (An empty `tools` allowlist would disable custom tools too — pi treats a
  // provided list as exhaustive — so we use noTools:"builtin" instead.)
  const toolOptions =
    options.builtinTools && options.builtinTools.length > 0
      ? { tools: [...options.builtinTools, ...(options.customTools ?? []).map((t) => t.name)] }
      : { noTools: "builtin" as const };

  const result = await createAgentSession({
    cwd: options.cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    model: options.model,
    modelRuntime: runtimeOverride ?? undefined,
    customTools: options.customTools,
    ...toolOptions,
  });

  const transcript = options.transcript ? guardTranscript(options.transcript) : null;
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, costUsd: null, model: options.model.id };
  let sawUsage = false;

  result.session.subscribe((event: unknown) => {
    const e = event as { type?: string; message?: AssistantLike };
    if (transcript) transcript.write(event);
    if (e.type === "message_end" && e.message && e.message.role === "assistant") {
      const u = e.message.usage;
      if (u) {
        sawUsage = true;
        usage.inputTokens += u.input ?? 0;
        usage.outputTokens += u.output ?? 0;
        if (typeof u.cost?.total === "number") {
          usage.costUsd = (usage.costUsd ?? 0) + u.cost.total;
        }
      }
    }
    options.onEvent?.(event);
  });

  const prompt = async (text: string): Promise<void> => {
    await result.session.prompt(text);
  };

  const lastAssistantText = (): string | null => {
    const messages = result.session.state.messages as unknown as AssistantLike[];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant") {
        return extractText((m as { content?: unknown }).content);
      }
    }
    return null;
  };

  const wrapper: RoleSession = Object.assign(result, {
    prompt,
    lastAssistantText,
    usage: () => (sawUsage ? { ...usage } : { ...usage, costUsd: null }),
    transcriptPath: transcript?.path ?? null,
  }) as RoleSession;
  return wrapper;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: string; text: string } => {
        const block = b as { type?: string } | null;
        return !!block && block.type === "text";
      })
      .map((b) => b.text);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/**
 * Transcript growth guard (live-run lesson: one session wrote 29 GB).
 * Beyond the soft cap streaming deltas are dropped (message_end still keeps
 * full texts); beyond the hard cap everything but a truncation marker is.
 */
const TRANSCRIPT_SOFT_CAP = 100 * 1024 * 1024;
const TRANSCRIPT_HARD_CAP = 300 * 1024 * 1024;

function guardTranscript(sink: { path: string; write: (record: unknown) => void }): {
  path: string;
  write: (record: unknown) => void;
} {
  let written = 0;
  let announcedHardCap = false;
  return {
    path: sink.path,
    write: (record: unknown) => {
      const e = record as { type?: string; assistantMessageEvent?: { type?: string } };
      if (written >= TRANSCRIPT_HARD_CAP) {
        if (!announcedHardCap) {
          announcedHardCap = true;
          sink.write({ type: "transcript_truncated", reason: "hard cap reached", bytes: written });
        }
        return;
      }
      if (written >= TRANSCRIPT_SOFT_CAP) {
        // Deltas are the bulk; message_end events carry the full content.
        if (e.type === "message_update" || e.type === "tool_execution_update") return;
      }
      const size = (() => {
        try {
          return JSON.stringify(record).length;
        } catch {
          return 4_096;
        }
      })();
      written += size;
      sink.write(record);
    },
  };
}
