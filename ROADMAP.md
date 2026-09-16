# Roadmap

## M1 — Skeleton ✅

- [x] Project scaffold (strict TS, vitest, MIT, README)
- [x] Config loading with validation and per-role model overrides
- [x] Run store: checkpoints, JSONL artifacts, transcripts, usage records
- [x] pi agent-session wrapper (role prompts, custom tools, transcripts)
- [x] Phase pipeline with dependencies, resume, copilot gates
- [x] CLI (`run`, `models`)

## M2 — Literature review ✅

- [x] `paper-search` tools: Semantic Scholar (rate-limited, retry/backoff), OpenAlex fallback
- [x] `save_paper` tool with schema validation, store-backed dedup, generated BibTeX
- [x] PhD agent loop → `papers.jsonl` + `related_work.md` + `references.bib`
- [x] Post-conditions: minimum papers, review present

## M3 — Research plan ✅

- [x] Postdoc↔PhD dialogue with bounded rounds
- [x] `submit_plan` with plan.json schema (hypothesis, novelty, experiments)
- [x] Novelty grounding: must reference a saved paper title
- [x] Copilot gate at plan approval

## M4 — Experiment execution ✅

- [x] Sandbox: Docker backend (per-run container) + local venv fallback, auto-probe
- [x] `run_python` / `write_file` / `read_file` / `list_files` workspace-confined tools
- [x] metrics.jsonl discipline: append-only records, validation, aggregation to metrics.json
- [x] Bounded debug loop with error-history awareness + tool-call budget
- [x] Post-conditions: valid metrics required; missing planned experiments flagged

## M5 — Interpretation + paper writing ✅

- [x] `04-interpret`: findings tied to recorded experiment names, numbers injected verbatim
- [x] LaTeX compile chain (pdflatex→bibtex→pdflatex×2 / tectonic / docker texlive)
- [x] Structured log parsing — real errors fed back to the writer
- [x] Citation audit: cited-but-missing keys are build failures
- [x] Figure scripts run by the orchestrator against real experiment CSVs
- [x] Bounded reflection rounds

## M6 — Review and revision ✅

- [x] 3 reviewer personas with artifact access (code + logs + metrics)
- [x] Structured reviews with recorded artifact checks + consistency guards
- [x] Area-chair meta-review with explicit disagreement resolution
- [x] Bounded revise→re-review loop (numbers immutable during revision)
- [x] Per-round persistence + final report.md

## M7 — End-to-end hardening ✅

- [x] Copilot gates (plan approval, paper approval) with TTY detection
- [x] Resume support (`--resume`, per-phase `--only`, `--force`)
- [x] Run report (phase statuses + token usage) written even on failure
- [x] CI (typecheck + tests) via GitHub Actions

## Later (explicitly out of MVP)

- Live end-to-end demo run (needs provider API keys; wiring is smoke-tested)
- arXiv API adapter (S2 + OpenAlex already cover discovery)
- Elo tournament idea selection (co-scientist style)
- Multi-lab parallelism
- Cross-run shared paper library (AgentRxiv style)
- GPU experiments, automatic submission
