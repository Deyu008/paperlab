import { describe, it, expect } from "vitest";
import {
  RateLimiter,
  buildBibtex,
  bibtexKey,
  paperIdentity,
  searchSemanticScholar,
  searchOpenAlex,
  searchWithFallback,
  fetchJson,
  HttpError,
  snowballSemanticScholar,
  snowballOpenAlexBackward,
  rankSnowballHits,
  normalizePaperRef,
} from "../src/tools/paper-search.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after": "0" },
  });
}

describe("RateLimiter", () => {
  it("spaces serialized calls by the minimum interval (virtual clock)", async () => {
    let t = 1_000;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      50,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await Promise.all([limiter.run(async () => 1), limiter.run(async () => 2)]);
    // First call runs immediately; second waits the full interval.
    expect(waits).toEqual([50]);
  });

  it("does not sleep when enough time already elapsed", async () => {
    let t = 1_000;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      50,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await limiter.run(async () => "a");
    t += 100; // real time passes between calls
    await limiter.run(async () => "b");
    expect(waits).toEqual([]);
  });

  it("keeps the queue usable after a task rejects", async () => {
    const limiter = new RateLimiter(0);
    const first = limiter.run(() => Promise.reject(new Error("boom"))).catch((e: Error) => e.message);
    const second = await limiter.run(() => Promise.resolve("ok"));
    expect(await first).toBe("boom");
    expect(second).toBe("ok");
  });
});

describe("bibtex", () => {
  it("builds a sane key from first author, year, first word", () => {
    expect(bibtexKey("Attention Is All You Need", 2017, ["Ashish Vaswani", "Noam Shazeer"])).toBe(
      "vaswani2017attention",
    );
  });

  it("escapes braces and includes ids", () => {
    const bib = buildBibtex({
      title: "A {Study} of Things \\",
      authors: ["Jane Doe"],
      year: 2021,
      venue: "NeurIPS",
      abstract: null,
      arxiv_id: "2101.00001",
      doi: "10.1/x",
      citation_count: 5,
      source: "semantic-scholar",
      note: "n",
      read_status: "abstract",
      tldr: null,
      found_via: "search",
      quotes: [],
    });
    expect(bib).toContain("@article{doe2021study,");
    expect(bib).toContain("title = {A \\{Study\\} of Things \\\\}");
    expect(bib).toContain("eprint = {2101.00001}");
    expect(bib).toContain("doi = {10.1/x}");
  });

  it("paperIdentity prefers doi, then arxiv, then normalized title", () => {
    expect(paperIdentity({ doi: "10.1/X", arxiv_id: "a", title: "T" })).toBe("doi:10.1/x");
    expect(paperIdentity({ arxiv_id: "2101.1", title: "T" })).toBe("arxiv:2101.1");
    expect(paperIdentity({ title: "Some  Title!" })).toBe("title:some title");
  });
});

describe("provider adapters", () => {
  it("parses Semantic Scholar responses", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        data: [
          {
            paperId: "abc",
            title: "Paper One",
            authors: [{ name: "A. Author" }],
            year: 2023,
            venue: "ICML",
            abstract: "An abstract.",
            externalIds: { ArXiv: "2301.1", DOI: "10.1/p1" },
            citationCount: 42,
            tldr: { text: "A benchmark study of ensembles." },
          },
        ],
      });
    const hits = await searchSemanticScholar("query", 5, fetchImpl);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      provider_id: "abc",
      title: "Paper One",
      arxiv_id: "2301.1",
      doi: "10.1/p1",
      citation_count: 42,
      tldr: "A benchmark study of ensembles.",
    });
  });

  it("parses OpenAlex responses", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        results: [
          {
            id: "https://openalex.org/W123",
            display_name: "Paper Two",
            authorships: [{ author: { display_name: "B. Author" } }],
            publication_year: 2022,
            primary_location: { source: { display_name: "Nature" } },
            doi: "https://doi.org/10.2/p2",
            cited_by_count: 7,
            abstract_inverted_index: { "We": [0], "study": [1], "ensembles": [2] },
          },
        ],
      });
    const hits = await searchOpenAlex("query", 5, fetchImpl);
    expect(hits[0]).toMatchObject({
      provider_id: "W123",
      title: "Paper Two",
      venue: "Nature",
      doi: "10.2/p2",
      abstract: "We study ensembles",
    });
  });

  it("falls back to OpenAlex when S2 errors", async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      calls++;
      if (url.includes("semanticscholar")) return jsonResponse({ error: "rate limited" }, 429);
      return jsonResponse({ results: [{ id: "W1", display_name: "OK" }] });
    };
    const { provider, hits } = await searchWithFallback("q", 5, fetchImpl);
    expect(provider).toBe("openalex");
    expect(hits[0]?.title).toBe("OK");
  });
});

