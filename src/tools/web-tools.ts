/**
 * Web tools backed by bigmodel's Coding-Plan MCP servers.
 *
 *   web_search    → webSearchPrime (query → titles/urls/snippets)
 *   read_web_page → webReader (url → page title/body as text)
 *
 * Positioning (enforced in prompts and artifacts): web sources are
 * ENGINEERING CONTEXT — baseline repos, dataset availability, leaderboards,
 * docs. They are NOT literature: they never enter references.bib, they land
 * in web-sources.jsonl with full provenance, and they carry their own
 * budgets. Numbers quoted from a web page must come from the page text the
 * tool returned (same honesty rule as the literature funnel).
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../core/run-store.ts";
import type { McpClient } from "./mcp.ts";
import { mcpResultText } from "./mcp.ts";

export interface WebToolOptions {
  store: RunStore;
  maxSearches: number;
  maxReads: number;
  /** Initialized MCP clients (pass null to omit that tool). */
  search: McpClient | null;
  reader: McpClient | null;
}

const PHASE = "01-literature";
const MAX_PAGE_CHARS = 12_000;

export function createWebTools(options: WebToolOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { store } = options;
  let searchesUsed = 0;
  let readsUsed = 0;

  const audit = (record: Record<string, unknown>): void => {
    store.appendJsonl(PHASE, "usage-audit.jsonl", { ts: new Date().toISOString(), ...record });
  };

  const logSource = (record: Record<string, unknown>): void => {
    store.appendJsonl(PHASE, "web-sources.jsonl", { ts: new Date().toISOString(), ...record });
  };

  if (options.search) {
    const web_search = defineTool({
      name: "web_search",
      label: "Web search",
      description:
        "Search the open web (engineering context only: baseline repos, dataset availability, " +
        "leaderboards, docs). NOT a literature source — formal papers come from search_papers. " +
        "Numbers you take from a result must appear in its snippet if you cite them anywhere.",
      promptSnippet: "web_search(query) — engineering context on the open web",
      parameters: Type.Object({
        query: Type.String({ description: "Web search query" }),
      }),
      async execute(_id, params) {
        if (searchesUsed >= options.maxSearches) {
          return text(`WEB SEARCH BUDGET EXHAUSTED (${options.maxSearches} used).`);
        }
        searchesUsed++;
        try {
          const result = await options.search!.callTool("webSearchPrime", { query: params.query });
          const body = mcpResultText(result);
          audit({ kind: "web_search", query: params.query, chars: body.length });
          logSource({ kind: "search", query: params.query, result: body.slice(0, 4_000) });
          return text(`Web results for "${params.query}" (engineering context, not citations):\n\n${body.slice(0, 6_000)}`);
        } catch (e) {
          audit({ kind: "web_search", query: params.query, chars: 0, error: (e as Error).message.slice(0, 200) });
          return text(`Web search failed: ${(e as Error).message}`);
        }
      },
    });
    tools.push(web_search);
  }

  if (options.reader) {
    const read_web_page = defineTool({
      name: "read_web_page",
      label: "Read web page",
      description:
        "Fetch one web page as text (repo README, dataset page, docs, leaderboard). Same rule as " +
        "web_search: engineering context, not citations.",
      promptSnippet: "read_web_page(url) — fetch a page as text",
      parameters: Type.Object({
        url: Type.String({ description: "http(s) URL to read" }),
      }),
      async execute(_id, params) {
        if (readsUsed >= options.maxReads) {
          return text(`WEB READ BUDGET EXHAUSTED (${options.maxReads} used).`);
        }
        if (!/^https:\/\//i.test(params.url)) {
          return text("Rejected: only https:// URLs.");
        }
        readsUsed++;
        try {
          const result = await options.reader!.callTool("webReader", { url: params.url });
          const body = mcpResultText(result);
          audit({ kind: "web_read", url: params.url, chars: body.length });
          logSource({ kind: "read", url: params.url, result: body.slice(0, 6_000) });
          const trimmed = body.length > MAX_PAGE_CHARS ? body.slice(0, MAX_PAGE_CHARS) + "\n…(truncated)" : body;
          return text(`Content of ${params.url}:\n\n${trimmed}`);
        } catch (e) {
          audit({ kind: "web_read", url: params.url, chars: 0, error: (e as Error).message.slice(0, 200) });
          return text(`Web read failed: ${(e as Error).message}`);
        }
      },
    });
    tools.push(read_web_page);
  }

  return tools;
}

function text(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
