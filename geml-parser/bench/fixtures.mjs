// P0 #3 generation fixtures. Each describes WHAT document to produce (content and
// which constructs), deliberately NOT how to write them correctly — the "how" is
// what the skill teaches, so the zero-shot vs. skill delta is meaningful.
//
// `expect` lists substrings the output must contain to count as having actually
// used the requested GEML construct (a model can't "pass" by avoiding it).
// `stresses` notes which rules / footguns the fixture probes.
export const FIXTURES = [
  {
    id: "fy-table",
    stresses: ["meta", "table", "compute/summary formula DSL"],
    expect: ["=== table", "compute=", "summary="],
    prompt:
      "a document with a title (as document metadata), a heading, and a table of four products with quarterly sales (Q1–Q4). Add a full-year-total column and a totals row that sums each quarter. The totals must be COMPUTED by the table itself, not hand-typed numbers.",
  },
  {
    id: "chart-bound",
    stresses: ["table id", "geml-chart data=#id", "single source of truth"],
    expect: ["=== table", "format=geml-chart", "data=#"],
    prompt:
      "a document with a table of revenue by region, and a bar chart of that table's data. The chart must read its data FROM the table (single source of truth), not restate the numbers.",
  },
  {
    id: "nested-structure",
    stresses: ["list nesting", "note callout", "code block"],
    expect: ["=== code", "=== note"],
    prompt:
      "a document with a section heading, a bulleted list nested three levels deep, a callout note, and a Python code block.",
  },
  {
    id: "diagram-math",
    stresses: ["diagram fence", "math fence", "captions"],
    expect: ["format=mermaid", "=== math"],
    prompt:
      "a document with a Mermaid flowchart and a block of display math (a summation formula). Give each a caption.",
  },
  {
    id: "cross-refs",
    stresses: ["reference resolution", "footnote target"],
    expect: ["[[#", "[^"],
    prompt:
      "a document with two sections; in the second, reference the first section and add a footnote. Every reference and footnote must resolve to something in the document.",
  },
  {
    id: "nested-fences",
    stresses: ["fence-length nesting (footgun)"],
    expect: ["===="],
    prompt:
      "a document containing a callout note whose body shows a GEML code example — i.e. a fenced code block displayed inside the note block.",
  },
];
