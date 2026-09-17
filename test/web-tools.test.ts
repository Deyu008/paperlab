import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebTools } from "../src/tools/web-tools.ts";
import { RunStore } from "../src/core/run-store.ts";
import type { McpClient, McpCallResult } from "../src/tools/mcp.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

let base: string;
let store: RunStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-web-"));
  store = RunStore.createNew(base, "test topic", null);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function fakeClient(response: McpCallResult, calls: Array<{ tool: string; args: Record<string, unknown> }>): McpClient {
  return {
    callTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return response;
    },
  } as unknown as McpClient;
}

async function call(tool: ToolDefinition, params: unknown): Promise<string> {
  const result = await tool.execute("id", params as never, undefined, undefined, {} as never);
  return (result.content[0] as { text: string }).text;
}

describe("web tools", () => {
  it("empty when both clients are null (graceful degradation)", () => {
    const tools = createWebTools({ store, maxSearches: 5, maxReads: 5, search: null, reader: null });
    expect(tools).toEqual([]);
  });

  it("web_search returns text, logs source + audit, enforces budget", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = fakeClient(
      { content: [{ type: "text", text: '[{"title":"Repo","url":"https://github.com/x/y","snippet":"baseline code"}]' }], isError: false },
      calls,
    );
    const tools = createWebTools({ store, maxSearches: 1, maxReads: 5, search: client, reader: null });
    const search = tools.find((t) => t.name === "web_search")!;
    const first = await call(search, { query: "bagging baseline repo" });
    expect(first).toContain("not citations");
    expect(first).toContain("baseline code");
    expect(calls[0]).toEqual({ tool: "webSearchPrime", args: { query: "bagging baseline repo" } });

    const blocked = await call(search, { query: "more" });
    expect(blocked).toMatch(/WEB SEARCH BUDGET EXHAUSTED/);

    const sources = store.readJsonl<{ kind: string; query: string }>("01-literature", "web-sources.jsonl");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: "search", query: "bagging baseline repo" });
    const audit = store.readJsonl<{ kind: string }>("01-literature", "usage-audit.jsonl");
    expect(audit.some((a) => a.kind === "web_search")).toBe(true);
  });

  it("read_web_page rejects non-https urls", async () => {
    const client = fakeClient({ content: [{ type: "text", text: "page" }] }, []);
    const tools = createWebTools({ store, maxSearches: 5, maxReads: 1, search: null, reader: client });
    const read = tools.find((t) => t.name === "read_web_page")!;
    expect(await call(read, { url: "http://insecure.example" })).toMatch(/only https/);
  });

  it("reader failures degrade to a message, not a crash", async () => {
    const failing = {
      callTool: async () => {
        throw new Error("upstream 502");
      },
    } as unknown as McpClient;
    const tools = createWebTools({ store, maxSearches: 5, maxReads: 5, search: null, reader: failing });
    const read = tools.find((t) => t.name === "read_web_page")!;
    const out = await call(read, { url: "https://example.com/page" });
    expect(out).toMatch(/Web read failed.*502/);
    const audit = store.readJsonl<{ kind: string; error?: string }>("01-literature", "usage-audit.jsonl");
    expect(audit.some((a) => a.kind === "web_read" && a.error?.includes("502"))).toBe(true);
  });
});
