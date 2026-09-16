/**
 * paperlab CLI.
 *
 *   paperlab run    --topic "..." [--config c.yaml] [--resume <dir>] [--only <phase>] [--force]
 *   paperlab models [provider]
 */
import { parseArgs } from "node:util";
import { loadConfigFromDisk, type SandboxMode } from "./config.ts";
import { listCatalog } from "./core/models.ts";
import { RunStore } from "./core/run-store.ts";
import { buildPipeline } from "./phases/index.ts";

const USAGE = `paperlab — an open-source paper-research agent harness

Usage:
  paperlab run --topic "<research topic>" [options]
  paperlab run --resume <run-directory>   [options]
  paperlab models [provider]             list available providers/models

Options:
  --config <path>     config file (default: ./config.yaml if present)
  --topic <text>      research topic (required for new runs)
  --resume <path>     resume an interrupted run from its checkpoints
  --only <phase>      run a single phase (e.g. --only 03-experiment)
  --force             re-run phases even if checkpointed as done
  --sandbox <mode>    docker | local | auto (overrides config)
  --copilot           enable human gates (overrides config)
  -h, --help          show this help

Environment: provider API keys are read by pi-ai from the environment
(DEEPSEEK_API_KEY, ZAI_API_KEY, MOONSHOTAI_API_KEY, ...).
`;

function fail(message: string, code = 1): never {
  console.error(`paperlab: ${message}`);
  process.exit(code);
}

function log(message: string): void {
  console.log(`[paperlab] ${message}`);
}

async function main(): Promise<void> {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      topic: { type: "string" },
      resume: { type: "string" },
      only: { type: "string" },
      force: { type: "boolean", default: false },
      sandbox: { type: "string" },
      copilot: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = args.positionals[0] ?? "run";

  if (args.values.help || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "models") {
    const provider = args.positionals[1];
    const catalog = listCatalog().filter((entry) => !provider || entry.provider === provider);
    if (catalog.length === 0) fail(`unknown provider "${provider ?? ""}"`);
    for (const entry of catalog) {
      console.log(`\n${entry.provider}:`);
      for (const model of entry.models) console.log(`  ${model}`);
    }
    return;
  }

  if (command !== "run") {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }

  const sandboxOverride = args.values.sandbox as SandboxMode | undefined;
  if (sandboxOverride && !["docker", "local", "auto"].includes(sandboxOverride)) {
    fail(`--sandbox must be docker|local|auto, got "${sandboxOverride}"`);
  }

  const { config, errors, source } = loadConfigFromDisk(args.values.config, {
    sandbox: sandboxOverride,
    copilot: args.values.copilot || undefined,
  });
  if (errors.length > 0) {
    for (const e of errors) console.error(`config: ${e}`);
    fail("configuration had errors (see above)");
  }
  if (source) log(`config loaded from ${source}`);

  let store: RunStore;
  if (args.values.resume) {
    try {
      store = RunStore.open(args.values.resume);
    } catch (e) {
      fail((e as Error).message);
    }
    log(`resuming ${store.root} — topic: ${store.topic}`);
  } else {
    const topic = args.values.topic?.trim();
    if (!topic) fail("either --topic or --resume is required");
    store = RunStore.createNew(config.run_dir, topic, source);
    log(`new run ${store.root}`);
  }

  const pipeline = buildPipeline();
  log(`phases: ${pipeline.phaseKeys().join(" → ")}`);

  try {
    await pipeline.run(
      {
        config,
        store,
        log,
        copilotNotes: new Map(),
      },
      {
        force: args.values.force,
        only: args.values.only ? [args.values.only] : undefined,
      },
    );
    log(`pipeline complete — artifacts in ${store.root}`);
  } catch (e) {
    if ((e as Error).name === "PhaseFailedError") {
      log(`${(e as Error).message}`);
      log(`state saved — re-run with --resume ${store.root}`);
      process.exitCode = 2;
    } else {
      throw e;
    }
  } finally {
    await writeRunReport(store);
  }
}

/** Final run report: phase statuses + token usage. Written even on failure. */
async function writeRunReport(store: RunStore): Promise<void> {
  const { readFileSync, existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const usagePath = join(store.root, "tokens.jsonl");
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  if (existsSync(usagePath)) {
    for (const line of readFileSync(usagePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { inputTokens: number; outputTokens: number };
      inputTokens += rec.inputTokens;
      outputTokens += rec.outputTokens;
      calls++;
    }
  }
  const phases = Object.entries(store.state.phases)
    .map(([k, v]) => `- ${k}: ${v.status} (${v.attempts} attempt${v.attempts === 1 ? "" : "s"})`)
    .join("\n");
  writeFileSync(
    join(store.root, "report.md"),
    [
      `# Run report`,
      ``,
      `Topic: ${store.topic}`,
      `Created: ${store.state.createdAt}`,
      ``,
      `## Phases`,
      phases || "(none ran)",
      ``,
      `## Usage`,
      `- LLM turns: ${calls}`,
      `- Input tokens: ${inputTokens.toLocaleString("en-US")}`,
      `- Output tokens: ${outputTokens.toLocaleString("en-US")}`,
      ``,
    ].join("\n"),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
