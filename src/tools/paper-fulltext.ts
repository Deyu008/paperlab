/**
 * arXiv full-text acquisition for the literature funnel.
 *
 * Tries arxiv.org/html first (native HTML for recent papers), then ar5iv
 * (LaTeX-source renderings for older ones). Rate-limited at one request per
 * 3 seconds (arXiv ToS). Fetched documents are cached as run artifacts so
 * pagination, provenance gates, and retries never re-download.
 *
 * Honesty note surfaced to agents: math extraction is lossy — method
 * understanding should lean on prose; numeric provenance gates only need
 * literal string matching, which survives extraction.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RateLimiter } from "./paper-search.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const arxivLimiter = new RateLimiter(3_000);

export class FulltextUnavailableError extends Error {
  constructor(
    readonly arxivId: string,
    readonly triedStatuses: Array<{ url: string; status: number }>,
  ) {
    super(
      `no arXiv full text available for ${arxivId} ` +
        `(tried: ${triedStatuses.map((t) => `${t.url.split("/")[2]}=${t.status}`).join(", ")})`,
    );
    this.name = "FulltextUnavailableError";
  }
}

export interface FulltextSection {
  title: string;
  text: string;
}

export interface ParsedPaper {
  sections: FulltextSection[];
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function cleanText(html: string): string {
  return decodeEntities(stripTags(html))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split arXiv paper HTML into sections on h2-h4 headings (h1 is the paper
 * title in the arXiv/ar5iv convention, not a section boundary). Content
 * before the first heading becomes "Front matter" (title/abstract typically).
 * <math> blocks collapse to a "[math]" marker — extraction is lossy there.
 */
export function extractSections(html: string): ParsedPaper {
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<math[\s\S]*?<\/math>/gi, " [math] ")
    .replace(/<(figure|table)([\s\S]*?)<\/\1>/gi, (m, tag: string, inner: string) =>
      /<figcaption|<tbody/i.test(inner) && tag === "table" ? " [table omitted] " : " ",
    );

  // h1 is the paper title (arXiv/ar5iv convention) — section boundaries are h2-h4.
  const headingRe = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const sections: FulltextSection[] = [];
  const pushSection = (title: string, raw: string): void => {
    const text = cleanText(raw);
    if (text.length > 0) sections.push({ title: cleanText(title) || "Untitled section", text });
  };

  interface Heading {
    title: string;
    index: number;   // position of the heading tag in body
    openEnd: number; // index just past the heading's closing tag
  }
  const headings: Heading[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(body)) !== null) {
    headings.push({ title: stripTags(match[2] ?? ""), index: match.index, openEnd: match.index + match[0].length });
  }
  if (headings.length === 0) {
    pushSection("Front matter", body);
    return { sections };
  }
  pushSection("Front matter", body.slice(0, headings[0]!.index));
  for (let i = 0; i < headings.length; i++) {
    const end = i + 1 < headings.length ? headings[i + 1]!.index : body.length;
    pushSection(headings[i]!.title, body.slice(headings[i]!.openEnd, end));
  }
  return { sections };
}

/** Canonical cache key for an arXiv id (filesystem-safe). */
export function arxivCacheKey(arxivId: string): string {
  return arxivId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

/** Simple append-only cache over a run directory. */
export class FulltextCache {
  private readonly dir: string;

  constructor(rootDir: string) {
    this.dir = join(rootDir, "fulltext");
    mkdirSync(this.dir, { recursive: true });
  }

  get(arxivId: string): string | null {
    const p = join(this.dir, `${arxivCacheKey(arxivId)}.txt`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  put(arxivId: string, text: string): void {
    writeFileSync(join(this.dir, `${arxivCacheKey(arxivId)}.txt`), text);
  }
}

export interface FetchedFulltext {
  text: string;
  source: "arxiv" | "ar5iv";
  cached: boolean;
}

/**
 * Download (or read from cache) the full text of an arXiv paper as plain
 * text with section markers ("## <title>" lines) preserved for pagination.
 */
export async function fetchFulltext(
  arxivId: string,
  cache: FulltextCache,
  fetchImpl: FetchLike,
  limiter: RateLimiter = arxivLimiter,
): Promise<FetchedFulltext> {
  const id = arxivId.trim();
  const cached = cache.get(id);
  if (cached !== null) return { text: cached, source: "arxiv", cached: true };

  const tried: Array<{ url: string; status: number }> = [];
  const candidates: Array<{ url: string; source: "arxiv" | "ar5iv" }> = [
    { url: `https://arxiv.org/html/${id}`, source: "arxiv" },
    { url: `https://ar5iv.labs.arxiv.org/html/${id}`, source: "ar5iv" },
  ];
  for (const candidate of candidates) {
    await limiter.run(async () => undefined); // serialize + space requests
    let res: Response;
    try {
      res = await fetchImpl(candidate.url);
    } catch (e) {
      tried.push({ url: candidate.url, status: 0 });
      continue;
    }
    if (!res.ok) {
      tried.push({ url: candidate.url, status: res.status });
      continue;
    }
    const html = await res.text();
    if (html.length < 2_000 || !/<(section|h1|h2|p)/i.test(html)) {
      tried.push({ url: candidate.url, status: 200 });
      continue;
    }
    const parsed = extractSections(html);
    const text = parsed.sections.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n");
    cache.put(id, text);
    return { text, source: candidate.source, cached: false };
  }
  throw new FulltextUnavailableError(id, tried);
}

/** Parse cached "## Title" text back into sections. */
export function parseCachedSections(text: string): FulltextSection[] {
  const sections: FulltextSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      if (current) sections.push({ title: current.title, text: current.lines.join("\n").trim() });
      current = { title: m[1]!.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ title: current.title, text: current.lines.join("\n").trim() });
  return sections.filter((s) => s.text.length > 0 || s.title === "Front matter");
}

/** Find a section by case-insensitive substring of its title. */
export function findSection(sections: FulltextSection[], query: string): FulltextSection | null {
  const q = query.trim().toLowerCase();
  return (
    sections.find((s) => s.title.toLowerCase().includes(q)) ??
    sections.find((s) => q.includes(s.title.toLowerCase()) && s.title.length > 3) ??
    null
  );
}

export interface SectionPage {
  title: string;
  page: string;
  nextCursor: number | null;
  hasMore: boolean;
  tableOfContents: string[];
}

const PAGE_SIZE = 8_000;

/** Paginate a section's text (cursor = character offset). */
export function pageSection(
  sections: FulltextSection[],
  section: FulltextSection,
  cursor: number | null,
): SectionPage {
  const start = Math.max(0, cursor ?? 0);
  const page = section.text.slice(start, start + PAGE_SIZE);
  const next = start + page.length;
  return {
    title: section.title,
    page,
    nextCursor: next < section.text.length ? next : null,
    hasMore: next < section.text.length,
    tableOfContents: sections.map((s) => s.title),
  };
}
