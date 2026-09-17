/**
 * pi tool definitions for the literature phase — the research funnel.
 *
 *   search_papers  keyword discovery (S2 → OpenAlex), tldr included
 *   snowball       citation-graph expansion from anchor papers (fwd/back)
 *   read_paper     paginated arXiv full text (HTML/ar5iv), cached per run
 *   save_paper     validated, deduplicated, PROVENANCE-GATED library write
 *   save_review    related-work survey with evidence tiers
 *
 * Discipline is mechanical: notes containing numbers must find those numbers
 * in the abstract/tldr/full text; claimed quotes must match the source
 * verbatim (whitespace-normalized); "full" read_status requires a successful
 * read_paper this session. Every call appends to an audit log that the
 * orchestrator — not the agent — turns into the coverage report.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../core/run-store.ts";
import {
  searchWithFallback,
  snowballSemanticScholar,
  snowballOpenAlexBackward,
  rankSnowballHits,
  buildBibtex,
  paperIdentity,
  RateLimiter,
  type FetchLike,
  type PaperRecord,
  type SearchHit,
} from "./paper-search.ts";
import {
  FulltextCache,
  fetchFulltext,
  parseCachedSections,
  findSection,
  pageSection,
  FulltextUnavailableError,
} from "./paper-fulltext.ts";
import { RateLimiter as ArxivRateLimiter } from "./paper-search.ts";
import { computeCoverage, type AuditRecord } from "./coverage.ts";

export interface LiteratureToolOptions {
  store: RunStore;
  maxSearches: number;
  maxSnowballs: number;
  maxFullReads: number;
  fetchImpl: FetchLike;
  /** Semantic Scholar API key (optional; unauthenticated is throttled harder). */
  s2ApiKey?: string;
  /** Shared rate limiter for S2 traffic (1 rps per ToS). */
  limiter?: RateLimiter;
  /** Rate limiter for arXiv full-text fetches (3 s per ToS); tests inject 0. */
  arxivLimiter?: RateLimiter;
}

const PHASE = "01-literature";
const MAX_ABSTRACT_CHARS = 1_200;
const MAX_TLDR_CHARS = 400;
const MIN_QUOTE_CHARS = 15;
const SNOWBALL_LIMIT = 20;

const passthrough = <T>(task: () => Promise<T>): Promise<T> => task();

