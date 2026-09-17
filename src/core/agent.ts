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
  ModelRuntime,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
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

/**
 * Shared default runtime for production sessions (no override). Built once
 * per agentDir, offline (auth.json + models.json + static builtin catalog).
 * IMPORTANT: without a runtime here, affinity headers are never injected —
 * `wrapRuntimeForAffinity` can only splice headers on a runtime we hand to
 * the SDK ourselves. A review found the affinity optimization was dead code
 * on the default path for exactly this reason.
 */
const sharedRuntimes = new Map<string, Promise<ModelRuntime>>();
type RuntimeFactory = (agentDir: string) => Promise<ModelRuntime>;
let defaultRuntimeFactory: RuntimeFactory | null = null;

/** Test seam: inject a factory (also resets the shared cache). Pass null to restore. */
export function setDefaultRuntimeFactoryForTests(factory: RuntimeFactory | null): void {
  defaultRuntimeFactory = factory;
  sharedRuntimes.clear();
}

async function sharedDefaultRuntime(agentDir: string): Promise<ModelRuntime | null> {
  let pending = sharedRuntimes.get(agentDir);
  if (!pending) {
    const factory: RuntimeFactory =
      defaultRuntimeFactory ??
      ((dir) =>
        ModelRuntime.create({
          authPath: join(dir, "auth.json"),
          modelsPath: join(dir, "models.json"),
          refreshOnCreate: false, // offline: builtins + auth.json suffice; no startup network probe
        }));
    pending = factory(agentDir).catch((e: unknown) => {
      sharedRuntimes.delete(agentDir); // don't cache a failure
      throw e;
    });
    sharedRuntimes.set(agentDir, pending);
  }
  try {
    return await pending;
  } catch (e) {
    // Unusable agentDir (corrupt auth.json, ...): fall back to the SDK default.
    console.warn(`[paperlab] shared model runtime unavailable — using SDK default (${(e as Error).message})`);
    return null;
  }
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
  /**
   * Stable cache-affinity id for this session (e.g. "<run>:<phase>:<role>").
   * Sent as `x-session-affinity`/`x-client-request-id` headers so
   * multi-replica providers (bigmodel/zai) route all turns of a session to
   * the same replica — implicit prefix caches are per-replica, and bouncing
   * replicas was the cause of 0% cache hits in live runs.
   */
  cacheAffinityId?: string;
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
  /** Provider-reported cached input tokens (implicit prefix cache hits). */
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
    cacheRead?: number;
    cacheWrite?: number;
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

  // Cache affinity requires a runtime we control (headers are spliced into
  // provider requests). On the override path it's always available; on the
  // production path we build the shared default runtime so affinity applies.
  let modelRuntime: ModelRuntime | undefined;
  if (runtimeOverride) {
    modelRuntime = wrapRuntimeForAffinity(runtimeOverride, options.cacheAffinityId);
  } else if (options.cacheAffinityId) {
    const shared = await sharedDefaultRuntime(getAgentDir());
    modelRuntime = shared ? wrapRuntimeForAffinity(shared, options.cacheAffinityId) : undefined;
  }

  const result = await createAgentSession({
    cwd: options.cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    model: options.model,
    modelRuntime,
    customTools: options.customTools,
    ...toolOptions,
  });

  const transcript = options.transcript ? guardTranscript(options.transcript) : null;
  const usage: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    model: options.model.id,
  };
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
        usage.cacheReadTokens += u.cacheRead ?? 0;
        usage.cacheWriteTokens += u.cacheWrite ?? 0;
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
 *
 * Size accounting: streaming deltas are the overwhelming majority of events
 * and are individually tiny — JSON.stringify-ing every one just to count
 * bytes doubled the CPU/GC cost of transcription. Deltas are estimated;
 * structural events are measured.
 */
const TRANSCRIPT_SOFT_CAP = 100 * 1024 * 1024;
const TRANSCRIPT_HARD_CAP = 300 * 1024 * 1024;
const DELTA_SIZE_ESTIMATE = 192;

/**
 * Cache-affinity: splice per-session routing headers into every provider
 * request so multi-replica OpenAI-compatible fleets (bigmodel/zai included)
 * keep one session on one replica. Implicit prefix caches are per-replica —
 * a two-turn session that bounces replicas gets 0% hit on turn 2, which is
 * exactly what live runs showed. Also forwards the id as prompt-cache-key
 * options for providers that honor them.
 */
export function wrapRuntimeForAffinity(runtime: ModelRuntime, affinityId?: string): ModelRuntime {
  if (!affinityId) return runtime;
  const spliced = Object.create(Object.getPrototypeOf(runtime)) as ModelRuntime;
  Object.assign(spliced, runtime);
  const original = runtime.streamSimple.bind(runtime);
  spliced.streamSimple = ((model: never, context: never, opts: Record<string, unknown> | undefined) => {
    const headers = { ...((opts?.headers as Record<string, string>) ?? {}) };
    headers["x-session-affinity"] = affinityId;
    headers["x-client-request-id"] = affinityId;
    return original(model, context, {
      ...(opts ?? {}),
      headers,
      sessionId: affinityId,
      cacheRetention: "long",
    }) as never;
  }) as typeof runtime.streamSimple;
  return spliced;
}

function guardTranscript(sink: { path: string; write: (record: unknown) => void }): {
  path: string;
  write: (record: unknown) => void;
} {
  let written = 0;
  let announcedHardCap = false;
  return {
    path: sink.path,
    write: (record: unknown) => {
      // Stamp events with a receive timestamp — the panel timeline needs it
      // (engine events do not carry one).
      const stamped = record as { _ts?: string };
      if (stamped && typeof stamped === "object" && !stamped._ts) stamped._ts = new Date().toISOString();
      const e = record as { type?: string };
      if (written >= TRANSCRIPT_HARD_CAP) {
        if (!announcedHardCap) {
          announcedHardCap = true;
          sink.write({ type: "transcript_truncated", reason: "hard cap reached", bytes: written });
        }
        return;
      }
      const isDelta = e.type === "message_update" || e.type === "tool_execution_update";
      if (written >= TRANSCRIPT_SOFT_CAP && isDelta) {
        // Deltas are the bulk; message_end events carry the full content.
        return;
      }
      if (isDelta) {
        written += DELTA_SIZE_ESTIMATE;
      } else {
        try {
          written += JSON.stringify(record).length;
        } catch {
          written += 4_096;
        }
      }
      sink.write(record);
    },
  };
}
