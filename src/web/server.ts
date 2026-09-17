/**
 * `paperlab watch` — live run panel.
 *
 * A zero-dependency HTTP server reading the run's artifact trail
 * (state.json, tokens.jsonl, transcripts, steering.jsonl) and serving a
 * single-page dashboard. The only write path is POST /api/steer, which
 * appends to the steering mailbox the pipeline drains.
 *
 * Endpoints:
 *   GET  /               dashboard page
 *   GET  /api/state      phase statuses + mailbox + topic
 *   GET  /api/usage      token/cost totals per phase
 *   GET  /api/activity   recent agent actions from the newest transcripts
 *   GET  /api/artifacts  papers / metrics / review / figures summary
 *   GET  /api/paper      the compiled PDF (if present)
 *   POST /api/steer      {target, text} → steering mailbox
 */
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { SteeringMailbox } from "../core/steering.ts";
import { PAGE } from "./page.ts";

interface PhaseStateLike {
  status: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is T => x !== undefined);
}

const PHASE_ORDER = [
  "01-literature",
  "02-plan",
  "03-experiment",
  "04-interpret",
  "05-paper",
  "06-review",
];

export interface WatchServer {
  server: Server;
  port: number;
  close: () => void;
}

export function startWatchServer(runRoot: string, port = 8787): Promise<WatchServer> {
  const mailbox = new SteeringMailbox(runRoot);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, "text/html; charset=utf-8", PAGE);
      } else if (req.method === "GET" && url.pathname === "/api/state") {
        const state = readJson<{ topic?: string; phases?: Record<string, PhaseStateLike> }>(
          join(runRoot, "state.json"),
          {},
        );
        send(res, 200, "application/json", {
          topic: state.topic ?? basename(runRoot),
          phases: PHASE_ORDER.map((key) => ({ key, ...(state.phases?.[key] ?? { status: "pending", attempts: 0 }) })),
          steering: mailbox.all(),
          runRoot,
        });
      } else if (req.method === "GET" && url.pathname === "/api/usage") {
        const usage = readJsonl<{ phase: string; role: string; inputTokens: number; outputTokens: number; costUsd: number | null }>(
          join(runRoot, "tokens.jsonl"),
        );
        const byPhase = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number | null; turns: number }>();
        let totals = { inputTokens: 0, outputTokens: 0, costUsd: null as number | null, turns: 0 };
        for (const u of usage) {
          const bucket = byPhase.get(u.phase) ?? { inputTokens: 0, outputTokens: 0, costUsd: null as number | null, turns: 0 };
          bucket.inputTokens += u.inputTokens;
          bucket.outputTokens += u.outputTokens;
          if (typeof u.costUsd === "number") bucket.costUsd = (bucket.costUsd ?? 0) + u.costUsd;
          bucket.turns++;
          byPhase.set(u.phase, bucket);
          totals.inputTokens += u.inputTokens;
          totals.outputTokens += u.outputTokens;
          if (typeof u.costUsd === "number") totals.costUsd = (totals.costUsd ?? 0) + u.costUsd;
          totals.turns++;
        }
        send(res, 200, "application/json", { totals, byPhase: [...byPhase.entries()] });
      } else if (req.method === "GET" && url.pathname === "/api/activity") {
        send(res, 200, "application/json", { activity: recentActivity(runRoot) });
      } else if (req.method === "GET" && url.pathname === "/api/artifacts") {
        send(res, 200, "application/json", artifactsSummary(runRoot));
      } else if (req.method === "GET" && url.pathname === "/api/paper") {
        const pdf = join(runRoot, "05-paper", "tex", "main.pdf");
        if (!existsSync(pdf)) {
          send(res, 404, "application/json", { error: "paper not compiled yet" });
        } else {
          send(res, 200, "application/pdf", readFileSync(pdf));
        }
      } else if (req.method === "POST" && url.pathname === "/api/steer") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 20_000) req.destroy();
        });
        req.on("end", () => {
          try {
            const { target, text } = JSON.parse(body) as { target?: string; text?: string };
            if (!text || text.trim().length === 0) {
              send(res, 400, "application/json", { error: "text required" });
              return;
            }
            const message = mailbox.post(target ?? "any", text);
            send(res, 200, "application/json", { ok: true, message });
          } catch (e) {
            send(res, 400, "application/json", { error: (e as Error).message });
          }
        });
      } else {
        send(res, 404, "application/json", { error: "not found" });
      }
    } catch (e) {
      send(res, 500, "application/json", { error: (e as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        close: () => server.close(),
      });
    });
  });
}

function send(
  res: import("node:http").ServerResponse,
  code: number,
  contentType: string,
  body: string | Buffer | Record<string, unknown> | Array<unknown>,
): void {
  const payload =
    typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": contentType, "cache-control": "no-store" });
  res.end(payload);
}

interface ActivityEntry {
  ts?: string;
  role: string;
  kind: "tool" | "text" | "error";
  detail: string;
}

/** Parse the newest transcripts into a recent-activity feed. */
function recentActivity(runRoot: string): ActivityEntry[] {
  const logsDir = join(runRoot, "logs");
  if (!existsSync(logsDir)) return [];
  const files = readdirSync(logsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: statSync(join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);
  const entries: ActivityEntry[] = [];
  for (const { f } of files) {
    const role = f.replace(/\.jsonl$/, "");
    const path = join(logsDir, f);
    const size = statSync(path).size;
    const start = Math.max(0, size - 96 * 1024);
    const tail = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(start > 0 ? start : 0);
    for (const line of tail.split("\n")) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e.type !== "message_end") continue;
      const message = e.message as { role?: string; content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }> } | undefined;
      if (!message?.content) continue;
      for (const block of message.content) {
        if (block.type === "toolCall") {
          entries.push({ ts: e.ts as string | undefined, role, kind: "tool", detail: `${block.name}(${summarizeArgs(block.arguments)})` });
        } else if (block.type === "text" && message.role === "assistant" && block.text) {
          entries.push({ role, kind: "text", detail: block.text.replace(/\s+/g, " ").slice(0, 160) });
        }
      }
      if (entries.length > 400) break;
    }
  }
  return entries.slice(-60).reverse();
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const entries = Object.entries(args as Record<string, unknown>);
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 40)}`)
    .join(", ");
}

function artifactsSummary(runRoot: string) {
  const papers = readJsonl<{ title: string; year?: number }>(join(runRoot, "01-literature", "papers.jsonl"));
  const metrics = readJson<{ metrics?: Array<{ experiment: string; metric: string; value: number | null; runs?: number }> }>(
    join(runRoot, "03-experiment", "metrics.json"),
    {},
  );
  const figuresDir = join(runRoot, "05-paper", "figures");
  const figures = existsSync(figuresDir) ? readdirSync(figuresDir).filter((f) => f.endsWith(".png")) : [];
  const reviews: Array<{ reviewer: string; overall: number; decision: string }> = readJson<
    Array<{ reviewer: string; overall: number; decision: string }>
  >(join(runRoot, "06-review", "round0-reviews.json"), []);
  const meta = readJson<{ decision?: string; overall?: number }>(join(runRoot, "06-review", "round0-meta.json"), {});
  return {
    papers: papers.map((p) => ({ title: p.title, year: p.year ?? null })),
    metrics: metrics.metrics ?? [],
    figures,
    reviews,
    meta,
    hasPdf: existsSync(join(runRoot, "05-paper", "tex", "main.pdf")),
  };
}
