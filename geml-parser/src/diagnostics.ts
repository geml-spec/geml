// GEML reference parser — the diagnostic catalogue (spec Appendix A).
//
// Every diagnostic a conforming parser emits carries a STABLE `code` in
// addition to its human-readable `message`. The message is prose: it may be
// reworded, translated, or given more context between releases. The code is
// the contract — it is what a conformance test, an editor integration, or a CI
// gate matches on, and it is what the specification's Appendix A enumerates.
//
// `DiagnosticCode` below is the single source of truth: it is a closed union,
// so a misspelled or unregistered code is a compile error, and the spec's
// catalogue can be checked against this list mechanically.

export type DiagnosticCode =
  // --- Block structure (§3) ---
  | "unterminated-block"
  | "unknown-block-type"
  | "unknown-attribute"
  | "block-nesting-too-deep"
  | "list-nesting-too-deep"
  | "inline-nesting-too-deep"
  | "stray-labeled-fence"
  | "fence-like-line"
  | "unresolvable-code-source"
  | "bad-code-source"
  | "bad-source-range"
  | "code-src-and-body"
  // --- Identifiers, references and metadata (§4, §5) ---
  | "name-not-a-name"
  | "heading-attrs-trailing-text"
  | "heading-attrs-unclosed"
  | "duplicate-id"
  | "unresolved-reference"
  | "unresolved-footnote"
  | "unresolved-cross-document-reference"
  | "unresolvable-document"
  | "unchecked-cross-document-reference"
  | "embed-missing-src"
  | "ignored-embed-body"
  | "transclusion-cycle"
  | "embed-target-not-geml"
  | "media-target-is-document"
  | "inline-transclusion-not-inline"
  | "unsafe-embed-scheme"

  | "unresolvable-table-source"
  | "table-source-not-a-table"
  | "unknown-metadata-reference"
  | "duplicate-meta-key"
  // --- Tables (§6) ---
  | "table-src-and-body"
  | "unknown-table-format"
  | "bad-table-delimiter"
  | "ignored-table-delimiter"
  | "bad-compute-formula"
  | "unlexable-compute-formula"
  | "compute-error"
  | "compute-non-numeric-cell"
  | "compute-not-a-number"
  | "bad-summary-entry"
  | "summary-unknown-column"
  | "unlexable-summary-expression"
  | "summary-error"
  // --- Diagrams (§7) ---
  | "unknown-diagram-format"
  | "ignored-diagram-body"
  | "code-graph-missing-src"
  | "code-graph-unresolvable-document"
  // --- Charts (§7.1) ---
  | "chart-missing-data"
  | "chart-data-not-a-table"
  | "chart-missing-type"
  | "chart-unknown-type"
  | "chart-unknown-rows-scope"
  | "chart-missing-channel"
  | "chart-empty-channel"
  | "chart-unknown-column"
  | "chart-unused-channel"
  | "chart-missing-summary-row"
  | "chart-summary-row-unavailable"
  | "chart-non-numeric-value"
  | "chart-data-not-records"
  // --- Data blocks (GEP-0005) ---
  | "data-parse"
  | "unknown-data-format"
  | "data-format-no-engine"
  | "bad-data-schema"
  | "data-src-and-body"
  | "bad-data-source"
  | "unresolvable-data-source";

export interface Diagnostic {
  severity: "error" | "warning";
  code: DiagnosticCode;
  message: string;
  line: number; // 1-based
}

// The severity each code is emitted with. The specification fixes severity per
// code (Appendix A), so this table is normative, not advisory: a second
// implementation reporting `unknown-block-type` as an error does not conform.
export const SEVERITY: Record<DiagnosticCode, "error" | "warning"> = {
  "unterminated-block": "error",
  "unknown-block-type": "warning",
  "unknown-attribute": "warning",
  "block-nesting-too-deep": "error",
  "list-nesting-too-deep": "error",
  "inline-nesting-too-deep": "error",
  "stray-labeled-fence": "warning",
  "fence-like-line": "warning",
  "unresolvable-code-source": "warning",
  "bad-code-source": "error",
  "bad-source-range": "error",
  "code-src-and-body": "error",
  // A warning, not an error: this has always parsed, and documents rely on the
  // leniency. What the author is missing is that it parsed as something else.
  "name-not-a-name": "warning",
  // Same leniency and the same reason: the heading parsed — as something the
  // author did not write, with the id they meant to address missing.
  "heading-attrs-trailing-text": "warning",
  "heading-attrs-unclosed": "warning",
  "duplicate-id": "error",
  "unresolved-reference": "error",
  "unresolved-footnote": "error",
  "unresolved-cross-document-reference": "error",
  "unresolvable-document": "error",
  "unchecked-cross-document-reference": "warning",
  "embed-missing-src": "error",
  "ignored-embed-body": "warning",
  "transclusion-cycle": "error",
  "embed-target-not-geml": "error",
  "media-target-is-document": "error",
  "inline-transclusion-not-inline": "error",
  "unsafe-embed-scheme": "error",

  "unresolvable-table-source": "error",
  "table-source-not-a-table": "error",
  "unknown-metadata-reference": "error",
  "duplicate-meta-key": "warning",
  "table-src-and-body": "error",
  "unknown-table-format": "warning",
  "bad-table-delimiter": "error",
  "ignored-table-delimiter": "warning",
  "bad-compute-formula": "error",
  "unlexable-compute-formula": "error",
  "compute-error": "error",
  "compute-non-numeric-cell": "warning",
  "compute-not-a-number": "warning",
  "bad-summary-entry": "error",
  "summary-unknown-column": "error",
  "unlexable-summary-expression": "error",
  "summary-error": "error",
  "unknown-diagram-format": "warning",
  "ignored-diagram-body": "warning",
  "code-graph-missing-src": "warning",
  "code-graph-unresolvable-document": "warning",
  "chart-missing-data": "error",
  "chart-data-not-a-table": "error",
  "chart-missing-type": "error",
  "chart-unknown-type": "error",
  "chart-unknown-rows-scope": "error",
  "chart-missing-channel": "error",
  "chart-empty-channel": "error",
  "chart-unknown-column": "error",
  "chart-unused-channel": "warning",
  "chart-missing-summary-row": "error",
  "chart-summary-row-unavailable": "warning",
  "chart-non-numeric-value": "error",
  "chart-data-not-records": "error",
  "data-parse": "error",
  "unknown-data-format": "warning",
  "data-format-no-engine": "warning",
  "bad-data-schema": "error",
  "data-src-and-body": "error",
  "bad-data-source": "error",
  "unresolvable-data-source": "error",
};

// ---------------------------------------------------------------------------
// Source normalization (spec §0)
// ---------------------------------------------------------------------------

// A conforming parser normalizes its input before scanning:
//
//   1. a single leading BOM (U+FEFF) is removed;
//   2. every line ending (CRLF, or a lone CR) becomes LF;
//   3. U+0000 becomes U+FFFD.
//
// All three preserve the LINE COUNT, which is what lets `blockSpans` index the
// original bytes by line: normalization only ever rewrites bytes *within* a
// line, never splits or joins one. (1) only touches the first line's leading
// bytes; (3) is a same-line substitution; (2) is per-line trailing bytes, and
// splitting on the normalized LF yields exactly the lines the original had.
export function normalizeSource(source: string): string {
  const noBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return noBom.replace(/\r\n?/g, "\n").replace(/\0/g, "�");
}
