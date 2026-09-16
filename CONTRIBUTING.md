# Contributing

## Development setup

```bash
npm install          # Node >= 22.19 required (pi SDK)
npm run typecheck    # strict TS, zero errors expected
npm test             # vitest; includes the faux-LLM e2e pipeline test
```

Python >= 3.10 powers the experiment sandbox (local fallback creates a venv
per run). Docker is optional but recommended (`sandbox: auto` probes it).

## Layout

- `src/phases/` — one module per pipeline stage (`N-name.ts`), registered in
  `src/phases/index.ts`
- `src/tools/` — pi custom tools; anything enforcing pipeline discipline
  (metrics schema, citation audit, review schema) lives here as plain,
  unit-testable functions
- `src/core/` — config, model resolution, agent-session wrapper, run store
- `test/` — unit tests per module + `e2e-faux.test.ts` (deterministic
  pipeline integration test; network stubbed, sandbox real)

## Ground rules

1. **Experiment integrity over prose quality.** New features must not create
   a path where a number can reach the paper without a metrics.jsonl record
   behind it.
2. Every tool that an agent can call validates its inputs and returns
   actionable errors — the agent should be able to self-correct from the
   tool result alone.
3. Unit-test discipline logic at the `src/tools/` level; keep LLM behavior
   out of unit tests (use the faux provider for integration).
4. Conventional commits (`feat(scope):`, `fix:`, `test:`, `docs:`, `chore:`).
5. TypeScript strict mode stays on; `npm run typecheck` must be clean.
