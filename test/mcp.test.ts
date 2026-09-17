import { describe, it, expect } from "vitest";
import { createMcpClient, parseSsePayload, McpError } from "../src/tools/mcp.ts";

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function scriptedFetch(script: Array<{ match: (body: Record<string, unknown>) => boolean; status?: number; respond: (req: RecordedRequest) => { json?: unknown; sse?: unknown; status?: number; headers?: Record<string, string> } }>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const entry = script.find((s) => s.match(body));
    if (!entry) throw new Error(`unexpected RPC: ${String(body.method)}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    requests.push({ url: String(url), headers, body });
    const out = entry.respond({ url: String(url), headers, body });
    const h = new Headers({ "content-type": out.sse !== undefined ? "text/event-stream" : "application/json", ...(out.headers ?? {}) });
    const payload = out.sse !== undefined
      ? `event: message\ndata: ${JSON.stringify(out.sse)}\n\n`
      : JSON.stringify(out.json ?? {});
    return new Response(payload, { status: out.status ?? 200, headers: h });
  };
  return { fetchImpl, requests };
}

describe("parseSsePayload", () => {
  it("extracts the last parsable data line", () => {
    const body = 'event: message\ndata: {"id":1,"result":{"a":1}}\n\nevent: ping\ndata: not-json\n\n';
    expect(parseSsePayload(body)).toEqual({ id: 1, result: { a: 1 } });
  });
});

describe("mcp client over streamable http", () => {
  it("handshakes, propagates the session id, lists and calls tools", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      {
        match: (b) => b.method === "initialize",
        respond: (req) => ({
          json: { id: req.body.id, result: { protocolVersion: "2025-03-26", capabilities: {} } },
          headers: { "mcp-session-id": "sess-42" },
        }),
      },
      { match: (b) => b.method === "notifications/initialized", respond: () => ({ status: 202 }) },
      {
        match: (b) => b.method === "tools/list",
        respond: (req) => ({
          json: { id: req.body.id, result: { tools: [{ name: "webSearchPrime", description: "search" }] } },
        }),
      },
      {
        match: (b) => b.method === "tools/call",
        respond: (req) => ({
          json: {
            id: req.body.id,
            result: { content: [{ type: "text", text: "result-text" }], isError: false },
          },
        }),
      },
    ]);
    const client = createMcpClient({
      endpoint: "https://mcp.example/mcp",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["webSearchPrime"]);
    const call = await client.callTool("webSearchPrime", { query: "x" });

    // Auth + session headers on every request after initialize.
    for (const r of requests) {
      expect(r.headers["authorization"]).toBe("Bearer sk-test");
      if (r.body.method !== "initialize") expect(r.headers["mcp-session-id"]).toBe("sess-42");
    }
    expect(call.content[0]).toMatchObject({ type: "text", text: "result-text" });
    // tools/call carried the arguments through.
    const callReq = requests.find((r) => r.body.method === "tools/call")!;
    expect((callReq.body.params as { arguments: unknown }).arguments).toEqual({ query: "x" });
  });

  it("parses SSE-shaped responses", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        match: (b) => b.method === "initialize",
        respond: (req) => ({
          sse: { id: req.body.id, result: { protocolVersion: "2025-03-26" } },
        }),
      },
      { match: (b) => b.method === "notifications/initialized", respond: () => ({ status: 202 }) },
      {
        match: (b) => b.method === "tools/call",
        respond: (req) => ({
          sse: { id: req.body.id, result: { content: [{ type: "text", text: "sse-ok" }] } },
        }),
      },
    ]);
    const client = createMcpClient({
      endpoint: "https://mcp.example/mcp",
      apiKey: "k",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.initialize();
    const call = await client.callTool("anything", {});
    expect(call.content[0]).toMatchObject({ text: "sse-ok" });
  });

  it("surfaces RPC errors as McpError", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        match: (b) => b.method === "initialize",
        respond: (req) => ({
          json: { id: req.body.id, error: { code: -32001, message: "unauthorized" } },
        }),
      },
    ]);
    const client = createMcpClient({
      endpoint: "https://mcp.example/mcp",
      apiKey: "bad",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.initialize()).rejects.toBeInstanceOf(McpError);
  });
});
