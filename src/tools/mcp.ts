/**
 * Minimal zero-dependency MCP (Model Context Protocol) client over the
 * Streamable HTTP transport — just enough to drive remote tool servers
 * (bigmodel web_search_prime / web_reader): initialize, tools/list,
 * tools/call.
 *
 * Handles the two response modes the spec allows (plain JSON and
 * text/event-stream), the `mcp-session-id` handshake, and Bearer auth.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpClientOptions {
  endpoint: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  clientName?: string;
  /** Wire protocol version offered during initialize. */
  protocolVersion?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Extract the JSON-RPC payload from an SSE body (last data: line that parses). */
export function parseSsePayload(body: string): JsonRpcResponse | null {
  const dataLines = body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0);
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]!) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  return null;
}

const noopFetch: FetchLike = (async () => new Response("", { status: 503 })) as FetchLike;

export function createMcpClient(options: McpClientOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 60_000;
  let sessionId: string | null = null;
  let protocolVersion = options.protocolVersion ?? "2025-03-26";
  let nextId = 1;
  let initialized = false;

  async function rpc(
    method: string,
    params: Record<string, unknown>,
    opts: { notify?: boolean } = {},
  ): Promise<unknown | null> {
    const id = nextId++;
    const message = opts.notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    let res: Response;
    try {
      res = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${options.apiKey}`,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(opts.notify ? {} : { "mcp-protocol-version": protocolVersion }),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new McpError(`${method}: transport error — ${(e as Error).message}`);
    }
    const headerSession = res.headers.get("mcp-session-id");
    if (headerSession) sessionId = headerSession;

    if (opts.notify || res.status === 202) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      throw new McpError(
        `${method}: HTTP ${res.status} — ${raw.slice(0, 200) || "(empty body)"}`,
        res.status,
        raw.slice(0, 2_000),
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    let payload: JsonRpcResponse | null;
    if (contentType.includes("text/event-stream")) {
      payload = parseSsePayload(raw);
    } else {
      try {
        payload = JSON.parse(raw) as JsonRpcResponse;
      } catch {
        throw new McpError(`${method}: non-JSON response — ${raw.slice(0, 200)}`, res.status, raw.slice(0, 2_000));
      }
    }
    if (!payload) throw new McpError(`${method}: no parsable JSON-RPC payload in response`, res.status, raw.slice(0, 200));
    if (payload.error) {
      throw new McpError(`${method}: ${payload.error.message ?? "unknown RPC error"}`, res.status);
    }
    return payload.result ?? null;
  }

  return {
    /** Handshake: initialize + initialized notification. Idempotent per client. */
    async initialize(): Promise<void> {
      if (initialized) return;
      const result = (await rpc("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: options.clientName ?? "paperlab", version: "0.1.0" },
      })) as { protocolVersion?: string } | null;
      if (result?.protocolVersion) protocolVersion = result.protocolVersion;
      await rpc("notifications/initialized", {}, { notify: true });
      initialized = true;
    },

    async listTools(): Promise<McpToolInfo[]> {
      const result = (await rpc("tools/list", {})) as { tools?: McpToolInfo[] } | null;
      return result?.tools ?? [];
    },

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
      const result = (await rpc("tools/call", { name, arguments: args })) as McpCallResult | null;
      return result ?? { content: [] };
    },

    get isInitialized(): boolean {
      return initialized;
    },
  };
}

export type McpClient = ReturnType<typeof createMcpClient>;

/** Pull the joined text out of an MCP tool result. */
export function mcpResultText(result: McpCallResult): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Dead env var helper kept separate from process.env for testability. */
export function envOr(env: NodeJS.ProcessEnv | undefined, ...names: string[]): string | undefined {
  const source = env ?? process.env;
  for (const name of names) {
    const value = source[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
