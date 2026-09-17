# Panel Spec: i18n, Model Override, Activity Timeline, Usage Display

Status: **implemented and unit-tested (87 tests)** — this document is the
contract. A reimplementing agent should treat the acceptance criteria as
binding; the current implementation can be used as a reference.

Target file layout:

```
src/web/page.ts        embedded dashboard page (single template string, no build step, no CDN)
src/web/server.ts      zero-dependency HTTP server (node:http)
src/core/model-override.ts   model override persistence
src/core/agent.ts      transcript stamping (_ts)
test/model-override.test.ts, test/watch-server.test.ts
```

## 1. Language toggle (EN / 中文)

**Requirement.** The panel is fully bilingual. A toggle button in the
masthead (`中文` when EN is active, `EN` when 中文 is active) switches every
UI string instantly. Preference persists across reloads.

**Design constraints.**

- No framework, no build step: a single `I18N = { en: {...}, zh: {...} }`
  dictionary inside `page.ts`; `t(key)` falls back to `en`.
- Static strings are marked `data-i18n="key"` and rewritten by
  `applyI18n()`; dynamic renderers (phases, statuses, metrics headers,
  steering history, buttons) must call `t()` at render time.
- Phase names and statuses localize: e.g. `01-literature` → 文献综述,
  `running` → 进行中.
- Language choice lives in `localStorage("paperlab-lang")`; default derived
  from `navigator.language`.
- Time formatting follows the language (`toLocaleTimeString("zh-CN"/"en-US")`).

**Acceptance.**
- [ ] Toggling re-renders all visible strings without a page reload.
- [ ] Poll-driven renders (every 2 s) use the active language.
- [ ] Reload keeps the chosen language.

## 2. Model override (runtime, per-scope)

**Requirement.** The operator can switch the model for any scope
(`default`, or a role: `phd | postdoc | mlengineer | writer | reviewer |
ac`) from the panel while the pipeline runs.

**Design constraints.**

- Persistence: `model-override.json` in the run root — a run artifact.
  Shape: `{ "<scope>": { "provider": "...", "model": "..." } }`.
- Semantics: **applies to sessions created after the write**. Running
  sessions keep their model. This must be stated in the UI.
- Resolution: at session creation (`src/phases/support.ts`),
  `applyModelOverride(config, runRoot)` returns a patched config copy:
  `override.default` replaces `models.default`, then per-role entries
  override `models.<role>`. No override file ⇒ the original config object
  is returned untouched (reference equality, not a clone).
- Validation: writes must reject unknown provider/model via
  `resolveModel()` (throws `ModelResolutionError`); a corrupt override file
  is ignored at read time.
- API:
  - `GET /api/model` → `{ override, effective, catalog }` where
    `effective[scope]` is the override-or-config model and `catalog` is the
    pi-ai builtin catalog (`listCatalog()`).
  - `POST /api/model` `{scope, provider, model}` → 200 `{ok, override}` or
    400 `{error}`.
- UI: three selects (scope / provider / model; model list follows
  provider), an Apply button, and a "current: provider / model" readout
  that updates per scope.

**Acceptance.**
- [ ] POST with an unknown model returns 400 and writes nothing.
- [ ] After a successful POST, the next session created uses the override
      (unit-test `applyModelOverride` semantics, not a live session).
- [ ] Original config object is never mutated.
- [ ] UI note states the applies-to-new-sessions semantics.

## 3. Activity timeline with timestamps

**Requirement.** Every activity entry shows when it happened; long-running
tool executions are surfaced as a live "running X for Ns" banner instead of
a silent gap.

**Design constraints.**

- Engine events carry no timestamps, so the transcript writer stamps every
  record with `_ts` (ISO) at write time (`src/core/agent.ts`, inside the
  guarded transcript wrapper). Records lacking `_ts` display without a time.
- `/api/activity` reads only the **last 256 KB** of each of the 3 newest
  transcripts (fd-positioned reads; never `readFileSync` of a whole
  multi-GB file) and returns:
  - `activity[]`: `toolCall` completions, assistant text snippets, and
    `▶ tool` start events (kind `"tool" | "text" | "start"`), newest first,
    capped at 60;
  - `inFlight[]`: tools with `tool_execution_start` but no matching
    `tool_execution_end` in the tail window — `{role, tool, elapsedMs}`
    where elapsed is floored by the file mtime.
- UI: `HH:MM:SS` prefix per row (mono, muted); in-flight entries render as
  a pinned amber banner above the feed, refreshed each poll.

**Acceptance.**
- [ ] New events show timestamps within one poll (2 s).
- [ ] During a >10 s tool run the banner is visible and its counter grows.
- [ ] A transcript of any size answers in <100 ms (tail reads only).

## 4. Usage display (always visible)

**Requirement.** Token consumption and estimated cost are visible without
scrolling, plus the detailed breakdown in §1.

**Design constraints.**

- Source of truth: `tokens.jsonl` (per-session-close records with
  `inputTokens`, `outputTokens`, `costUsd` — may be `null` when the
  provider does not report usage).
- Masthead "usage chip": `tokens <total> · $cost · N turns`, bold green
  total, updated every poll.
- §1 stats row: turns / input / output / cost (cost shows `n/a` when
  unknown — never fabricated).

**Acceptance.**
- [ ] Chip updates live while a run is active.
- [ ] `costUsd == null` renders `n/a`, not `$0.0000`.

## Cross-cutting rules

1. The page is one self-contained HTML string: no CDN, no build step,
   vanilla JS only; the server must serve it from memory.
2. The panel's only write paths are `/api/steer` and `/api/model` —
   everything else is a read of run artifacts.
3. All new logic that an agent can influence (override validation) is
   enforced in code with actionable errors, mirroring the project's
   tool-discipline rule.
4. Strict TypeScript stays clean; unit tests cover persistence and
   endpoint contracts (see `test/model-override.test.ts`,
   `test/watch-server.test.ts`).

## Out of scope (do not add)

- WebSockets (2 s polling is the contract)
- Multi-run management (one panel = one run directory)
- Auth (localhost only)
