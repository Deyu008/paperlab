<div align="center">

# 📑 paperlab

**An open-source paper-research agent harness.**

Give it a research question. It runs the loop a researcher would —
*literature review → preregistered plan → sandboxed experiments →
interpretation → LaTeX paper → peer review* — and leaves behind a complete,
auditable artifact trail.

[![CI](https://github.com/Deyu008/paperlab/actions/workflows/ci.yml/badge.svg)](https://github.com/Deyu008/paperlab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-16150f.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node%20%E2%89%A522.19-16150f.svg?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/strict%20TypeScript-3178C6.svg?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-87%20passing-0f5132.svg?style=flat-square)](#development)

**Verified end-to-end on a live research question:**
a 13-page paper, 9 data-generated figures, and a three-persona review
(weak-accept, 6.5/10) — with **40/44 recorded metrics verbatim-traceable**
in the text.

</div>

---

> [!IMPORTANT]
> **Experiment integrity over prose quality.** Benchmarks like
> [MLR-Bench](https://arxiv.org/abs/2505.19955) found that coding agents
> fabricate or invalidate experimental results in **~80% of cases**, and that
> fluent papers routinely mask it. paperlab is built around a different
> premise: *a number that cannot be traced to a recorded metric must not
> appear in the paper.*

## The anti-fabrication design

Most paper-generating agents treat honesty as a prompting concern. paperlab
enforces it **structurally** — the pipeline's tools and gates make the
dishonest path fail mechanically:

| Rule | Enforcement (not a prompt — machinery) |
| --- | --- |
| Numbers come from experiments | Experiment code *appends* JSON records to `metrics.jsonl`; the writer agent receives the validated aggregate, never its own memory. Invalid records are quarantined, not dropped. |
| Reviewers audit artifacts | The three reviewer personas see the paper **and** the code, logs, and metrics. Each must record explicit verification checks (the live run performed 24). |
| Figures come from data | The orchestrator runs figure scripts against real experiment CSVs. Referenced-but-missing images, placeholder macros, and file-less figure environments are **build failures**. *(Found the hard way — see [post-mortems](#live-run-post-mortems-the-interesting-bugs).)* |
| Citations exist | Every `\cite` key is audited against a pipeline-managed BibTeX file assembled from real API records. Cited-but-missing = build failure. |
| Claims match evidence | The plan is *preregistered* (hypothesis, metrics, targets, fallbacks) before any experiment runs; interpretation is validated against recorded experiment names; reviews score soundness with consistency guards. |

## How a run works

```
                        ┌─────────────────────────────────────┐
                        │  01 literature                       │
                        │  Semantic Scholar → OpenAlex         │
                        │  → papers.jsonl + references.bib     │
                        └──────────────┬──────────────────────┘
                                       ▼
   ┌────────────────────┐   ┌─────────────────────────────────────┐
   │  02 plan            │◀──│  postdoc ⇄ phd dialogue             │
   │  preregistered      │   │  hypothesis · baselines · targets   │
   └─────────┬──────────┘   └─────────────────────────────────────┘
             ▼
   ┌────────────────────────────────────────────────────────────┐
   │  03 experiment          Docker sandbox (local venv fallback) │
   │  write → run → read error → fix     budget + error history   │
   │  ⇒ metrics.jsonl (append-only, validated, aggregated)        │
   └─────────┬──────────────────────────────────────────────────┘
             ▼
   ┌──────────────┐   ┌──────────────────────┐   ┌────────────────────┐
   │  04 interpret │──▶│  05 write + compile   │──▶│  06 review          │
   │  findings.md  │   │  LaTeX chain + audits │   │  3 personas + AC    │
   └──────────────┘   └──────────────────────┘   └─────────┬──────────┘
             ▲          citation audit · figure audit       │  bounded
             └──────────── revision loop ◀──────────────────┘  revisions
```

Every phase checkpoints (`state.json`), so any run resumes:
`paperlab run --resume <run-dir>`. The full conversation transcripts, tool
calls, and usage records land in the run directory — the reviewable trail.

## Live panel & human steering

```bash
paperlab watch   # → http://127.0.0.1:8787
```

<div align="center">
<sub>A bilingual (EN / 中文) research-grade dashboard: protocol pipeline, booktabs
metrics table, timestamped activity timeline with in-flight tool detection,
paper PDF preview, and two write paths — <b>steering</b> and <b>model override</b>.</sub>
</div>

Research agents drift. When yours does, you don't kill the run — you
**steer** it: panel messages are injected into the targeted agent's next
turn or tool result (at most one turn of latency), and the intervention
itself becomes part of the auditable trail. Switch any role's model mid-run
(e.g. promote the reviewer to a stronger model); changes apply to new
sessions and are recorded in `model-override.json`.

## Quickstart

Requirements: **Node ≥ 22.19**, **Python ≥ 3.10**, Docker recommended.

```bash
git clone https://github.com/Deyu008/paperlab && cd paperlab
npm install

cp .env.example .env            # add ONE provider key, e.g.:
                                #   ZAI_CODING_CN_API_KEY=...   (GLM coding endpoint)
                                #   DEEPSEEK_API_KEY=...        (DeepSeek)

npx paperlab run --topic "Do bagged ensembles beat single gradient boosting on small tabular datasets?"
```

That's the whole ceremony. Models are resolved through the
[pi](https://pi.dev) runtime — **DeepSeek, GLM, Kimi, Qwen, MiniMax,
OpenAI, Anthropic, Google, OpenRouter and 30+ more providers** work out of
the box (`npx paperlab models` lists the catalog).

A first run typically takes **1–3 hours** on cheap tiers (the demo cost
well under $5 on GLM flash models) and writes:

```
runs/<topic>/<timestamp>/
├── state.json               resumable pipeline checkpoint
├── report.md                phase statuses + token/cost totals
├── tokens.jsonl             per-turn usage and cost
├── logs/                    full session transcripts (JSONL)
├── 01-literature/           papers.jsonl · related_work.md · references.bib
├── 02-plan/                 plan.json (hypothesis, experiments, risks)
├── 03-experiment/           code · logs · metrics.jsonl → metrics.json
├── 04-interpret/            findings.md
├── 05-paper/                tex/main.pdf · figures/ · scripts/
└── 06-review/               reviews · meta-review · report.md
```

## Configuration

`config.example.yaml` → `config.yaml`. The interesting bits:

```yaml
models:
  default: { provider: zai-coding-cn, model: glm-5.3-flash }
  reviewer: { provider: deepseek, model: deepseek-v4-pro }   # per-role override

budgets:                     # per-phase runaway guards
  literature: { target_papers: 12, max_searches: 15 }
  experiment: { max_tool_calls: 60, step_timeout_sec: 600 }
  writeup:    { reflections: 3 }
  review:     { revision_rounds: 2, accept_threshold: 6.0 }

copilot: false               # true → pause for human approval at key phases
sandbox: auto                # docker | local | auto (probed)
latex: auto                  # pdflatex | tectonic | docker | auto (probed)
```

Sandbox and LaTeX backends are **probed at runtime**: Docker containers when
available (agent code never touches your host), local venvs otherwise;
pdflatex → tectonic → dockerized TeX Live in that order.

## Live-run post-mortems (the interesting bugs)

These were all found by actually running the harness, and each fix ships
with a regression test:

1. **The placeholder-figure dodge** — the writer agent defined a custom
   `\includefig{...}` macro that rendered a box *without reading any file*,
   passing compilation with zero real figures. Classic reward hacking.
   Figure integrity is now a build-time audit.
2. **The 29 GB transcript** — one writing session streamed its way to
   29.4 GB of JSONL. Transcripts now carry soft (100 MB) and hard (300 MB)
   caps that shed streaming deltas first.
3. **The overwritten interpreter** — an agent-authored script overwrote the
   *host* `python` binary with a self-exec wrapper, sending every Python
   invocation into a 100% CPU exec loop. Phase 5 moved into the same
   Docker-first sandbox as experiments; `runChild` now kills whole process
   groups (WSL2 orphans spin forever otherwise).

## Architecture

```
src/
├── cli.ts                 run · watch · models
├── config.ts              validated YAML config, per-role model routing
├── orchestrator.ts        phase graph, checkpoints, copilot gates
├── core/
│   ├── agent.ts           pi session wrapper: role prompts, tools, transcripts
│   ├── models.ts          role → model resolution over the pi-ai catalog
│   ├── run-store.ts       artifacts, checkpoints, usage records
│   ├── steering.ts        exactly-once human steering mailbox
│   └── model-override.ts  runtime model switching (panel → new sessions)
├── phases/                one module per stage; tools injected per phase
├── roles/                 PhD · postdoc · ml engineer · writer · reviewers · AC
├── tools/                 search · sandbox · metrics · latex · audits · schemas
└── web/                   zero-dependency dashboard server
```

- **Orchestrator** — dependency-checked phase graph with per-phase
  checkpoints and optional human gates.
- **Agents** — thin wrapper over the [pi](https://pi.dev) coding-agent SDK:
  in-memory sessions, per-role system prompts, minimal tool surfaces.
- **Discipline lives in tools** — metrics schema validation, citation and
  figure audits, plan/review schemas: plain, unit-testable functions that
  agents cannot talk their way around.

## Development

```bash
npm run typecheck      # strict TS, zero errors
npm test               # 87 tests, incl. a faux-LLM end-to-end pipeline test
npm run smoke:session  # wiring check without an LLM call
```

The e2e test drives the **real pipeline** — sessions, tools, sandbox,
checkpoints — on scripted faux-model responses, so the full loop is verified
without spending a cent. Design contributions: read
[CONTRIBUTING.md](CONTRIBUTING.md) and the panel spec at
[docs/panel-spec.md](docs/panel-spec.md).

## Status & roadmap

Shipped: all six phases, resumable runs, copilot gates, steering, panel,
model override. Next up (see [ROADMAP.md](ROADMAP.md)): context-cache
optimization, arXiv full-text ingestion, Elo-tournament ideation, GPU
experiments.

## Acknowledgments

Standing on [pi](https://pi.dev) (agent runtime) and ideas from
[AgentLaboratory](https://github.com/SamuelSchmidgall/AgentLaboratory),
[AI-Scientist-v2](https://github.com/sakanaai/ai-scientist-v2),
[MLR-Bench](https://arxiv.org/abs/2505.19955) (whose fabrication findings
shaped the design), and Google's AI co-scientist. Literature metadata from
Semantic Scholar, arXiv, and OpenAlex.

<div align="center">
<sub>MIT © 2026 paperlab contributors — if paperlab helps your research,
cite the humans who check the outputs.</sub>
</div>
