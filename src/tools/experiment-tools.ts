/**
 * pi tool definitions for the experiment phase.
 *
 * The ML engineer drives the sandbox exclusively through these tools:
 *   write_file / read_file / list_files — workspace-scoped file access
 *   run_python                          — execute python (venv or container)
 *
 * run_python enforces the tool-call budget and surfaces recent error history
 * ("DO NOT REPEAT") on failures, implementing the bounded debug loop.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Sandbox } from "./sandbox.ts";

export interface ExperimentToolOptions {
  sandbox: Sandbox;
  maxToolCalls: number;
  stepTimeoutSec: number;
}

const RECENT_ERRORS = 4;

export function createExperimentTools(options: ExperimentToolOptions): ToolDefinition[] {
  const { sandbox } = options;
  let callsUsed = 0;
  const recentErrors: string[] = [];

  const budgetNote = () => `Tool calls used: ${callsUsed}/${options.maxToolCalls}.`;

  function errorHistory(): string {
    if (recentErrors.length === 0) return "";
    return (
      `\n\nRECENT ERRORS (do not repeat these — change your approach):\n` +
      recentErrors.map((e, i) => `${i + 1}. ${e.slice(0, 300)}`).join("\n")
    );
  }

  function rememberError(stderr: string): void {
    const firstLine = stderr.split("\n").find((l) => l.includes("Error") || l.includes("error")) ?? stderr;
    const snippet = firstLine.trim().slice(0, 200);
    if (snippet && !recentErrors.includes(snippet)) {
      recentErrors.push(snippet);
      while (recentErrors.length > RECENT_ERRORS) recentErrors.shift();
    }
  }

  const write_file = defineTool({
    name: "write_file",
    label: "Write file",
    description: "Write a file into the experiment workspace (creates parent dirs). Paths are workspace-relative.",
    promptSnippet: "write_file(path, content) — create/overwrite a workspace file",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path, e.g. experiments/baseline.py" }),
      content: Type.String({ description: "Full file content" }),
    }),
    async execute(_id, params) {
      try {
        sandbox.writeFile(params.path, params.content);
        return text(`Wrote ${params.path} (${params.content.length} bytes).`);
      } catch (e) {
        return text(`Rejected: ${(e as Error).message}`);
      }
    },
  });

  const read_file = defineTool({
    name: "read_file",
    label: "Read file",
    description: "Read a workspace file (e.g. metrics.jsonl, a CSV you produced, or your own script).",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path" }),
    }),
    async execute(_id, params) {
      const content = sandbox.readFile(params.path);
      if (content === null) return text(`No such file: ${params.path}`);
      const max = 8_000;
      const body = content.length > max ? content.slice(0, max) + "\n...(truncated)" : content;
      return text(`${params.path}:\n\n${body}`);
    },
  });

  const list_files = defineTool({
    name: "list_files",
    label: "List files",
    description: "List workspace files (recursive) to see what exists.",
    parameters: Type.Object({}),
    async execute() {
      const files = sandbox.listFiles();
      return text(files.length === 0 ? "(workspace empty)" : files.join("\n"));
    },
  });

  const run_python = defineTool({
    name: "run_python",
    label: "Run python",
    description:
      "Run a python file in the sandbox working directory. Use for experiments, pip installs " +
      "(python3 -m pip install ...), and data generation. Every experiment must append its results to metrics.jsonl. " +
      `Each call has a ${options.stepTimeoutSec}s timeout.`,
    promptSnippet: `run_python(path) — execute a workspace python file (timeout ${options.stepTimeoutSec}s)`,
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path of the .py file to execute" }),
    }),
    async execute(_id, params) {
      if (callsUsed >= options.maxToolCalls) {
        return text(
          `TOOL BUDGET EXHAUSTED (${options.maxToolCalls} calls). ` +
            `Wrap up: verify metrics.jsonl is complete and summarize what was established.`,
        );
      }
      callsUsed++;
      const result = await sandbox.exec(
        ["python3", params.path],
        options.stepTimeoutSec,
      );
      const parts = [
        `exit code: ${result.exitCode ?? "spawn failure"}  (${(result.durationMs / 1000).toFixed(1)}s${result.timedOut ? ", TIMED OUT" : ""})`,
        budgetNote(),
      ];
      if (result.stdout.trim()) parts.push(`--- stdout ---\n${result.stdout}`);
      if (result.stderr.trim()) {
        parts.push(`--- stderr ---\n${result.stderr}`);
        if (result.exitCode !== 0) {
          rememberError(result.stderr);
          parts.push(errorHistory());
        }
      }
      const metrics = sandbox.readFile("metrics.jsonl");
      if (metrics) {
        const count = metrics.split("\n").filter((l) => l.trim()).length;
        parts.push(`--- metrics.jsonl now has ${count} records ---`);
      }
      return text(parts.join("\n"));
    },
  });

  return [write_file, read_file, list_files, run_python];
}

function text(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
