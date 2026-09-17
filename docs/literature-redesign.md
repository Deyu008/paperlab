# Literature module redesign (research funnel)

Replaced "keyword search + abstract-only notes" with the funnel a real
researcher runs, enforced mechanically:

    discover (search) → anchors → snowball (backward = foundations,
    forward = competitors) → tiered full-text reads → provenance-gated
    saves → evidence-tiered survey with "Closest prior work"

## Tools

| tool | backend | discipline |
| --- | --- | --- |
| search_papers | S2 → OpenAlex (tldr field; OpenAlex inverted-index abstracts now decoded) | budget + audit |
| snowball | S2 /references + /citations (OpenAlex backward fallback needs DOI) | budget + ranked top-20 + found_via provenance + audit with returned identities |
| read_paper | arxiv.org/html → ar5iv, 3s rate limit, cached per run | distinct-paper budget; unavailable full text is recorded, never faked |
| save_paper | — | number gate (note numbers must appear in abstract/tldr/fulltext), quote gate (verbatim, ws-normalized), full-tier gate (requires successful read_paper), dedup |
| save_review | — | requires "Closest prior work" section |

## Coverage is computed by the orchestrator

Every tool call appends to `01-literature/usage-audit.jsonl`; the phase
end computes `coverage-report.json` from that log (funnel conversions,
snowball contribution, orphan papers disconnected from all anchors,
query diversity). The agent cannot self-report coverage.

## Post-conditions

Hard (phase fails): ≥ min papers · review present with closest-prior-work ·
≥ 1 snowball call · ≥ 1 full-text read attempt (papers without arXiv
full text must have attempts on record — "never tried" is not honesty).
Soft (warnings in report): snowball contribution < 2 · full reads < 2 ·
orphans > 30% · queries < 5.

## Downstream

Plan dialogue sees evidence tiers (📗 full-read / 📄 abstract-only) per
paper; reviewers receive the same tiers so claims resting on abstract-only
understanding can be named.

Rejected during design: SPECTER recommendations (overlaps snowball; tool
sprawl dilutes discipline) — revisit with live data.
