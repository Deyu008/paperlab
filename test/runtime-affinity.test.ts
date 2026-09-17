/**
 * Regression: cache affinity on the PRODUCTION path.
 *
 * A full-review pass found that `createRoleSession` only applied
 * `wrapRuntimeForAffinity` when a runtime override was set (tests/embedding),
 * so live runs never sent `x-session-affinity` — the entire context-cache
 * optimization was dead code in production. These tests pin the wiring:
 * with no override, sessions route streaming through the shared default
 * runtime wrapped with per-session affinity headers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createRoleSession,
  setAgentRuntimeOverride,
  setDefaultRuntimeFactoryForTests,
} from "../src/core/agent.ts";

const PROVIDER = "faux-affinity";
const MODEL_ID = "affinity-model";

interface CapturedCall {
  headers: Record<string, string>;
  sessionId: unknown;
  cacheRetention: unknown;
}

let base: string;
let runtime: ModelRuntime;
const captured: CapturedCall[] = [];
let factoryCalls = 0;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "paperlab-affinity-"));
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL_ID }] });
  runtime = await ModelRuntime.create();
  runtime.registerNativeProvider(faux.provider);

  // Spy on the shared runtime's streamSimple — the affinity wrapper calls
  // through it, so captured opts show the FINAL request options.
  const original = runtime.streamSimple.bind(runtime);
  (runtime as unknown as { streamSimple: typeof runtime.streamSimple }).streamSimple = ((
    model: never,
    context: never,
    opts: { headers?: Record<string, string>; sessionId?: unknown; cacheRetention?: unknown },
  ) => {
    captured.push({
      headers: { ...(opts?.headers ?? {}) },
      sessionId: opts?.sessionId,
      cacheRetention: opts?.cacheRetention,
    });
    return original(model, context, opts as never);
  }) as typeof runtime.streamSimple;

  // Production path: NO runtime override; the shared-default factory provides
  // the runtime instead.
  setAgentRuntimeOverride(null);
  setDefaultRuntimeFactoryForTests(async () => {
    factoryCalls++;
    return runtime;
  });
  (runtime as unknown as { __faux: typeof faux }).__faux = faux;
});

afterAll(() => {
  setDefaultRuntimeFactoryForTests(null);
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("cache affinity on the default (production) runtime path", () => {
  it("sends affinity headers via the shared runtime, once per session", { timeout: 60_000 }, async () => {
    const faux = (runtime as unknown as { __faux: ReturnType<typeof fauxProvider> }).__faux;
    const model = faux.getModel();

    faux.setResponses([fauxAssistantMessage("first reply")]);
    const s1 = await createRoleSession({
      systemPrompt: "test",
      cwd: base,
      model,
      cacheAffinityId: "run1:01-literature:phd",
    });
    await s1.prompt("hello");
    s1.session.dispose();

    faux.setResponses([fauxAssistantMessage("second reply")]);
    const s2 = await createRoleSession({
      systemPrompt: "test",
      cwd: base,
      model,
      cacheAffinityId: "run1:02-plan:postdoc",
    });
    await s2.prompt("hello again");
    s2.session.dispose();

    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[0]!.headers["x-session-affinity"]).toBe("run1:01-literature:phd");
    expect(captured[0]!.headers["x-client-request-id"]).toBe("run1:01-literature:phd");
    expect(captured[1]!.headers["x-session-affinity"]).toBe("run1:02-plan:postdoc");
    for (const call of captured) {
      expect(call.cacheRetention).toBe("long");
    }

    // The shared runtime is built once per agentDir, not per session.
    expect(factoryCalls).toBe(1);
  });
});
