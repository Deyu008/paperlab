/**
 * Experiment sandbox.
 *
 * One sandbox per run. Preferred backend is Docker (per-run container,
 * workspace volume-mounted); LocalSandbox is the fallback (venv + subprocess,
 * cwd-confined). Both expose the same interface the experiment tools proxy to.
 */
import { spawn, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Sandbox {
  readonly backend: "docker" | "local";
  readonly workspace: string;
  /** Execute a shell command inside the sandbox workspace. */
  exec(command: string[], timeoutSec: number, stdin?: string): Promise<RunResult>;
  /** Write a file inside the workspace (path-confined). */
  writeFile(path: string, content: string): void;
  /** Read a file inside the workspace (path-confined); null if missing. */
  readFile(path: string): string | null;
  /** List files under a workspace subpath (recursive, relative paths). */
  listFiles(path?: string): string[];
  /** Tear down (stop container / remove venv). */
  destroy(): Promise<void>;
}

const DOCKER_IMAGE = "python:3.12-slim";
const MAX_LIST = 200;

/** Reject paths that try to escape the workspace. */
function confine(workspace: string, path: string): string {
  const abs = isAbsolute(path) ? path : join(workspace, path);
  const resolved = resolve(abs);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${path}`);
  }
  return resolved;
}

/** Write with parent-dir creation. */
function writeHostFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function listRecursive(root: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === ".venv" || name === "__pycache__") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(root, name);
    try {
      if (statSync(full).isDirectory()) {
        out.push(...listRecursive(full, rel));
      } else {
        out.push(rel);
      }
    } catch {
      // unreadable entry — skip
    }
    if (out.length >= MAX_LIST) break;
  }
  return out.slice(0, MAX_LIST);
}

/** Run a child process with timeout + trimmed output capture. */
export function runChild(
  command: string[],
  options: { cwd?: string; timeoutSec: number; stdin?: string; maxOutputChars?: number },
): Promise<RunResult> {
  const maxOutput = options.maxOutputChars ?? 12_000;
  const started = Date.now();
  return new Promise((resolvePromise) => {
    // Own process group: on timeout we kill the WHOLE tree. Killing only the
    // direct child orphaned grandchildren, which on WSL2 spin at 100% CPU
    // forever (found in live testing).
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutSec * 1000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < maxOutput * 2) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < maxOutput * 2) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolvePromise({
        exitCode: null,
        stdout: trimOutput(stdout, maxOutput),
        stderr: trimOutput(stderr + `\nspawn error: ${err.message}`, maxOutput),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Leader closed — sweep the group for orphaned grandchildren.
      setTimeout(killGroup, 50);
      resolvePromise({
        exitCode: code,
        stdout: trimOutput(stdout, maxOutput),
        stderr: trimOutput(stderr, maxOutput),
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function trimOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max / 2));
  const tail = s.slice(-Math.floor(max / 2));
  return `${head}\n...[truncated ${s.length - max} chars]...\n${tail}`;
}

// ---------------------------------------------------------------------------
// Docker backend
// ---------------------------------------------------------------------------

export class DockerSandbox implements Sandbox {
  readonly backend = "docker" as const;
  private readonly container: string;

  private constructor(
    readonly workspace: string,
    container: string,
  ) {
    this.container = container;
  }

  static async create(workspace: string): Promise<DockerSandbox> {
    mkdirSync(workspace, { recursive: true });
    const container = `paperlab-${randomUUID().slice(0, 12)}`;
    const res = await runChild(
      [
        "docker", "run", "-d", "--rm",
        "--name", container,
        "--network", "bridge",
        "-v", `${resolve(workspace)}:/workspace`,
        "-w", "/workspace",
        DOCKER_IMAGE,
        "sleep", "infinity",
      ],
      { timeoutSec: 120 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`failed to start sandbox container: ${res.stderr || res.stdout}`);
    }
    return new DockerSandbox(workspace, container);
  }

  async exec(command: string[], timeoutSec: number, stdin?: string): Promise<RunResult> {
    const wrapped = ["timeout", "--signal=KILL", `${Math.max(1, timeoutSec)}s`, ...command];
    return runChild(
      ["docker", "exec", "-w", "/workspace", "-i", this.container, ...wrapped],
      { timeoutSec: timeoutSec + 30, stdin },
    );
  }

  writeFile(path: string, content: string): void {
    // Workspace is volume-mounted, so host writes are visible in the container.
    writeHostFile(confine(this.workspace, path), content);
  }

  readFile(path: string): string | null {
    // Confine BEFORE the try: escapes must throw, not read as "missing".
    const target = confine(this.workspace, path);
    try {
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  }

  listFiles(path?: string): string[] {
    return listRecursive(confine(this.workspace, path ?? "."));
  }

  async destroy(): Promise<void> {
    await runChild(["docker", "kill", this.container], { timeoutSec: 30 }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Local backend (fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve a working python3 interpreter. PATH order can front a broken
 * interpreter (live incident: a miniconda python hung at 100% CPU even on
 * `print`), so candidates are probed with a trivial program and the first
 * healthy one wins. Result is cached.
 */
let healthyPythonCache: string | null = null;

export async function resolveHealthyPython(): Promise<string> {
  if (healthyPythonCache) return healthyPythonCache;
  const candidates = ["/usr/bin/python3", "/bin/python3", "python3"];
  for (const candidate of candidates) {
    const probe = await runChild([candidate, "-c", "print(1)"], { timeoutSec: 8 });
    if (probe.exitCode === 0 && probe.stdout.trim() === "1") {
      healthyPythonCache = candidate;
      return candidate;
    }
  }
  throw new Error("no working python3 found (probed: " + candidates.join(", ") + ")");
}

export class LocalSandbox implements Sandbox {
  readonly backend = "local" as const;
  readonly venvDir: string;
  private venvReady = false;

  constructor(readonly workspace: string) {
    mkdirSync(workspace, { recursive: true });
    this.venvDir = join(workspace, ".venv");
  }

  /** venv python path (created lazily on first exec). */
  private async python(): Promise<string> {
    const pyBin = join(this.venvDir, "bin", "python");
    if (!this.venvReady || !existsSync(pyBin)) {
      const base = await resolveHealthyPython();
      const res = await runChild([base, "-m", "venv", this.venvDir], { timeoutSec: 120 });
      if (res.exitCode !== 0) {
        throw new Error(`failed to create venv: ${res.stderr}`);
      }
      this.venvReady = true;
    }
    return pyBin;
  }

  async exec(command: string[], timeoutSec: number, stdin?: string): Promise<RunResult> {
    // Substitute `python3`/`pip` with the venv versions when possible.
    let resolved = command;
    if (command[0] === "python3" || command[0] === "python") {
      resolved = [await this.python(), ...command.slice(1)];
    }
    return runChild(resolved, { cwd: this.workspace, timeoutSec, stdin });
  }

  writeFile(path: string, content: string): void {
    writeHostFile(confine(this.workspace, path), content);
  }

  readFile(path: string): string | null {
    // Confine BEFORE the try: escapes must throw, not read as "missing".
    const target = confine(this.workspace, path);
    try {
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  }

  listFiles(path?: string): string[] {
    return listRecursive(confine(this.workspace, path ?? "."));
  }

  async destroy(): Promise<void> {
    rmSync(this.venvDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Factory + capability probes
// ---------------------------------------------------------------------------

export async function probeDocker(): Promise<boolean> {
  if (!existsSync("/.dockerenv") && !existsSync("/var/run/docker.sock")) {
    // WSL/docker-in-shell setups usually expose one of these.
    const which = await runChild(["sh", "-c", "command -v docker"], { timeoutSec: 10 });
    if (which.exitCode !== 0) return false;
  }
  const res = await runChild(["docker", "version", "--format", "{{.Server.Version}}"], { timeoutSec: 15 });
  return res.exitCode === 0 && !res.stderr.includes("Cannot connect");
}

export interface SandboxChoice {
  mode: "docker" | "local";
  reason: string;
}

/** Resolve the configured sandbox mode into a concrete choice. */
export async function chooseSandbox(configured: "docker" | "local" | "auto"): Promise<SandboxChoice> {
  if (configured === "local") return { mode: "local", reason: "configured" };
  const dockerOk = await probeDocker();
  if (dockerOk) return { mode: "docker", reason: configured === "docker" ? "configured" : "auto-detected" };
  if (configured === "docker") {
    throw new Error("sandbox=docker configured but Docker is not available");
  }
  return { mode: "local", reason: "auto: Docker unavailable, using local fallback" };
}

export async function createSandbox(choice: SandboxChoice, workspace: string): Promise<Sandbox> {
  return choice.mode === "docker" ? DockerSandbox.create(workspace) : Promise.resolve(new LocalSandbox(workspace));
}

/** Convenience for scripts/tests: execFile promisified. */
export function execFileQuiet(file: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: 30_000 }, (err, stdout) => {
      resolvePromise({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, output: String(stdout) });
    });
  });
}
