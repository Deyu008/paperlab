# Roadmap

## M1 — Skeleton ✅

- [x] Project scaffold (strict TS, vitest, MIT, README)
- [x] Config loading with validation and per-role model overrides
- [x] Run store: checkpoints, JSONL artifacts, transcripts, usage records
- [x] pi agent-session wrapper (role prompts, custom tools, transcripts)
- [x] Phase pipeline with dependencies, resume, copilot gates
- [x] CLI (`run`, `models`)

## M2 — Literature review

- [ ] `paper-search` tools: Semantic Scholar (rate-limited), arXiv, OpenAlex fallback
- [ ] `save_paper` tool with schema validation, dedup, real BibTeX
- [ ] PhD agent loop → `papers.jsonl` + `related_work.md`

## M3 — Research plan

- [ ] Postdoc↔PhD dialogue with bounded rounds
- [ ] `submit_plan` tool with plan.json schema (hypothesis, novelty, experiments)
- [ ] Copilot gate at plan approval

## M4 — Experiment execution

- [ ] Sandbox: Docker backend (preferred) + local subprocess fallback
- [ ] `run_python` / `write_file` / `read_file` / `list_files` sandbox tools
- [ ] metrics.json discipline enforced (schema, append-only records)
- [ ] Bounded debug loop with error-history awareness
- [ ] Figure data (CSV) emitted by experiment scripts

## M5 — Paper writing

- [ ] LaTeX scaffold + section generation from artifacts
- [ ] Compile chain (pdflatex→bibtex→pdflatex→pdflatex or tectonic) with parsed logs
- [ ] Reflection loop: compile errors, citation-key audit, page budget
- [ ] Figures generated from experiment data only

## M6 — Review and revision

- [ ] 3 reviewer personas with artifact access (code + logs + metrics.json)
- [ ] Area-chair meta-review with scores
- [ ] Bounded revise→re-review loop

## M7 — End-to-end

- [ ] Copilot gates finalized
- [ ] Full demo run on a CPU-only topic; every paper number traceable to metrics.json
- [ ] Cost report per run

## Later (explicitly out of MVP)

- Elo tournament idea selection (co-scientist style)
- Multi-lab parallelism
- Cross-run shared paper library (AgentRxiv style)
- GPU experiments
