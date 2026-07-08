# GEML vs. other markup formats

*English | [中文](COMPARISON_CN.md)*

How GEML compares to **Markdown** (GitHub-flavored), **HTML**, **CommonMark**
(strict core), **AsciiDoc**, **Org-mode**, and **Pandoc Markdown**.

Note on Pandoc: it is really a *converter* plus its own **Pandoc Markdown** —
the most feature-complete Markdown dialect. Its attribute syntax
`{#id .class key=val}` is in fact the ancestor of GEML's. Pandoc's own
super-powers — multi-format conversion and programmable **Lua filters** — sit on
a different axis than the per-element comparison below.

GEML is not the widest format here — AsciiDoc, in particular, ships more
built-in elements out of the box. GEML's case rests on three things no other
format here offers together:

1. **One primitive for every structured block** — lowest syntax surface to learn,
   parse, or *generate* (which is why it's friendly to AI).
2. **Build-time reference checking** — a broken cross-reference is an error, not a
   silent dead link.
3. **Self-contained version history** (`.gemlhistory`) — without git or any
   online service.

Legend: ✓ native · ◐ via extension/convention · ✗ none · *(H)* needs raw HTML.

## Capability matrix

| Element / capability | GEML | Markdown (GFM) | HTML | CommonMark | AsciiDoc | Org-mode | Pandoc Markdown |
|---|---|---|---|---|---|---|---|
| Headings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bold / italic | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Inline code | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Code block (with language) | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| Lists | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Links / images | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audio / video embed | ✓ | ✗ *(H)* | ✓ | ✗ | ✓ | ◐ | ✗ *(H)* |
| Tables | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ |
| Data / computed-column tables | ✓ | ✗ | ✗ | ✗ | ◐ csv | ◐ formulas | ✗ |
| Admonitions / callouts | ✓ | ◐ alerts | ◐ | ✗ | ✓ | ◐ | ◐ fenced div |
| Footnotes | ✓ | ✓ | ◐ | ✗ | ✓ | ✓ | ✓ |
| Definition lists | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ |
| Super/subscript, inline spans | ✗ | ✗ | ✓ | ✗ | ✓ | ◐ | ✓ |
| Math (inline / block) | ✓ | ◐ | ◐ | ✗ | ✓ | ✓ | ✓ |
| Diagrams (hosted DSL) | ✓ | ◐ mermaid | ✗ | ✗ | ✓ | ✓ | ◐ filter |
| Chart bound to a data table | ✓ | ✗ | ✗ | ✗ | ◐ | ◐ | ✗ |
| Citations / bibliography | ✗ | ✗ | ✗ | ✗ | ◐ | ✓ | ✓ |
| Document metadata | ✓ native block | ◐ frontmatter | ✓ | ✗ | ✓ | ✓ | ✓ |
| Block id + cross-reference | ✓ | ◐ headings only | ✓ | ◐ | ✓ | ✓ | ✓ |
| **Build-time reference checking** | ✓ error | ✗ | ✗ | ✗ | ✓ warns | ◐ | ✗ |
| Raw-HTML escape hatch | ✗ *(by design)* | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Plain-text legible (no rendering) | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Programmable filters / macros | ✗ *(by design)* | ✗ | ✗ | ✗ | ◐ | ✓ | ✓ Lua |
| **One primitive for all blocks** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Self-contained version history** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

The three bold rows are GEML's real differentiators. "Raw HTML = ✗" is a feature,
not a gap: it keeps semantics portable and tied to no backend. Pandoc Markdown is
the broadest column here — it adds citations, definition lists, and Lua filters —
yet it still lacks the one primitive, build-time checking, and self-contained
history.

## Side-by-side syntax

### Code block

```
GEML        === code {#hello lang=python}
            print("hi")
            ===
Markdown    ```python
            print("hi")
            ```
HTML        <pre><code class="language-python">print("hi")</code></pre>
CommonMark  ```python
            print("hi")
            ```
AsciiDoc    [source,python]
            ----
            print("hi")
            ----
Org-mode    #+begin_src python
            print("hi")
            #+end_src
Pandoc      ```{.python}
            print("hi")
            ```
```

### Document metadata

```
GEML        === meta
            title = "Budget plan"
            ===
Markdown    ---                 (YAML frontmatter — convention, not spec)
            title: Budget plan
            ---
HTML        <meta name="title" content="Budget plan">
CommonMark  (no mechanism)
AsciiDoc    = Budget plan
            :version: 0.1
Org-mode    #+TITLE: Budget plan
Pandoc      ---                 (YAML metadata block — first-class)
            title: Budget plan
            ---
```

### Admonition / callout

```
GEML        === note {#risks}
            Vendor lock-in is the main risk.
            ===
Markdown    > [!NOTE]            (GitHub extension)
            > Vendor lock-in is the main risk.
HTML        <div class="note">Vendor lock-in is the main risk.</div>
CommonMark  (no mechanism — plain blockquote only)
AsciiDoc    [NOTE]
            ====
            Vendor lock-in is the main risk.
            ====
Org-mode    (no standard — special block, export-dependent)
Pandoc      ::: {.note}
            Vendor lock-in is the main risk.
            :::
```

### Cross-reference, and whether it is checked

```
GEML        See [[#budget]]          → #budget missing ⇒ build ERROR
Markdown    See [budget](#budget)    → broken link passes silently
HTML        See <a href="#budget">…  → not checked
CommonMark  See [budget](#budget)    → not checked
AsciiDoc    See <<budget>>           → processor WARNS on unresolved xref
Org-mode    See [[budget]]           → partially checked on export
Pandoc      See [budget](#budget)    → not checked (xref via pandoc-crossref filter)
```

### Table with computed columns (GEML-specific)

```
GEML        === table {#fy25 format=csv header=1
              compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4"
              summary="Segment = 'Total'; FY = sum(FY)"}
            Segment, Q1, Q2, Q3, Q4
            Cloud,   1,  2,  3,  4
            ===                       → per-row FY column + a Total summary row,
                                        FY shown to 1 decimal
Org-mode    | Segment | Q1 | Q2 | Q3 | Q4 | FY |
            |---------+----+----+----+----+----|
            #+TBLFM: $6=$2+$3+$4+$5    (the inspiration — but a full spreadsheet:
                                        cell refs, remote(), Emacs Lisp. GEML
                                        keeps a restricted column-formula subset)
others      static tables only — no computation
```

### Diagram (hosting an external DSL)

```
GEML        === diagram {#flow format=mermaid}
            graph LR
              A --> B
            ===
Markdown    ```mermaid             (GitHub renders it; no id/caption/check)
            graph LR
              A --> B
            ```
AsciiDoc    [mermaid]
            ----
            graph LR
              A --> B
            ----
Org-mode    #+begin_src plantuml :file out.png
            ...
            #+end_src
Pandoc      ```{.mermaid}          (rendered by a filter, e.g. mermaid-filter)
            graph LR
              A --> B
            ```
HTML/CMark  no native diagram hosting
```

### Chart bound to a table (GEML-specific)

```
GEML        === diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY}
            ===                       → renders table #fy25 as a chart; column refs checked
others      hand-copy data into a chart lib, or a spreadsheet app — no link
```

## What only GEML does

Every format above can render a heading and a code block. The difference is what
happens to a *whole document* under change and automation:

- **A single typed block** carries code, tables, diagrams, math, callouts, and
  metadata — so there is one grammar to learn and one grammar for a tool (or an
  LLM) to emit correctly, instead of a different syntax per feature plus an HTML
  fallback.
- **References are validated at build time.** An `#id` that doesn't resolve fails
  the build, instead of slipping through as a dead link the way it does in
  Markdown/HTML.
- **History is self-contained.** A sibling `.gemlhistory` file reconstructs any
  past revision and rolls the document back — offline, with no git and no online
  service. See the [history extension](GEML-history-spec.md).

Pandoc plays a different game — it is the universal *converter*, and the most
practical way to reach `docx`/`latex`/`epub`. A natural future for GEML is to
*join* that ecosystem (a Pandoc reader/writer) rather than compete with it.

See the [core specification](GEML-spec.md) for the full format, and the
[README](README.md) for a quick tour.
