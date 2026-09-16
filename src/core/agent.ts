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
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ROLES } from "../roles/index.ts";
import type { RoleKey } from "../config.ts";

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
  usage(): { inputTokens: number; outputTokens: number; model: string };
  /** Transcript path when a sink was attached, else null. */
  readonly transcriptPath: string | null;
}

interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

interface AssistantLike {
  role: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
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

  const result = await createAgentSession({
    cwd: options.cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    model: options.model,
    customTools: options.customTools,
    // Only explicitly allowlisted built-ins are enabled; dialogue roles get none.
    tools: options.builtinTools ?? [],
  });

  const transcript = options.transcript ?? null;
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, model: options.model.id };

  result.session.subscribe((event: unknown) => {
    const e = event as { type?: string; message?: AssistantLike };
    if (transcript) transcript.write(event);
    if (e.type === "message_end" && e.message && e.message.role === "assistant") {
      usage.inputTokens += e.message.usage?.inputTokens ?? 0;
      usage.outputTokens += e.message.usage?.outputTokens ?? 0;
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
    usage: () => ({ ...usage }),
    transcriptPath: transcript?.path ?? null,
  }) as RoleSession;
  return wrapper;
}

function extractText(content: unknown): string | null {
  if (typeof content !== "string") {
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
  return content;
}
