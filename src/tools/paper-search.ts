/**
 * Literature search tools for phase 1.
 *
 * `search_papers` queries Semantic Scholar (falling back to OpenAlex) with
 * strict rate limiting; `save_paper` validates + deduplicates and appends to
 * the run's papers.jsonl; `save_review` stores the related-work write-up.
 * All HTTP goes through an injectable fetch for testability.
 */

export interface PaperRecord {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  arxiv_id: string | null;
  doi: string | null;
  citation_count: number | null;
  source: "semantic-scholar" | "openalex";
  note: string | null;
  bibtex: string;
}

/** Minimal fetch shape so tests can stub networking. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Rate limiting + HTTP with retries
// ---------------------------------------------------------------------------

export class RateLimiter {
  private lastAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Serialize calls and space them at least `minIntervalMs` apart. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const gate = this.queue.then(async () => {
      const wait = Math.max(0, this.lastAt + this.minIntervalMs - this.now());
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();
    });
    // Keep the queue alive even when a gated task later rejects.
    this.queue = gate.catch(() => {});
    return gate.then(task);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export async function fetchJson(
  url: string,
  fetchImpl: FetchLike,
  options: { retries?: number; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<unknown> {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastError: Error = new Error("unreachable");
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: options.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        // Exponential backoff, honoring Retry-After when present.
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 500 * 2 ** attempt;
        lastError = new HttpError(res.status, url);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as unknown;
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      lastError = e as Error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Provider adapters (normalized PaperRecord-ish shape, sans note/bibtex)
// ---------------------------------------------------------------------------

export interface SearchHit {
  provider_id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  arxiv_id: string | null;
  doi: string | null;
  citation_count: number | null;
}

const S2_BASE = "https://api.semanticscholar.org/graph/v1/paper/search";
const S2_FIELDS = "title,authors,year,venue,abstract,externalIds,citationCount";

interface S2Author {
  name?: string;
}

export async function searchSemanticScholar(
  query: string,
  limit: number,
  fetchImpl: FetchLike,
  apiKey?: string,
): Promise<SearchHit[]> {
  const url = `${S2_BASE}?query=${encodeURIComponent(query)}&limit=${limit}&fields=${S2_FIELDS}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const data = (await fetchJson(url, fetchImpl, { headers })) as { data?: unknown[] };
  if (!Array.isArray(data.data)) return [];
  return data.data.map((raw) => {
    const p = raw as {
      paperId?: string;
      title?: string;
      authors?: S2Author[];
      year?: number;
      venue?: string;
      abstract?: string;
      externalIds?: { ArXiv?: string; DOI?: string };
      citationCount?: number;
    };
    return {
      provider_id: p.paperId ?? "",
      title: p.title ?? "",
      authors: (p.authors ?? []).map((a) => a.name ?? "").filter(Boolean),
      year: p.year ?? null,
      venue: p.venue || null,
      abstract: p.abstract ?? null,
      arxiv_id: p.externalIds?.ArXiv ?? null,
      doi: p.externalIds?.DOI ?? null,
      citation_count: p.citationCount ?? null,
    };
  });
}

const OPENALEX_BASE = "https://api.openalex.org/works";

interface OpenAlexAuthorship {
  author?: { display_name?: string };
}

export async function searchOpenAlex(
  query: string,
  limit: number,
  fetchImpl: FetchLike,
  mailto?: string,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ search: query, per_page: String(Math.min(limit, 50)) });
  if (mailto) params.set("mailto", mailto);
  const data = (await fetchJson(`${OPENALEX_BASE}?${params}`, fetchImpl)) as { results?: unknown[] };
  if (!Array.isArray(data.results)) return [];
  return data.results.map((raw) => {
    const w = raw as {
      id?: string;
      title?: string;
      display_name?: string;
      authorships?: OpenAlexAuthorship[];
      publication_year?: number;
      primary_location?: { source?: { display_name?: string } };
      doi?: string;
      cited_by_count?: number;
      locations?: Array<{ source?: { display_name?: string } }>;
    };
    const venue =
      w.primary_location?.source?.display_name ?? w.locations?.[0]?.source?.display_name ?? null;
    return {
      provider_id: (w.id ?? "").replace("https://openalex.org/", ""),
      title: w.title ?? w.display_name ?? "",
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean),
      year: w.publication_year ?? null,
      venue,
      abstract: null, // OpenAlex abstracts are inverted-index encoded; skip for MVP
      arxiv_id: null,
      doi: w.doi ? w.doi.replace("https://doi.org/", "") : null,
      citation_count: w.cited_by_count ?? null,
    };
  });
}

/** Search S2 first; on failure fall back to OpenAlex. */
export async function searchWithFallback(
  query: string,
  limit: number,
  fetchImpl: FetchLike,
  apiKey?: string,
): Promise<{ hits: SearchHit[]; provider: "semantic-scholar" | "openalex" }> {
  try {
    return { hits: await searchSemanticScholar(query, limit, fetchImpl, apiKey), provider: "semantic-scholar" };
  } catch {
    return { hits: await searchOpenAlex(query, limit, fetchImpl), provider: "openalex" };
  }
}

// ---------------------------------------------------------------------------
// BibTeX generation + dedup
// ---------------------------------------------------------------------------

export function bibtexKey(title: string, year: number | null, authors: string[]): string {
  const firstAuthor = (authors[0] ?? "anonymous").split(/\s+/).pop() ?? "anonymous";
  const words = title.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, ""));
  // Prefer the first significant word; stop-words like "a"/"the"/"on" make bad keys.
  const word = words.find((w) => w.length >= 3) ?? words.find((w) => w.length > 0) ?? "paper";
  const author = firstAuthor.toLowerCase().replace(/[^a-z]/g, "");
  return `${author || "anon"}${year ?? "nd"}${word}`;
}

function escapeBibtex(value: string): string {
  return value.replace(/[\\{}]/g, (m) => `\\${m}`);
}

export function buildBibtex(record: Omit<PaperRecord, "bibtex">): string {
  const key = bibtexKey(record.title, record.year, record.authors);
  // Elements are joined with ",\n" below, so no trailing commas inside elements.
  const lines = [`@article{${key}`];
  lines.push(`  title = {${escapeBibtex(record.title)}}`);
  if (record.authors.length > 0) {
    lines.push(`  author = {${escapeBibtex(record.authors.join(" and "))}}`);
  }
  if (record.year !== null) lines.push(`  year = {${record.year}}`);
  if (record.venue) lines.push(`  journal = {${escapeBibtex(record.venue)}}`);
  if (record.doi) lines.push(`  doi = {${record.doi}}`);
  if (record.arxiv_id) lines.push(`  eprint = {${record.arxiv_id}}\n  archivePrefix = {arXiv}`);
  lines.push(`  source = {${record.source}}`);
  lines.push("}");
  return lines.join(",\n");
}

/** Stable identity for dedup: DOI > arXiv id > normalized title. */
export function paperIdentity(input: { doi?: string | null; arxiv_id?: string | null; title: string }): string {
  if (input.doi) return `doi:${input.doi.toLowerCase()}`;
  if (input.arxiv_id) return `arxiv:${input.arxiv_id}`;
  return `title:${input.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}
