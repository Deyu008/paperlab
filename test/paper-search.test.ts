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
          },
        ],
      });
    const hits = await searchOpenAlex("query", 5, fetchImpl);
    expect(hits[0]).toMatchObject({
      provider_id: "W123",
      title: "Paper Two",
      venue: "Nature",
      doi: "10.2/p2",
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
