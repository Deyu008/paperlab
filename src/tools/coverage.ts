/**
 * Coverage analytics for the literature phase.
 *
 * Computed by the ORCHESTRATOR from the tool audit log — never by the agent.
 * The audit log is append-only, written by the tools themselves on every
 * search/snowball/read call; this module turns it into the coverage report
 * artifact plus soft-warning list.
 */
import type { RunStore } from "../core/run-store.ts";
import { paperIdentity, type PaperRecord } from "./paper-search.ts";

export type AuditKind = "search" | "snowball" | "read_attempt" | "read_ok" | "read_failed";

export interface AuditRecord {
  ts: string;
  kind: AuditKind;
  query?: string;
  hits?: number;
  provider?: string;
  paper_ref?: string;
  direction?: string;
  arxiv_id?: string;
  error?: string;
  /** Identities returned by a snowball call (for orphan detection). */
  returned?: string[];
}

export interface CoverageReport {
  searches: { total: number; uniqueQueries: number; queries: string[] };
  snowballs: { total: number; anchors: string[] };
  reads: { attempts: number; ok: number; failed: number };
  funnel: {
    saved: number;
    byReadStatus: Record<string, number>;
    snowballContributed: number;
    orphans: string[];
  };
  warnings: string[];
}

export function computeCoverage(store: RunStore, phaseKey = "01-literature"): CoverageReport {
  const audit = store.readJsonl<AuditRecord>(phaseKey, "usage-audit.jsonl");
  const papers = store.readJsonl<PaperRecord>(phaseKey, "papers.jsonl");

  const searches = audit.filter((a) => a.kind === "search");
  const queries = searches.map((a) => a.query ?? "");
  const snowballs = audit.filter((a) => a.kind === "snowball");
  const readAttempts = audit.filter((a) => a.kind === "read_attempt");
  const readOk = audit.filter((a) => a.kind === "read_ok");
  const readFailed = audit.filter((a) => a.kind === "read_failed");

  const snowballIds = new Set<string>();
  for (const s of snowballs) {
    for (const id of s.returned ?? []) snowballIds.add(id);
  }
  const snowballContributed = papers.filter((p) => (p.found_via ?? "").startsWith("snowball"));
  const orphans = papers
    .filter((p) => !(p.found_via ?? "").startsWith("snowball"))
    .filter((p) => !snowballIds.has(paperIdentity(p)))
    .map((p) => p.title);

  const byReadStatus: Record<string, number> = { abstract: 0, full: 0 };
  for (const p of papers) byReadStatus[p.read_status] = (byReadStatus[p.read_status] ?? 0) + 1;

  const fullCount = byReadStatus["full"] ?? 0;
  const snowballCount = snowballContributed.length;
  const orphanRatio = papers.length > 0 ? orphans.length / papers.length : 0;
  const uniqueQueries = new Set(queries).size;

  const warnings: string[] = [];
  if (snowballCount < 2) {
    warnings.push(
      `only ${snowballCount} paper(s) came from citation snowballing — coverage may be keyword-shaped`,
    );
  }
  if (fullCount < 2) {
    warnings.push(
      `only ${fullCount} paper(s) read at full-text tier — the survey rests mostly on abstracts`,
    );
  } else if (readFailed.length > 0 && readOk.length === 0) {
    warnings.push("all full-text attempts failed; verify arXiv ids");
  }
  if (papers.length > 0 && orphanRatio > 0.3) {
    warnings.push(
      `${orphans.length}/${papers.length} saved papers are disconnected from every snowball anchor`,
    );
  }
  if (uniqueQueries < 5) {
    warnings.push(`only ${uniqueQueries} distinct search query — try more facets/synonyms`);
  }

  return {
    searches: { total: searches.length, uniqueQueries, queries: [...new Set(queries)] },
    snowballs: {
      total: snowballs.length,
      anchors: snowballs.map((s) => `${s.paper_ref ?? "?"}/${s.direction ?? "?"}`),
    },
    reads: { attempts: readAttempts.length, ok: readOk.length, failed: readFailed.length },
    funnel: {
      saved: papers.length,
      byReadStatus,
      snowballContributed: snowballCount,
      orphans,
    },
    warnings,
  };
}
