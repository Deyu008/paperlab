# paperlab

**An open-source paper-research agent harness.** Give it a research topic; it
runs the full research loop — literature review, research plan, sandboxed
experiments, interpretation, LaTeX paper, and automated peer review — and
leaves behind a complete, auditable artifact trail.

```
topic ─▶ 01 literature ─▶ 02 plan ─▶ 03 experiment ─▶ 04 interpret ─▶ 05 paper ─▶ 06 review
              │                          │                                    │
         papers.jsonl               metrics.json ◀────────────────────── verified
         related_work.md          code + logs          (reviewers audit artifacts,
                             (Docker sandbox)          not just the PDF)
```

## Why another one?

Systems like [AgentLaboratory] and [AI-Scientist-v2] demonstrated that LLM
agents can run end-to-end research loops. Benchmarks ([MLR-Bench]) also show
where they fail: **~80% of coding-agent "experiments" contain fabricated or
invalidated results**, and fluent papers routinely mask that. paperlab's core
design principle is *experiment integrity over prose quality*:

1. **Numbers have one source of truth.** Every metric in the paper must come
   from `metrics.json`, written by the experiment code itself — the writer
   agent receives the file, not its imagination.
2. **Reviewers audit artifacts.** The review phase reads the paper *and* the
   experiment code, logs, and metrics, specifically to catch claims the
   artifacts don't support.
3. **Figures come from data.** Plots are generated from experiment outputs;
   a figure without backing data is a build failure, not a prose flourish.

Everything else is conventional: staged pipeline, role prompts (PhD student,
postdoc, ML engineer, writer, reviewers, area chair), per-phase budgets,
human-in-the-loop gates when you want them.

[AgentLaboratory]: https://github.com/SamuelSchmidgall/AgentLaboratory
[AI-Scientist-v2]: https://github.com/sakanaai/ai-scientist-v2
[MLR-Bench]: https://arxiv.org/abs/2505.19955

## Status

Early development (milestone M1 complete: pipeline skeleton, config, run
store, agent session wiring). The six phases land milestone by milestone —
see [ROADMAP.md](ROADMAP.md).

## Quickstart

Requirements: Node.js ≥ 22.19, Python ≥ 3.10 (for experiment execution),
Docker recommended (sandbox).

```bash
npm install
export DEEPSEEK_API_KEY=sk-...   # or ZAI_API_KEY / MOONSHOTAI_API_KEY / ...
npx paperlab run --topic "Do ensemble methods beat gradient boosting on small tabular datasets?"
```

Every run writes a self-contained directory:

```
runs/<topic-slug>/<timestamp>/
├── state.json              # resumable pipeline checkpoint
├── tokens.jsonl            # per-turn token usage / cost
├── logs/                   # full session transcripts (JSONL)
├── 01-literature/          # papers.jsonl (with BibTeX) + related_work.md
├── 02-plan/                # plan.json (hypothesis, baselines, experiments)
├── 03-experiment/          # code/, logs/, metrics.json, figure data
├── 04-interpret/           # findings.md
├── 05-paper/               # LaTeX sources + compiled paper.pdf
└── 06-review/              # structured reviews + meta-review + report
```

Interrupted runs resume: `npx paperlab run --resume runs/<slug>/<stamp>`.

## Configuration

Copy [`config.example.yaml`](config.example.yaml) to `config.yaml` (or pass
`--config`). Key sections:

| Key | Default | Purpose |
| --- | --- | --- |
| `models.default` | `deepseek/deepseek-v4-flash` | LLM for all roles |
| `models.<role>` | — | per-role overrides (writer, reviewer, ...) |
| `budgets.*` | see file | per-phase runaway guards |
| `copilot` | `false` | pause for human approval after key phases |
| `sandbox` | `auto` | `docker` · `local` · `auto` (probed) |
| `latex` | `auto` | `pdflatex` · `tectonic` · `docker` · `auto` |

List available providers/models: `npx paperlab models [provider]`.

## Architecture

- **Orchestrator** (`src/orchestrator.ts`) — phase graph with dependencies,
  per-phase checkpoints, optional human gates.
- **Run store** (`src/core/run-store.ts`) — all artifacts, transcripts, and
  usage records for one run; the resume unit.
- **Agent sessions** (`src/core/agent.ts`) — thin wrapper over the
  [pi](https://pi.dev) coding-agent SDK: per-role system prompts, minimal
  tool surfaces (custom tools only unless built-ins are allowlisted),
  in-memory sessions, JSONL transcripts, usage accounting.
- **Phases** (`src/phases/`) — one module per pipeline stage; each phase gets
  exactly the tools it needs (literature search in phase 1, sandboxed code
  execution in phase 3, LaTeX compile in phase 5, structured review
  submission in phase 6).
- **Anti-fabrication** — enforced in tools and orchestration, not just
  prompts: metrics schema validation, citation keys checked against the
  bibliography, figure-data provenance checks.

## Development

```bash
npm run typecheck     # strict TS, no emit
npm test              # vitest unit tests
npm run smoke:session # wiring check without an LLM call
```

## License

[MIT](LICENSE)

## Acknowledgments

paperlab stands on [pi](https://pi.dev) (agent runtime) and the ideas in
AgentLaboratory, AI-Scientist-v2, and Google's AI co-scientist. Literature
metadata comes from the Semantic Scholar, arXiv, and OpenAlex APIs.
