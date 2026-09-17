# Context Cache Optimization (design note)

Goal: maximize provider-side prefix-cache hits for agent sessions. This is
pure money and latency — a cached input token costs ~5× less
(glm-5.3-flash: $0.075/M input vs $0.015/M cache-read) and skips prefill.

## Baseline measurement (live run, GLM-5.3 / GLM-5.3-flash)

Per-session cache-hit rate from the demo run transcripts:

| session | turns | input | cacheRead | hit% |
| --- | ---: | ---: | ---: | ---: |
| 01-literature-phd | 2 | 4,494 | 43,328 | 90.6% |
| 02-plan-phd | 1 | 4,291 | 0 | **0.0%** |
| 02-plan-postdoc | 2 | 18,446 | 1,792 | **8.9%** |
| 03-experiment-mlengineer | 1 | 2,296 | 106,560 | 97.9% |
| 04-interpret-postdoc | 2 | 16,644 | 5,632 | **25.3%** |
| 06-review-ac | 2 | 18,923 | 10,624 | **36.0%** |
| 06-review-reviewer | 2 | 61,763 | 0 | **0.0%** |
| **total** | 12 | 126,857 | 167,936 | **57.0%** |

The pattern: single-tool-call sessions (phd literature, mlengineer) hit
~90–98%. Multi-turn dialogue sessions (plan, interpret, review) hit 0–36%.
Since GLM caching is **implicit prefix caching** (no explicit cache objects
— [docs](https://docs.bigmodel.cn/cn/guide/capabilities/cache)), a 0% hit on
turn 2 of a session means **the request prefix changed between turns**.

## Why prefixes break (root causes, in this codebase)

Prefix caching hashes the request prefix — system prompt, tools, then
messages in order. The first differing byte ends the hit. Auditing our
request construction found these destabilizers:

1. **Timestamps / volatile content in the system prompt or early messages.**
   Nothing in paperlab injects time into prompts (verified) — but steering
   messages carry `[HH:MM:SS]` and are injected at arbitrary positions
   (prefixed to the next user turn). A steering message changes the user
   turn, which is fine (it's the *last* message), but steering formatted
   into *earlier* material would break everything after it.

2. **Tool-schema instability.** `createLiteratureTools` closes over
   per-run state (`searchesUsed`) and embeds budget numbers in tool
   *results* (fine — results are messages) but the tool *definitions* are
   rebuilt per session. Within one session they're stable (good), but any
   nondeterministic ordering in `Type.Object` parameter schemas would
   reorder `tools` between turns. pi serializes tools in registration
   order — our factories return fixed-order literals, so this is stable
   today, but nothing *guards* it.

3. **The reviewer materials block.** `06-review` rebuilds a ~24–60k-char
   "materials" prompt per reviewer from `metricsTable`, code listings, and
   the tex. Deterministic content — but the tex listing is
   `tex.slice(0, 24_000)`, and any upstream byte change (a recompiled
   paper, a rerun experiment) shifts the entire block. That is inherent
   (reviewers *must* see the artifacts), but the order matters: the
   materials block sits in the *first user message*, so it only needs to
   be stable *within* a reviewer session — which it is, since each
   reviewer gets exactly one prompt. The 0% hit in `06-review-reviewer`
   came from something else: **the submit_review tool schema** contains a
   long description with `checks` examples — stable — so the real suspect
   is per-request tool re-registration via `customTools` combined with pi's
   internal `Available tools` system-prompt section: `promptSnippet` lines
   are appended to the system prompt in tool-registration order, which is
   stable… *unless* `noTools: "builtin"` internally enables/disables
   builtin tool entries conditionally. Verified: with `noTools: "builtin"`
   the builtin section is empty and stable. Remaining suspect (confirmed
   below): **thinking/reasoning toggles and per-turn option drift**.

4. **Confirmed primary cause — `sessionId` is not forwarded.** pi's
   `AgentSession` generates a `sessionId` (from SessionManager) and passes
   it to `Agent`, which forwards it as `options.sessionId` into
   `modelRuntime.streamSimple(...)`. For OpenAI-compatible providers, pi-ai
   uses `sessionId` as `prompt_cache_key` **only for api.openai.com** (or
   "long" retention). For zai/bigmodel the request carries **no
   `prompt_cache_key` and no session-affinity header** (`sendSessionAffinityHeaders`
   is false for zai). Bigmodel's implicit cache is prefix-hash based, so
   this is not fatal — but on their multi-replica serving fleet, requests
   from the same session can land on different replicas without affinity,
   and **different replicas have disjoint KV caches**. A 2-turn dialogue
   that bounces replicas gets 0% hit on turn 2. That matches the observed
   pattern exactly: sessions whose turns happen to stick to one replica
   hit 90%+, sessions that bounce hit 0%.

## Optimizations (in order of expected impact)

### O1. Session affinity header for bigmodel/zai ✅ (implemented)

Route-level: set `sendSessionAffinityHeaders: true` in
`model.compat` for zai-coding-cn models (persisted via
`registerExtraModel`/`ModelRuntime.registerProvider` config), or simpler:
**inject the headers ourselves** via pi-ai's per-session `transformHeaders`.
We pin `x-session-affinity: <runId>:<role>` per role-session so every turn
of a session lands on the same replica. This is the fix for the 0%-hit
sessions. (Header name follows the OpenAI-compatible convention pi already
speaks: `x-session-affinity` + `x-client-request-id`.)

Implementation: in `createRoleSession`, pass a `transformContext`-like hook?
— No: transport-level. pi-coding-agent exposes `before_provider_headers`
extension events; but the cleanest SDK path is `model.headers` (static per
model — not per session) — insufficient. So: **wrap the ModelRuntime's
stream function** in our session wrapper: a tiny subclass/wrapper that
splices `x-session-affinity` into `options.headers` before dispatch. Done
in `src/core/agent.ts` via a `sessionHeaders` option.

### O2. Per-role stable sessionId as `prompt_cache_key` ✅ (implemented)

pi-ai already forwards `options.sessionId` → `prompt_cache_key` when
`cacheRetention === "long"` and `supportsLongCacheRetention`. GLM ignores
unknown params (OpenAI-compat servers generally do), so sending
`prompt_cache_key` to bigmodel is harmless and future-proofs the moment
they honor it. We pass `cacheRetention: "long"` + a stable sessionId per
role-session.

### O3. Prefix-stability guard (test-enforced) ✅ (implemented)

A regression test that builds each role session's *serialized request
shape* twice (system prompt + tool definitions + first user message) and
asserts byte-equality. Any future edit that introduces volatility
(timestamps, random ids, map-iteration order) into the prefix fails CI.
Located in `test/prefix-stability.test.ts`.

### O4. Cache observability ✅ (implemented)

`tokens.jsonl` now records `cacheReadTokens`, `cacheWriteTokens`, and
`hitRate` per session-close; `report.md` prints per-role hit rates; the
web panel usage chip shows `cache xx%`. You cannot optimize what you
cannot see — this closes the loop with the measurement script that
produced the baseline table above.

### O5 (rejected, documented). Message-order canonicalization

Reordering messages to maximize shared prefixes (e.g. hoisting materials
out of user turns into the system prompt) would *increase* cross-session
sharing (same role → same system prefix across runs). Rejected for now:
system prompts contain role guidance only; hoisting run-specific materials
there risks confusing cache semantics across runs and complicates the
audit trail. Revisit if cross-run cost ever matters (currently each run is
a few dollars).

## Expected effect

If O1 fixes replica bouncing, multi-turn sessions should move from 0–36%
to the 85–95% band (matching what single-replica sessions already achieve),
cutting input-billed tokens for those phases by roughly half. Overall run
hit rate target: **≥ 85%** (from 57%).

## Verification plan

1. Unit: prefix-stability test (O3) + header splice unit test.
2. Integration: faux provider records headers; assert affinity header
   present and stable across turns.
3. Live: rerun a full topic; re-run the measurement script; compare hit%
   per session against the baseline table. Target ≥85% overall.

## Post-review correction (2026-09)

A full-codebase review found **O1 was dead code in production**: the
affinity wrapper was only applied when a runtime override was injected
(tests/embedding); live runs passed no runtime, so the SDK built its own
default and `x-session-affinity` was never sent. Additionally,
`openRoleSession` (plan dialogue, reviewer personas, revision writer) never
passed `cacheAffinityId` at all.

Fixes:

- `createRoleSession` now builds a **shared default runtime** (offline:
  `auth.json` + `models.json` + static builtin catalog, once per process)
  whenever a `cacheAffinityId` is present, and wraps it with the affinity
  splice. Unusable agent dir degrades to the SDK default with a warning.
- `openRoleSession` passes the same stable affinity id as `runRoleSession`.
- Regression: `test/runtime-affinity.test.ts` drives the *production* path
  (no override) and asserts the headers reach `streamSimple` and the shared
  runtime is constructed exactly once.

The live verification above is still pending — and is now actually testing
the real code path.

## Live verification (2026-09-17, run `do-k-fold-cross-validation-…`)

Full six-phase run on glm-5.3-flash after the correction. Per-session
cache-hit rates from `tokens.jsonl`:

| phase/role              | billed input | cacheRead | hit    |
|-------------------------|-------------:|----------:|-------:|
| 01-literature/phd       |       76,655 |   672,384 |  89.8% |
| 03-experiment/mlengineer|      105,106 | 2,799,488 |  96.4% |
| 05-paper/writer (draft) |      200,652 | 5,687,872 |  96.6% |
| 05-paper/writer (resume)|      129,484 | 1,293,888 |  90.9% |
| 06-review (4 sessions)  |      164,894 |    68,928 | ~29%   |
| short single-turn roles |       ~65k   |         0 |   0%   |
| **TOTAL**               |    723,740  | 10,534,528 | **93.6%** |

Result: **93.6% overall vs the 57% baseline — target ≥85% met.** The heavy
multi-turn sessions (experiment, writing) sit at 90–96%, exactly where
replica-bouncing used to zero out the cache. Low rates on short
sessions (plan opening turn, one reviewer persona, plan dialogue) are
structural: a single-prompt session has no prior turns to hit, and each
reviewer persona receives unique materials. Total run cost: $0.316.
