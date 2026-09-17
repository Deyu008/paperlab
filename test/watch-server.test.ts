import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatchServer } from "../src/web/server.ts";

let base: string;
let server: Awaited<ReturnType<typeof startWatchServer>> | null = null;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-watch-"));
  mkdirSync(join(base, "logs"), { recursive: true });
  mkdirSync(join(base, "01-literature"), { recursive: true });
  writeFileSync(
    join(base, "state.json"),
    JSON.stringify({
      topic: "test topic",
      createdAt: new Date().toISOString(),
      phases: { "01-literature": { status: "done", attempts: 1 } },
    }),
  );
  writeFileSync(
    join(base, "01-literature", "papers.jsonl"),
    JSON.stringify({ title: "A Paper", year: 2021 }) + "\n",
  );
  writeFileSync(
    join(base, "tokens.jsonl"),
    JSON.stringify({ ts: "t", phase: "01-literature", role: "phd", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.001 }) + "\n",
  );
});

afterEach(async () => {
  server?.close();
  server = null;
  rmSync(base, { recursive: true, force: true });
});

describe("watch server", () => {
  it("serves state, usage, artifacts, and accepts steering posts", async () => {
    server = await startWatchServer(base, 0);
    const root = `http://127.0.0.1:${server.port}`;

    const page = await fetch(`${root}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("run panel");

    const state = (await (await fetch(`${root}/api/state`)).json()) as {
      topic: string;
      phases: Array<{ key: string; status: string }>;
    };
    expect(state.topic).toBe("test topic");
    expect(state.phases.find((p) => p.key === "01-literature")?.status).toBe("done");
    expect(state.phases.find((p) => p.key === "06-review")?.status).toBe("pending");

    const usage = (await (await fetch(`${root}/api/usage`)).json()) as {
      totals: { inputTokens: number; costUsd: number | null };
    };
    expect(usage.totals.inputTokens).toBe(10);
    expect(usage.totals.costUsd).toBeCloseTo(0.001);

    const artifacts = (await (await fetch(`${root}/api/artifacts`)).json()) as {
      papers: Array<{ title: string }>;
    };
    expect(artifacts.papers[0]?.title).toBe("A Paper");

    const pdf = await fetch(`${root}/api/paper`);
    expect(pdf.status).toBe(404); // not compiled in this fixture

    const steer = await fetch(`${root}/api/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "03-experiment", text: "tighten the seed budget" }),
    });
    expect(steer.status).toBe(200);
    const mailboxFile = join(base, "steering.jsonl");
    expect(existsSync(mailboxFile)).toBe(true);
    const posted = JSON.parse(readFileSync(mailboxFile, "utf8")) as { target: string; text: string };
    expect(posted.target).toBe("03-experiment");
    expect(posted.text).toBe("tighten the seed budget");

    const bad = await fetch(`${root}/api/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "any", text: "   " }),
    });
    expect(bad.status).toBe(400);
  });

  it("extracts recent activity from transcripts", async () => {
    writeFileSync(
      join(base, "logs", "03-experiment-mlengineer.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "run_python", arguments: { path: "e1.py" } }],
        },
      }) + "\n",
    );
    server = await startWatchServer(base, 0);
    const activity = (await (await fetch(`http://127.0.0.1:${server.port}/api/activity`)).json()) as {
      activity: Array<{ role: string; kind: string; detail: string }>;
    };
    const entry = activity.activity.find((a) => a.kind === "tool");
    expect(entry?.role).toBe("03-experiment-mlengineer");
    expect(entry?.detail).toContain("run_python");
  });
});