export function createLiteratureTools(options: LiteratureToolOptions): ToolDefinition[] {
  const { store, maxSearches } = options;
  const limiter = options.limiter ?? { run: passthrough };
  const cache = new FulltextCache(store.phaseDir(PHASE));
  let searchesUsed = 0;
  let snowballsUsed = 0;
  const readBudget = new Set<string>(); // unique arxiv ids charged to the full-read budget
  // Identity cache seeded once, extended on save: avoids re-reading and
  // re-parsing papers.jsonl on every save_paper call.
  const identityCache = new Set<string>(
    store.readJsonl<PaperRecord>(PHASE, "papers.jsonl").map((p) => paperIdentity(p)),
  );

  const audit = (record: Omit<AuditRecord, "ts">): void => {
    store.appendJsonl(PHASE, "usage-audit.jsonl", { ts: new Date().toISOString(), ...record });
  };

  // ---- search ---------------------------------------------------------------

  const search_papers = defineTool({
    name: "search_papers",
    label: "Search papers",
    description:
      "Search academic papers (Semantic Scholar with OpenAlex fallback). Returns title, authors, " +
      "year, venue, citations, arXiv id, DOI, abstract and a one-line TL;DR per hit.",
    promptSnippet: "search_papers(query, limit?) — keyword discovery",
    parameters: Type.Object({
      query: Type.String({ description: "Free-text search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 20)", minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params) {
      if (searchesUsed >= maxSearches) {
        return text(
          `SEARCH BUDGET EXHAUSTED (${maxSearches} used). Move to snowballing from your best hits, ` +
            `or finish: save remaining relevant papers and write the review.`,
        );
      }
      searchesUsed++;
      const limit = params.limit ?? 10;
      let result: Awaited<ReturnType<typeof searchWithFallback>>;
      try {
        result = await limiter.run(() =>
          searchWithFallback(params.query, limit, options.fetchImpl, options.s2ApiKey),
        );
      } catch (e) {
        audit({ kind: "search", query: params.query, hits: 0 });
        return text(`Search failed (${(e as Error).message}). Try a different query or proceed with saved papers.`);
      }
      audit({ kind: "search", query: params.query, hits: result.hits.length, provider: result.provider });
      if (result.hits.length === 0) {
        return text(`No results. Try broader or different terms. (Searches used: ${searchesUsed}/${maxSearches}.)`);
      }
      return text(
        `provider: ${result.provider} (${result.hits.length} hits)\n\n${formatHits(result.hits)}\n\n` +
          `Searches used: ${searchesUsed}/${maxSearches}.`,
      );
    },
  });

  // ---- snowball -------------------------------------------------------------

  const snowball = defineTool({
    name: "snowball",
    label: "Citation snowball",
    description:
      "Expand the citation graph of an anchor paper. direction=backward lists its references " +
      "(foundations); direction=forward lists papers citing it (follow-ups and competitors — " +
      "essential for the novelty claim). Results are ranked by citations, newest first on ties.",
    promptSnippet: "snowball(paper_ref, direction) — expand the citation graph of an anchor paper",
    parameters: Type.Object({
      paper_ref: Type.String({
        description: 'Anchor paper: "arXiv:2101.00001", "DOI:10.x/yyy", or a Semantic Scholar paper id',
      }),
      direction: Type.Union([Type.Literal("backward"), Type.Literal("forward")], {
        description: "backward = references of the anchor; forward = papers citing the anchor",
      }),
    }),
    async execute(_id, params) {
      if (snowballsUsed >= options.maxSnowballs) {
        return text(
          `SNOWBALL BUDGET EXHAUSTED (${options.maxSnowballs} used). ` +
            `Pick anchors you already have and continue with search/read.`,
        );
      }
      snowballsUsed++;
      let hits: SearchHit[];
      try {
        hits = await limiter.run(() =>
          snowballSemanticScholar(params.paper_ref, params.direction, options.fetchImpl, options.s2ApiKey),
        );
      } catch (s2Error) {
        // OpenAlex fallback covers backward snowballing and needs a DOI.
        try {
          hits = await limiter.run(() => snowballOpenAlexBackward(params.paper_ref, options.fetchImpl));
        } catch {
          audit({ kind: "snowball", paper_ref: params.paper_ref, direction: params.direction, hits: 0, returned: [] });
          return text(
            `Snowball failed: ${(s2Error as Error).message}. ` +
              `The OpenAlex fallback needs the paper's DOI. Try another anchor or search_papers instead.`,
          );
        }
      }
      const top = rankSnowballHits(hits, SNOWBALL_LIMIT);
      const foundVia = `snowball:${params.paper_ref}/${params.direction}`;
      audit({
        kind: "snowball",
        paper_ref: params.paper_ref,
        direction: params.direction,
        hits: top.length,
        returned: top.map((h) => paperIdentity(h)),
      });
      if (top.length === 0) {
        return text(`No ${params.direction} citations found for ${params.paper_ref}.`);
      }
      return text(
        `${top.length} ${params.direction} papers of ${params.paper_ref} (ranked by citations):\n\n` +
          formatHits(top) +
          `\n\nfound_via tag for save_paper: "${foundVia}". Snowballs used: ${snowballsUsed}/${options.maxSnowballs}.`,
      );
    },
  });

  // ---- read -----------------------------------------------------------------

  const read_paper = defineTool({
    name: "read_paper",
    label: "Read paper",
    description:
      "Read the FULL TEXT of an arXiv paper, section by section. Call without section first to get " +
      "the table of contents; then request sections like 'method' or 'results'. Math extraction is " +
      "lossy — trust prose over formulas. Papers without arXiv full text report an error; keep their " +
      "read_status at 'abstract'.",
    promptSnippet: "read_paper(arxiv_id, section?, cursor?) — paginated full text",
    parameters: Type.Object({
      arxiv_id: Type.String({ description: "arXiv id, e.g. 2101.00001" }),
      section: Type.Optional(Type.String({ description: "Section title fragment, e.g. 'method' or 'results'" })),
      cursor: Type.Optional(Type.Number({ description: "Character offset from a previous page's nextCursor" })),
    }),
    async execute(_id, params) {
      const arxivId = params.arxiv_id.trim();
      if (!readBudget.has(arxivId)) {
        if (readBudget.size >= options.maxFullReads) {
          return text(
            `FULL-READ BUDGET EXHAUSTED (${options.maxFullReads} distinct papers). ` +
              `Save what you have; keep remaining papers at read_status 'abstract'.`,
          );
        }
        readBudget.add(arxivId);
      }
      audit({ kind: "read_attempt", arxiv_id: arxivId });

      let fulltext: string;
      try {
        const fetched = await fetchFulltext(
          arxivId,
          cache,
          options.fetchImpl,
          options.arxivLimiter ?? new ArxivRateLimiter(3_000),
        );
        fulltext = fetched.text;
      } catch (e) {
        const reason = e instanceof FulltextUnavailableError ? e.message : (e as Error).message;
        audit({ kind: "read_failed", arxiv_id: arxivId, error: reason.slice(0, 200) });
        return text(
          `No full text: ${reason}. Keep this paper at read_status 'abstract' — ` +
            `its note may then only cite numbers present in the abstract.`,
        );
      }
      audit({ kind: "read_ok", arxiv_id: arxivId });
      const sections = parseCachedSections(fulltext);
      if (sections.length === 0) return text("Full text downloaded but no readable sections found.");

      let target = sections[0]!;
      if (params.section) {
        const found = findSection(sections, params.section);
        if (!found) {
          return text(
            `No section matching "${params.section}". Table of contents:\n` +
              sections.map((s) => `- ${s.title}`).join("\n"),
          );
        }
        target = found;
      }
      const page = pageSection(sections, target, params.cursor ?? null);
      return text(
        `TOC: ${page.tableOfContents.join(" | ")}\n\n## ${page.title}` +
          (params.cursor ? ` (from offset ${params.cursor})` : "") +
          `\n\n${page.page}` +
          (page.hasMore
            ? `\n\n[more] call again with section="${page.title}" and cursor=${page.nextCursor}`
            : "\n\n[end of section]"),
      );
    },
  });

  // ---- save -----------------------------------------------------------------

  const save_paper = defineTool({
    name: "save_paper",
    label: "Save paper",
    description:
      "Save a paper to the run's literature library. Provenance gates: read_status 'full' requires " +
      "a successful read_paper this session; numbers in the note must appear in the abstract (or " +
      "cached full text); quotes must match the source verbatim. Duplicates are rejected.",
    promptSnippet: "save_paper(...) — provenance-gated library write",
    parameters: Type.Object({
      title: Type.String({ description: "Exact paper title" }),
      authors: Type.Array(Type.String(), { description: "Author names in order" }),
      year: Type.Union([Type.Number(), Type.Null()], { description: "Publication year or null" }),
      venue: Type.Union([Type.String(), Type.Null()], { description: "Venue/journal or null" }),
      abstract: Type.Union([Type.String(), Type.Null()], { description: "Paper abstract (verbatim from search)" }),
      arxiv_id: Type.Union([Type.String(), Type.Null()], { description: "arXiv id or null" }),
      doi: Type.Union([Type.String(), Type.Null()], { description: "DOI or null" }),
      citation_count: Type.Union([Type.Number(), Type.Null()], { description: "Citation count or null" }),
      tldr: Type.Union([Type.String(), Type.Null()], { description: "TL;DR from search results, or null" }),
      read_status: Type.Union([Type.Literal("abstract"), Type.Literal("full")], {
        description: "'full' only if you read the full text via read_paper this session",
      }),
      found_via: Type.Union([Type.String(), Type.Null()], {
        description: 'Provenance: "search", the snowball tag, or "manual"',
      }),
      quotes: Type.Optional(
        Type.Array(Type.String(), { description: "Optional verbatim quotes (≥15 chars) backing your note" }),
      ),
      note: Type.String({
        description:
          "1-3 sentences: the paper's exact claim, its method, and its limitation relevant to our research. " +
          "Any NUMBER you write must appear in the abstract or full text — no exceptions.",
      }),
    }),
    async execute(_id, params) {
      if (!params.title.trim()) return text("Rejected: title is empty.");
      if (params.authors.length === 0) return text("Rejected: authors list is empty.");
      if (!params.note || params.note.trim().length < 20) {
        return text("Rejected: note too short — state the claim, method, and a relevant limitation.");
      }
      if (params.read_status === "full") {
        const cached = params.arxiv_id ? cache.get(params.arxiv_id) : null;
        if (cached === null) {
          return text(
            "Rejected: read_status 'full' requires a successful read_paper call for this arxiv_id " +
              "in this session. Re-save with read_status 'abstract', or read the paper first.",
          );
        }
      }

      // Provenance sources for number/quote grounding, in priority order.
      const sources: string[] = [];
      if (params.abstract) sources.push(params.abstract);
      if (params.tldr) sources.push(params.tldr);
      if (params.read_status === "full" && params.arxiv_id) sources.push(cache.get(params.arxiv_id) ?? "");
      const haystack = sources.map(normalizeWs).join("\n");

      // Number gate: every meaningful number in the note must be grounded.
      const numbers = extractNumbers(params.note);
      const ungrounded = numbers.filter((n) => !haystack.includes(normalizeNumber(n)));
      if (ungrounded.length > 0) {
        return text(
          `Rejected: note cites number(s) not found in the ` +
            `${params.read_status === "full" ? "full text/abstract" : "abstract"}: ` +
            `${ungrounded.join(", ")}. Remove them, or read_paper first and keep only grounded numbers.`,
        );
      }

      // Quote gate: verbatim after whitespace normalization.
      for (const quote of params.quotes ?? []) {
        if (quote.trim().length < MIN_QUOTE_CHARS) {
          return text(`Rejected: quote too short (≥${MIN_QUOTE_CHARS} chars): "${quote}"`);
        }
        if (!haystack.includes(normalizeWs(quote))) {
          return text(`Rejected: quote not found verbatim in the source: "${quote.slice(0, 60)}…"`);
        }
      }

      const identity = paperIdentity(params);
      if (identityCache.has(identity)) {
        return text(`Rejected: duplicate of an already-saved paper (${identity}).`);
      }
      const base: Omit<PaperRecord, "bibtex"> = {
        title: params.title.trim(),
        authors: params.authors,
        year: params.year ?? null,
        venue: params.venue ?? null,
        abstract: params.abstract ?? null,
        arxiv_id: params.arxiv_id ?? null,
        doi: params.doi ?? null,
        citation_count: params.citation_count ?? null,
        source: "semantic-scholar",
        note: params.note.trim(),
        read_status: params.read_status,
        tldr: params.tldr ?? null,
        found_via: params.found_via ?? "search",
        quotes: params.quotes ?? [],
      };
      const record: PaperRecord = { ...base, bibtex: buildBibtex(base) };
      identityCache.add(identity);
      store.appendJsonl(PHASE, "papers.jsonl", record);
      return text(
        `Saved as ${record.read_status.toUpperCase()} (${identityCache.size} total, ` +
          `${record.found_via}). BibTeX key: ${record.bibtex.split("{")[1]?.split(",")[0]}`,
      );
    },
  });

  // ---- review ---------------------------------------------------------------

  const save_review = defineTool({
    name: "save_review",
    label: "Save literature review",
    description:
      "Store the related-work survey as related_work.md. Distinguish papers you read in full from " +
      "abstract-only ones, and include a 'Closest prior work' section naming the papers our research " +
      "must differentiate from.",
    parameters: Type.Object({
      markdown: Type.String({ description: "Full related-work review in markdown" }),
    }),
    async execute(_id, params) {
      if (params.markdown.trim().length < 200) {
        return text("Rejected: review too short — expected a substantive survey.");
      }
      if (!/closest prior work/i.test(params.markdown)) {
        return text(
          "Rejected: missing a 'Closest prior work' section — name the papers we must differentiate from.",
        );
      }
      const path = store.writeText(PHASE, "related_work.md", params.markdown + "\n");
      const coverage = computeCoverage(store);
      return text(
        `Review saved (${params.markdown.split(/\s+/).length} words) to ${path}. ` +
          `Funnel so far: ${coverage.funnel.saved} saved ` +
          `(${coverage.funnel.byReadStatus["full"] ?? 0} full / ${coverage.funnel.byReadStatus["abstract"] ?? 0} abstract), ` +
          `${coverage.searches.total} searches, ${coverage.snowballs.total} snowballs, ` +
          `${coverage.reads.ok} full reads.`,
      );
    },
  });

  return [search_papers, snowball, read_paper, save_paper, save_review];
}

// ---- helpers ----------------------------------------------------------------

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Meaningful numbers: decimals, percentages, or integers ≥ 2 digits (years excluded). */
export function extractNumbers(text: string): string[] {
  const raw = text.match(/\d+(?:[.,]\d+)*%?/g) ?? [];
  return raw.filter((n) => {
    if (/^(19|20)\d{2}$/.test(n)) return false; // years are metadata, not claims
    return /\d\d/.test(n.replace(/[.,]/g, "")) || n.includes("%") || /[.,]\d/.test(n);
  });
}

function normalizeNumber(n: string): string {
  return n.replace(/,/g, "");
}

function formatHit(h: SearchHit, index: number): string {
  const abstract = h.abstract
    ? h.abstract.slice(0, MAX_ABSTRACT_CHARS) + (h.abstract.length > MAX_ABSTRACT_CHARS ? "…" : "")
    : "(no abstract available)";
  const tldr = h.tldr ? `\n    tldr: ${h.tldr.slice(0, MAX_TLDR_CHARS)}` : "";
  return (
    `[${index + 1}] ${h.title}\n` +
    `    authors: ${h.authors.slice(0, 6).join(", ")}${h.authors.length > 6 ? " et al." : ""}\n` +
    `    year: ${h.year ?? "?"}  venue: ${h.venue ?? "?"}  citations: ${h.citation_count ?? "?"}\n` +
    `    arxiv: ${h.arxiv_id ?? "-"}  doi: ${h.doi ?? "-"}${tldr}\n` +
    `    abstract: ${abstract}`
  );
}

function formatHits(hits: SearchHit[]): string {
  return hits.map((h, i) => formatHit(h, i)).join("\n\n");
}

function text(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
