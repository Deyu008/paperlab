/**
 * Citation audit: every \cite key in the paper must exist in references.bib
 * (cited-but-missing = error), and the bibliography may not contain keys that
 * were fabricated into the .tex by the writer.
 */

export function extractCiteKeys(tex: string): string[] {
  const keys = new Set<string>();
  // \cite, \citep, \citet, \autocite, \parencite, \textcite — with 0-2 optional []
  const re = /\\(?:cite|citep|citet|autocite|parencite|textcite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g;
  for (const match of tex.matchAll(re)) {
    for (const key of (match[1] ?? "").split(",")) {
      const k = key.trim();
      if (k) keys.add(k);
    }
  }
  return [...keys];
}

export function extractBibKeys(bib: string): string[] {
  const keys: string[] = [];
  const re = /@\w+\s*\{\s*([^,\s]+)\s*,/g;
  for (const match of bib.matchAll(re)) {
    keys.push(match[1]!);
  }
  return keys;
}

export interface CitationAudit {
  /** Cited in the .tex but missing from the .bib — build-breaking. */
  missing: string[];
  /** Present in the .bib but never cited — dead weight, informational. */
  uncited: string[];
}

export function auditCitations(tex: string, bib: string): CitationAudit {
  const cited = extractCiteKeys(tex);
  const defined = new Set(extractBibKeys(bib));
  return {
    missing: cited.filter((k) => !defined.has(k)),
    uncited: [...defined].filter((k) => !cited.includes(k)),
  };
}
