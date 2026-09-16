/**
 * pi tool definitions for the literature phase.
 *
 * Tool surface is deliberately tiny:
 *   search_papers — rate-limited S2/OpenAlex search
 *   save_paper    — validated, deduplicated append to papers.jsonl (+ bibtex)
 *   save_review   — store the related-work markdown
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../core/run-store.ts";
import {
  searchWithFallback,
  buildBibtex,
  paperIdentity,
  type FetchLike,
  type PaperRecord,
} from "./paper-search.ts";

export interface LiteratureToolOptions {
  store: RunStore;
  maxSearches: number;
  fetchImpl: FetchLike;
  /** Semantic Scholar API key (optional; unauthenticated is throttled harder). */
  s2ApiKey?: string;
}


const PHASE = "01-literature";
const MAX_ABSTRACT_CHARS = 1_200;

export function createLiteratureTools(options: LiteratureToolOptions): ToolDefinition[] {
  const { store, maxSearches } = options;
  let searchesUsed = 0;

  /** Identities currently in the store — the store is the dedup source of truth. */
  const savedIdentities = () =>
    new Set<string>(store.readJsonl<PaperRecord>(PHASE, "papers.jsonl").map((p) => paperIdentity(p)));

  const search_papers = defineTool({
    name: "search_papers",
    label: "Search papers",
    description:
      "Search academic papers (Semantic Scholar with OpenAlex fallback). " +
      "Returns title, authors, year, venue, citation count, arXiv id, DOI and a trimmed abstract for each hit.",
    promptSnippet: "search_papers(query, limit?) — find academic papers",
    parameters: Type.Object({
      query: Type.String({ description: "Free-text search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 20)", minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params) {
      if (searchesUsed >= maxSearches) {
        return text(
          `SEARCH BUDGET EXHAUSTED (${maxSearches} searches used). ` +
            `Proceed with the papers already collected: save the remaining relevant ones and write the review.`,
        );
      }
      searchesUsed++;
      const limit = params.limit ?? 10;
      let result;
      try {
        result = await searchWithFallback(params.query, limit, options.fetchImpl, options.s2ApiKey);
      } catch (e) {
        return text(`Search failed (${(e as Error).message}). Try a different query or proceed with saved papers.`);
      }
      if (result.hits.length === 0) {
        return text(`No results. Try broader or different query terms. (Searches used: ${searchesUsed}/${maxSearches}.)`);
      }
      const lines = result.hits.map((h, i) => {
        const abstract = h.abstract
          ? h.abstract.slice(0, MAX_ABSTRACT_CHARS) + (h.abstract.length > MAX_ABSTRACT_CHARS ? "…" : "")
          : "(no abstract available)";
        return (
          `[${i + 1}] ${h.title}\n` +
          `    authors: ${h.authors.slice(0, 6).join(", ")}${h.authors.length > 6 ? " et al." : ""}\n` +
          `    year: ${h.year ?? "?"}  venue: ${h.venue ?? "?"}  citations: ${h.citation_count ?? "?"}\n` +
          `    arxiv: ${h.arxiv_id ?? "-"}  doi: ${h.doi ?? "-"}\n` +
          `    abstract: ${abstract}`
        );
      });
      return text(
        `provider: ${result.provider} (${result.hits.length} hits)\n\n${lines.join("\n\n")}\n\n` +
          `Searches used: ${searchesUsed}/${maxSearches}.`,
      );
    },
  });

  const save_paper = defineTool({
    name: "save_paper",
    label: "Save paper",
    description:
      "Save a paper to the run's literature library (papers.jsonl). Fill fields from search results exactly; " +
      "bibtex is generated automatically. Duplicates (same DOI/arXiv id/title) are rejected.",
    promptSnippet: "save_paper(title, authors, year, ...) — add a paper to the library",
    parameters: Type.Object({
      title: Type.String({ description: "Exact paper title" }),
      authors: Type.Array(Type.String(), { description: "Author names in order" }),
      year: Type.Union([Type.Number(), Type.Null()], { description: "Publication year or null" }),
      venue: Type.Union([Type.String(), Type.Null()], { description: "Venue/journal or null" }),
      abstract: Type.Union([Type.String(), Type.Null()], { description: "Paper abstract (verbatim from search)" }),
      arxiv_id: Type.Union([Type.String(), Type.Null()], { description: "arXiv id or null" }),
      doi: Type.Union([Type.String(), Type.Null()], { description: "DOI or null" }),
      citation_count: Type.Union([Type.Number(), Type.Null()], { description: "Citation count or null" }),
      note: Type.String({
        description:
          "1-3 sentence note: the paper's exact claim, its method, and its limitation relevant to our research",
      }),
    }),
    async execute(_id, params) {
      if (!params.title.trim()) return text("Rejected: title is empty.");
      if (params.authors.length === 0) return text("Rejected: authors list is empty.");
      if (!params.note || params.note.trim().length < 20) {
        return text("Rejected: note too short — state the claim, method, and a relevant limitation.");
      }
      const identity = paperIdentity(params);
      if (savedIdentities().has(identity)) {
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
      };
      const record: PaperRecord = { ...base, bibtex: buildBibtex(base) };
      store.appendJsonl(PHASE, "papers.jsonl", record);
      return text(
        `Saved (${savedIdentities().size} total). BibTeX key: ${record.bibtex.split("{")[1]?.split(",")[0]}`,
      );
    },
  });

  const save_review = defineTool({
    name: "save_review",
    label: "Save literature review",
    description:
      "Store the related-work review as related_work.md. Call once at the end, after collecting the target papers. " +
      "Cite papers by title (the bibliography is assembled separately).",
    parameters: Type.Object({
      markdown: Type.String({ description: "Full related-work review in markdown" }),
    }),
    async execute(_id, params) {
      if (params.markdown.trim().length < 200) {
        return text("Rejected: review too short — expected a substantive survey.");
      }
      const path = store.writeText(PHASE, "related_work.md", params.markdown + "\n");
      return text(`Review saved (${params.markdown.split(/\s+/).length} words) to ${path}`);
    },
  });

  return [search_papers, save_paper, save_review];
}

function text(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: t }], details: {} };
}
