/**
 * Prefix-stability regression tests (context-cache optimization).
 *
 * Implicit provider caches (bigmodel/zai, DeepSeek, vLLM…) hash the request
 * prefix: system prompt, tools, then messages. Any volatile byte in the
 * first two destroys the hit for the whole session. These tests pin the
 * prefix shape so a future edit that leaks timestamps/random order into the
 * serialized request fails CI instead of silently doubling cost.
 * See docs/cache-optimization.md.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { ROLES, reviewerPrompt, REVIEWER_PERSONAS } from "../src/roles/index.ts";
import { createLiteratureTools } from "../src/tools/literature-tools.ts";
import { createExperimentTools } from "../src/tools/experiment-tools.ts";
import { LocalSandbox } from "../src/tools/sandbox.ts";
import { mkdtempSync } from "node:fs";
import { wrapRuntimeForAffinity } from "../src/core/agent.ts";
import type { RoleKey } from "../src/config.ts";
import { RunStore } from "../src/core/run-store.ts";

const ROLE_KEYS: RoleKey[] = ["phd", "postdoc", "mlengineer", "writer", "reviewer", "ac"];

describe("request prefix stability", () => {
  it("role system prompts are byte-identical across repeated construction", () => {
    for (const key of ROLE_KEYS) {
      const a = ROLES[key].systemPrompt;
      const b = ROLES[key].systemPrompt;
      expect(a).toBe(b);
      expect(a).not.toMatch(/\d{2}:\d{2}:\d{2}/); // no wall-clock leakage
      expect(a).not.toMatch(/new Date|Date\.now|toISOString/);
    }
  });

  it("reviewer personas are deterministic", () => {
    const first = REVIEWER_PERSONAS.map((_, i) => reviewerPrompt(i));
    const second = REVIEWER_PERSONAS.map((_, i) => reviewerPrompt(i));
    expect(first).toEqual(second);
    for (const p of first) {
      expect(p).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    }
  });

  it("tool definitions serialize identically across construction (same session family)", () => {
    const mkStore = (tag: string) => RunStore.createNew(mkdtempSync(joinTmp()), tag, null);
    const noopFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    // Same inputs → identical serialized tool schema (order + bytes).
    const build = () => {
      const store = mkStore("prefix-probe");
      const tools = createLiteratureTools({
        store,
        maxSearches: 15,
        maxSnowballs: 6,
        maxFullReads: 6,
        fetchImpl: noopFetch,
      });
      const shaped = tools.map((t) => ({ name: t.name, description: t.description, params: JSON.stringify(t.parameters) }));
      store.writeText("x", "y", "cleanup-marker"); // ensure store usable
      return shaped;
    };
    // Two constructions in the same "session family" (same maxSearches etc.)
    // must produce identical schemas — tool order and schema bytes are part
    // of the cached prefix.
    expect(build()).toEqual(build());
  });

  it("experiment tool schemas are stable regardless of runtime budget counters", () => {
    const sandbox = new LocalSandbox(mkdtempSync(joinTmp()));
    const build = (max: number) => {
      const tools = createExperimentTools({ sandbox, maxToolCalls: max, stepTimeoutSec: 60 });
      return tools.map((t) => ({ name: t.name, params: JSON.stringify(t.parameters) }));
    };
    // Budget VALUE may differ across runs; it must not appear in the schema
    // (only in tool results), so schemas stay byte-stable within a family.
    expect(build(60)).toEqual(build(60));
    for (const t of build(60)) {
      expect(t.params).not.toContain('"maxToolCalls"');
    }
  });
});

describe("cache affinity wrapper", () => {
  it("splices affinity headers and forwards sessionId + retention", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeRuntime = {
      streamSimple: (_model: unknown, _context: unknown, opts: Record<string, unknown>) => {
        calls.push(opts ?? {});
        return {};
      },
    } as never;
    const wrapped = wrapRuntimeForAffinity(fakeRuntime, "run-x:03-experiment:mlengineer");
    await (wrapped.streamSimple as never as (m: unknown, c: unknown, o: unknown) => Promise<unknown>)(
      {},
      {},
      { headers: { "x-existing": "1" } },
    );
    expect(calls).toHaveLength(1);
    const opts = calls[0] as { headers: Record<string, string>; sessionId: string; cacheRetention: string };
    expect(opts.headers["x-session-affinity"]).toBe("run-x:03-experiment:mlengineer");
    expect(opts.headers["x-client-request-id"]).toBe("run-x:03-experiment:mlengineer");
    expect(opts.headers["x-existing"]).toBe("1");
    expect(opts.sessionId).toBe("run-x:03-experiment:mlengineer");
    expect(opts.cacheRetention).toBe("long");
  });

  it("no affinity id → runtime passed through untouched", () => {
    const fake = { streamSimple: () => ({}) } as never;
    expect(wrapRuntimeForAffinity(fake, undefined)).toBe(fake);
  });
});

function joinTmp(): string {
  return tmpdir();
}
