/**
 * LaTeX toolchain: probe, compile (pdflatex→bibtex→pdflatex×2 / tectonic /
 * docker), and structured log parsing. Compile failures must surface their
 * real errors to the writing agent — never a generic "compilation failed".
 */

export type LatexBackend = "pdflatex" | "tectonic" | "docker";
export type LatexModeConfig = "pdflatex" | "tectonic" | "docker" | "auto";

export interface LatexError {
  kind: "error" | "citation" | "reference" | "file" | "bibtex";
  message: string;
}

export interface CompileResult {
  ok: boolean;
  pdfPath: string | null;
  pages: number | null;
  errors: LatexError[];
  warnings: string[];
}

export const DOCKER_TEX_IMAGE = process.env.PAPERLAB_TEXIMAGE ?? "texlive/texlive";

import { runChild } from "./sandbox.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function commandExists(cmd: string): Promise<boolean> {
  const res = await runChild(["sh", "-c", `command -v ${cmd}`], { timeoutSec: 10 });
  return res.exitCode === 0;
}

/** Resolve the configured latex mode to a concrete backend (null = none usable). */
export async function probeLatex(mode: LatexModeConfig): Promise<LatexBackend | null> {
  const order: LatexBackend[] =
    mode === "auto" ? ["pdflatex", "tectonic", "docker"] : [mode];
  for (const backend of order) {
    if (backend === "docker") {
      const docker = await runChild(["docker", "version", "--format", "1"], { timeoutSec: 15 });
      if (docker.exitCode === 0) return "docker";
    } else if (await commandExists(backend)) {
      return backend;
    }
  }
  return null;
}

function wrap(backend: LatexBackend, dir: string, command: string[]): string[] {
  if (backend !== "docker") return command;
  return ["docker", "run", "--rm", "-v", `${dir}:/work`, "-w", "/work", DOCKER_TEX_IMAGE, ...command];
}

/** Run the full compile chain for `<main>.tex` in `dir`. */
export async function compileLatex(
  dir: string,
  main: string,
  backend: LatexBackend,
  useBibtex: boolean,
): Promise<CompileResult> {
  const errors: LatexError[] = [];
  const warnings: string[] = [];
  const base = ["-interaction=nonstopmode", "-halt-on-error=false"];

  if (backend === "tectonic") {
    // Tectonic runs the whole chain (incl. bibtex) in one invocation and
    // writes main.log only with --keep-logs; fall back to captured output.
    const res = await runChild(["tectonic", "--keep-logs", `${main}.tex`], {
      cwd: dir,
      timeoutSec: 600,
      maxOutputChars: 40_000,
    });
    const log = readLog(dir, main) || res.stdout + res.stderr;
    const parsed = parsePdflatexLog(log);
    const pdfPath = existsSync(join(dir, `${main}.pdf`)) ? join(dir, `${main}.pdf`) : null;
    if (res.exitCode !== 0 && parsed.errors.length === 0) {
      parsed.errors.push({
        kind: "error",
        message: (res.stderr || res.stdout || "tectonic failed").slice(0, 2_000),
      });
    }
    return {
      ok: pdfPath !== null && parsed.errors.length === 0,
      pdfPath,
      pages: parsed.pages,
      errors: parsed.errors,
      warnings: [...warnings, ...parsed.warnings],
    };
  }

  const pdfrun = async (): Promise<string> => {
    const res = await runChild(wrap(backend, dir, ["pdflatex", ...base, `${main}.tex`]), {
      cwd: backend === "docker" ? undefined : dir,
      timeoutSec: 300,
      maxOutputChars: 40_000,
    });
    return res.exitCode === 0 ? readLog(dir, main) : readLog(dir, main) || res.stdout + res.stderr;
  };

  await pdfrun();
  if (useBibtex) {
    const res = await runChild(wrap(backend, dir, ["bibtex", main]), {
      cwd: backend === "docker" ? undefined : dir,
      timeoutSec: 120,
    });
    if (res.exitCode !== 0) {
      errors.push({
        kind: "bibtex",
        message: (res.stderr || res.stdout || "bibtex failed").slice(0, 2_000),
      });
    }
    const blg = join(dir, `${main}.blg`);
    if (existsSync(blg)) {
      const blgText = readFileSync(blg, "utf8");
      for (const line of blgText.split("\n")) {
        if (line.includes("Couldn't open") || line.includes("error")) warnings.push(`bibtex: ${line.trim()}`);
      }
    }
  }
  await pdfrun();
  const log = await pdfrun();

  const parsed = parsePdflatexLog(log);
  const pdfPath = existsSync(join(dir, `${main}.pdf`)) ? join(dir, `${main}.pdf`) : null;
  return {
    ok: pdfPath !== null && parsed.errors.length === 0 && errors.length === 0,
    pdfPath,
    pages: parsed.pages,
    errors: [...errors, ...parsed.errors],
    warnings: [...warnings, ...parsed.warnings],
  };
}

function readLog(dir: string, main: string): string {
  const p = join(dir, `${main}.log`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Parse a pdflatex .log into structured errors/warnings/pages. */
export function parsePdflatexLog(log: string): {
  errors: LatexError[];
  warnings: string[];
  pages: number | null;
} {
  const errors: LatexError[] = [];
  const warnings: string[] = [];
  const lines = log.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("!")) {
      // Capture the error line plus one line of context, skipping the help hint.
      const context = (lines[i + 1] ?? "").trim();
      errors.push({ kind: "error", message: `${line.slice(1).trim()}${context ? ` — ${context}` : ""}` });
    } else if (/LaTeX Warning: Citation `.+?' on page/.test(line)) {
      const key = line.match(/Citation `(.+?)'/)?.[1];
      errors.push({ kind: "citation", message: `undefined citation: ${key ?? "?"}` });
    } else if (/LaTeX Warning: Reference `.+?' on page/.test(line)) {
      const key = line.match(/Reference `(.+?)'/)?.[1];
      errors.push({ kind: "reference", message: `undefined reference: ${key ?? "?"}` });
    } else if (/File `.+?' not found/.test(line)) {
      const f = line.match(/File `(.+?)'/)?.[1];
      errors.push({ kind: "file", message: `file not found: ${f ?? "?"}` });
    } else if (line.startsWith("LaTeX Warning:") || line.includes("Overfull \\hbox")) {
      warnings.push(line.trim().slice(0, 200));
    }
  }

  const pages = Number(log.match(/Output written on .*?\((\d+) pages?/)?.[1] ?? NaN);
  // Dedup identical errors (multiple compile passes in the log chain).
  const seen = new Set<string>();
  const unique = errors.filter((e) => {
    const k = `${e.kind}:${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { errors: unique, warnings: warnings.slice(0, 20), pages: Number.isFinite(pages) ? pages : null };
}
