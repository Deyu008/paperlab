import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSandbox, runChild, resolveHealthyPython } from "../src/tools/sandbox.ts";
import { createExperimentTools } from "../src/tools/experiment-tools.ts";

let base: string;
let sandbox: LocalSandbox;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-sbx-"));
  sandbox = new LocalSandbox(join(base, "workspace"));
});

afterEach(async () => {
  await sandbox.destroy();
  rmSync(base, { recursive: true, force: true });
});

describe("LocalSandbox", () => {
  it("writes, reads, and lists workspace files", () => {
    sandbox.writeFile("experiments/a.py", "print('hi')");
    sandbox.writeFile("data/b.csv", "x\n1\n");
    expect(sandbox.readFile("experiments/a.py")).toBe("print('hi')");
    expect(sandbox.readFile("nope.py")).toBeNull();
    const files = sandbox.listFiles();
    expect(files).toContain("experiments/a.py");
    expect(files).toContain("data/b.csv");
  });

  it("rejects path escapes", () => {
    expect(() => sandbox.writeFile("../escape.py", "x")).toThrow(/escapes workspace/);
    expect(() => sandbox.readFile("/etc/passwd")).toThrow(/escapes workspace/);
  });

  it("executes python in the workspace with venv isolation", async () => {
    sandbox.writeFile("hello.py", "print('hello from sandbox')\nimport sys\nprint(sys.prefix)");
    const res = await sandbox.exec(["python3", "hello.py"], 120);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello from sandbox");
    // venv prefix, not the system python
    expect(res.stdout).toContain(".venv");
  });

  it("captures failures and timeouts", async () => {
    sandbox.writeFile("fail.py", "raise ValueError('boom')");
    const fail = await sandbox.exec(["python3", "fail.py"], 60);
    expect(fail.exitCode).not.toBe(0);
    expect(fail.stderr).toContain("ValueError");

    sandbox.writeFile("slow.py", "import time; time.sleep(30)");
    const slow = await sandbox.exec(["python3", "slow.py"], 1);
    expect(slow.timedOut).toBe(true);
  }, 30_000);
});

describe("runChild output trimming", () => {
  it("trims very large outputs with head+tail", { timeout: 30_000 }, async () => {
    const python = await resolveHealthyPython();
    const res = await runChild([python, "-c", "print('x' * 100000)"], {
      timeoutSec: 30,
      maxOutputChars: 1_000,
    });
    expect(res.stdout.length).toBeLessThan(2_000);
    expect(res.stdout).toContain("truncated");
  });
});

describe("experiment tools", () => {
  it("run_python reports exit code, budget, and metrics count", async () => {
    const tools = createExperimentTools({ sandbox, maxToolCalls: 2, stepTimeoutSec: 60 });
    const run = tools.find((t) => t.name === "run_python")!;
    sandbox.writeFile("exp.py", "print('done')");
    sandbox.writeFile("metrics.jsonl", JSON.stringify({ experiment: "e", metric: "m", value: 1, higher_is_better: true }) + "\n");
    const out = await run.execute("id", { path: "exp.py" }, undefined, undefined, {} as never);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("exit code: 0");
    expect(text).toContain("Tool calls used: 1/2");
    expect(text).toContain("metrics.jsonl now has 1 records");
  });

  it("enforces the tool budget and remembers errors", async () => {
    const tools = createExperimentTools({ sandbox, maxToolCalls: 1, stepTimeoutSec: 60 });
    const run = tools.find((t) => t.name === "run_python")!;
    sandbox.writeFile("bad.py", "raise RuntimeError('first failure')");
    const fail = (await run.execute("id", { path: "bad.py" }, undefined, undefined, {} as never))
      .content[0] as { text: string };
    expect(fail.text).toContain("RECENT ERRORS");
    expect(fail.text).toContain("first failure");
    const blocked = (await run.execute("id", { path: "bad.py" }, undefined, undefined, {} as never))
      .content[0] as { text: string };
    expect(blocked.text).toContain("TOOL BUDGET EXHAUSTED");
  });

  it("write_file rejects escapes through the tool layer too", async () => {
    const tools = createExperimentTools({ sandbox, maxToolCalls: 5, stepTimeoutSec: 60 });
    const write = tools.find((t) => t.name === "write_file")!;
    const out = await write.execute("id", { path: "../x", content: "x" }, undefined, undefined, {} as never);
    expect((out.content[0] as { text: string }).text).toMatch(/Rejected: .*escapes/);
  });
});