describe("fetchJson retries", () => {
  it("retries on 429/5xx then succeeds", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts++;
      return attempts < 3 ? jsonResponse({}, 500) : jsonResponse({ ok: true });
    };
    const data = (await fetchJson("https://x", fetchImpl, { retries: 3 })) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("does not retry on 4xx (except 429)", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts++;
      return jsonResponse({ error: "nope" }, 404);
    };
    await expect(fetchJson("https://x", fetchImpl)).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(1);
  });
});


// ---- snowballing ----

const CITE_PAPER = {
  paperId: "c1",
  title: "A Follow-Up Study",
  authors: [{ name: "C. Later" }],
  year: 2024,
  venue: "ICML",
  abstract: "Extends the original.",
  externalIds: { ArXiv: "2401.1" },
  citationCount: 3,
  tldr: { text: "Extension work." },
};

describe("snowballing", () => {
  it("parses forward citations from S2 and ranks them", async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes("/citations")) {
        return jsonResponse({ data: [{ citingPaper: CITE_PAPER }] });
      }
      return jsonResponse({ data: [] });
    };
    const hits = await snowballSemanticScholar("arXiv:2301.1", "forward", fetchImpl);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: "A Follow-Up Study", arxiv_id: "2401.1" });
    const ranked = rankSnowballHits(hits, 20);
    expect(ranked[0]!.title).toBe("A Follow-Up Study");
  });

  it("parses backward references from S2", async () => {
    const fetchImpl = async () =>
      jsonResponse({ data: [{ citedPaper: { paperId: "r1", title: "The Foundation", citationCount: 900, year: 1996 } }] });
    const hits = await snowballSemanticScholar("DOI:10.1/x", "backward", fetchImpl);
    expect(hits[0]).toMatchObject({ title: "The Foundation", citation_count: 900 });
  });

  it("rankSnowballHits sorts by citations then year and caps", () => {
    const hits = [
      { provider_id: "a", title: "old popular", authors: [], year: 1999, venue: null, abstract: null, arxiv_id: null, doi: null, citation_count: 100, tldr: null },
      { provider_id: "b", title: "newer equally popular", authors: [], year: 2024, venue: null, abstract: null, arxiv_id: null, doi: null, citation_count: 100, tldr: null },
      { provider_id: "c", title: "obscure", authors: [], year: 2025, venue: null, abstract: null, arxiv_id: null, doi: null, citation_count: 0, tldr: null },
    ];
    const ranked = rankSnowballHits(hits as never, 2);
    expect(ranked.map((h) => h.title)).toEqual(["newer equally popular", "old popular"]);
  });

  it("normalizePaperRef accepts arxiv/doi/bare ids and rejects junk", () => {
    expect(normalizePaperRef("2101.00001")).toBe("arXiv:2101.00001");
    expect(normalizePaperRef("arXiv:2101.00001v3")).toBe("arXiv:2101.00001v3");
    expect(normalizePaperRef("10.1000/x.y")).toBe("DOI:10.1000/x.y");
    expect(normalizePaperRef("abc123def456")).toBe("abc123def456");
    expect(() => normalizePaperRef("not a ref!")).toThrow(/unresolvable/);
  });

  it("OpenAlex backward fallback reads referenced_works", async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes("doi.org")) {
        return jsonResponse({ referenced_works: ["https://openalex.org/W100", "https://openalex.org/W200"] });
      }
      return jsonResponse({
        results: [
          { id: "https://openalex.org/W100", display_name: "Ref One", cited_by_count: 50 },
          { id: "https://openalex.org/W200", display_name: "Ref Two", cited_by_count: 5 },
        ],
      });
    };
    const hits = await snowballOpenAlexBackward("10.1/anchor", fetchImpl);
    expect(hits.map((h) => h.title)).toEqual(["Ref One", "Ref Two"]);
  });
});
