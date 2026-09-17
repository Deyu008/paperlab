/** Micro-bench: 50k delta events through the buffered transcript sink. Run: npx tsx scripts/bench-transcript.ts */
import { RunStore } from "../src/core/run-store.ts";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "bench-"));
const store = RunStore.createNew(base, "bench", null);
const sink = store.transcript("01-literature", "phd");
const t0 = process.hrtime.bigint();
for (let i = 0; i < 50_000; i++) sink.write({ type: "message_update", i, delta: "x".repeat(64) });
store.flushAll();
const t1 = process.hrtime.bigint();
console.log(`50k buffered events: ${(Number(t1 - t0) / 1e6).toFixed(0)} ms; file ${(statSync(sink.path).size / 1024).toFixed(0)} KB`);

// Reference: the old path (appendFileSync per event).
const { appendFileSync } = await import("node:fs");
const raw = join(base, "raw.jsonl");
const t2 = process.hrtime.bigint();
for (let i = 0; i < 50_000; i++) appendFileSync(raw, JSON.stringify({ type: "message_update", i, delta: "x".repeat(64) }) + "\n");
const t3 = process.hrtime.bigint();
console.log(`50k unbuffered events: ${(Number(t3 - t2) / 1e6).toFixed(0)} ms`);
rmSync(base, { recursive: true, force: true });
