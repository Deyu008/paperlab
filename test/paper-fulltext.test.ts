import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSections,
  parseCachedSections,
  findSection,
  pageSection,
  fetchFulltext,
  FulltextCache,
  FulltextUnavailableError,
  arxivCacheKey,
} from "../src/tools/paper-fulltext.ts";
import { RateLimiter } from "../src/tools/paper-search.ts";

const HTML = `
<html><head><style>.x{color:red}</style><script>evil()</script></head>
<body>
<h1>Bagging Predictors</h1>
<p>Abstract: ensembles reach 87.3% accuracy on our benchmark suite.</p>
<h2>1 Introduction</h2>
<p>We study variance reduction with seeded runs.</p>
<math><mi>x</mi></math>
<h2>2 Method</h2>
<p>The method combines bootstrap aggregation with gradient boosting. ${"detail ".repeat(2000)}</p>
<h3>2.1 Tuning</h3><p>Grid search with 3 folds.</p>
<h2>3 Results</h2><p>See table 1.</p>
</body></html>`;

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-ft-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("extractSections", () => {
  it("splits on headings, drops scripts/styles, marks math", () => {
    const { sections } = extractSections(HTML);
    const titles = sections.map((s) => s.title);
    expect(titles).toEqual(["Front matter", "1 Introduction", "2 Method", "2.1 Tuning", "3 Results"]);
    const front = sections[0]!.text;
    expect(front).toContain("87.3% accuracy");
    expect(front).not.toContain("evil()");
    expect(front).not.toContain(".x{color");
    expect(sections.find((s) => s.title === "1 Introduction")!.text).toContain("[math]");
  });

  it("handles documents without headings as one front-matter section", () => {
    const { sections } = extractSections("<html><body><p>just text</p></body></html>");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Front matter");
  });
});

describe("pagination", () => {
  it("pages long sections with cursors", () => {
    const { sections } = extractSections(HTML);
    const method = findSection(sections, "method")!;
    expect(method.title).toBe("2 Method");
    const page1 = pageSection(sections, method, null);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeGreaterThan(0);
    const page2 = pageSection(sections, method, page1.nextCursor);
    expect(page1.page).not.toBe(page2.page);
  });

  it("findSection matches case-insensitively and returns null on miss", () => {
    const { sections } = extractSections(HTML);
    expect(findSection(sections, "RESULTS")!.title).toBe("3 Results");
    expect(findSection(sections, "nonexistent")).toBeNull();
  });

  it("parseCachedSections round-trips the cached format", () => {
    const { sections } = extractSections(HTML);
    const cached = sections.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n");
    const reparsed = parseCachedSections(cached);
    expect(reparsed.map((s) => s.title)).toEqual(sections.map((s) => s.title));
  });
});

describe("FulltextCache", () => {
  it("round-trips and sanitizes keys", () => {
    const cache = new FulltextCache(base);
    cache.put("2101.00001v2", "hello");
    expect(cache.get("2101.00001v2")).toBe("hello");
    expect(cache.get("2101.00001")).toBeNull();
    expect(existsSync(join(base, "fulltext", `${arxivCacheKey("2101.00001v2")}.txt`))).toBe(true);
  });
});

describe("fetchFulltext", () => {
  function stubFetch(responses: Record<string, { status: number; body: string }>) {
    return async (url: string): Promise<Response> => {
      for (const [fragment, r] of Object.entries(responses)) {
        if (url.includes(fragment)) return new Response(r.body, { status: r.status });
      }
      return new Response("nope", { status: 404 });
    };
  }

  it("downloads from arxiv.org/html, caches, and reports cached:true on re-read", async () => {
    const cache = new FulltextCache(base);
    const fetchImpl = stubFetch({ "https://arxiv.org/html": { status: 200, body: HTML } });
    const first = await fetchFulltext("2301.00001", cache, fetchImpl, new RateLimiter(0));
    expect(first.cached).toBe(false);
    expect(first.text).toContain("2 Method");
    const second = await fetchFulltext("2301.00001", cache, fetchImpl);
    expect(second.cached).toBe(true);
    expect(readFileSync(join(base, "fulltext", "2301.00001.txt"), "utf8")).toContain("2 Method");
  });

  it("falls back to ar5iv when arxiv html is 404", async () => {
    const cache = new FulltextCache(base);
    const fetchImpl = stubFetch({
      "https://arxiv.org/html": { status: 404, body: "" },
      "ar5iv.labs": { status: 200, body: HTML },
    });
    const result = await fetchFulltext("2101.00001", cache, fetchImpl, new RateLimiter(0));
    expect(result.source).toBe("ar5iv");
  });

  it("raises FulltextUnavailableError listing attempted sources", async () => {
    const cache = new FulltextCache(base);
    const fetchImpl = stubFetch({ "https://arxiv.org/": { status: 404, body: "" }, "ar5iv": { status: 404, body: "" } });
    await expect(fetchFulltext("1999.99999", cache, fetchImpl, new RateLimiter(0))).rejects.toBeInstanceOf(
      FulltextUnavailableError,
    );
  });

  it("rejects tiny or non-paper responses even with 200", async () => {
    const cache = new FulltextCache(base);
    const fetchImpl = stubFetch({ "https://arxiv.org/": { status: 200, body: "<html><body>hi</body></html>" } });
    await expect(fetchFulltext("2301.00002", cache, fetchImpl, new RateLimiter(0))).rejects.toBeInstanceOf(
      FulltextUnavailableError,
    );
  });
});
