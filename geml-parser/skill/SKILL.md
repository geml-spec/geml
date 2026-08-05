---
name: geml
description: >-
  Read, author, edit, or validate GEML — the General Expressive Markup Language
  (.geml files) and its .gemlhistory versioning sidecar. Use whenever creating
  or modifying a .geml/.gemlhistory file, converting Markdown to GEML, or when
  the user mentions GEML, typed blocks, === fences, or geml-chart. Ensures the
  output parses cleanly (zero error diagnostics) against the reference parser.
---

# Writing and reading GEML correctly

GEML expresses **every** kind of structured content — code, tables, diagrams,
math, callouts, metadata — through **one** primitive: the **typed block**
(`=== <type> {#id .class key=val}` … `===`). Always finish by **validating**: a
GEML file is correct only when `geml check` reports **no error diagnostics**
(exit 0).

## Golden rules (the things that are easy to get wrong)

1. **Fences are runs of `=` (≥3).** A block closes at a `=` run of **exactly
   the opening length**, or — when the block has an `#id` — at the labeled
   fence `=== #id` (any `=` run ≥3 followed by the id; no length counting).
2. **Nest with longer fences.** A body containing `===` lines needs a
   **longer** outer fence: `====` wraps `===`. Careful: a same-length bare
   `===` in the body closes the block even if you intend a labeled close —
   the labeled close only spares you length-counting, it does NOT protect
   same-length inner fences.
3. **Headings are ATX `#` only** (`#`…`######`). No setext underlines, no
   `---` breaks, no YAML frontmatter — metadata is a `=== meta` block, and the
   document TITLE lives there (`title = "…"`), not in an H1. A heading may
   carry a stable explicit id: `## Title {#sec}`.
4. **Every `#id` is unique per document**, and **every reference must
   resolve** — `[t](#id)`, `[[#id]]`, `[^id]`, `src=`, `data=`,
   `other.geml#id`. An unresolved reference is a build **error**.
5. **No raw HTML.** Notes → `=== note`, comments → `%%` lines, hidden content
   → `{hidden}`, addressable prose → `=== text`, verified data → `=== data`
   (json/jsonl; `code` shows text, `data` IS data).

## Validate every time

```sh
geml check file.geml          # diagnostics + exit code only; exit 0 = correct
geml check --json file.geml   # machine-readable diagnostics array
```

If `geml` is not on PATH: `npm i -g @geml/geml` (package `@geml/geml`, command
`geml`), or run without installing via `npx -y @geml/geml check file.geml`.
Inside the geml-spec repo prefer the local build:
`node geml-parser/dist/geml.js <args>`. If no parser is reachable, follow the
golden rules and validate once it is.

## Work blockwise (agent editing)

```sh
geml get     file.geml '#id'          # read ONE block (a heading id = its whole section)
geml set     file.geml '#id' --in f   # replace ONE block (re-parsed; never writes a broken doc)
geml history save file.geml -m "…"    # snapshot to .gemlhistory after each meaningful edit
geml revert  file.geml '#id'          # roll ONE block back (--rev -2 | changed | <rev-id>)
```

## Full reference — pull ONE section, not the whole file

`references/authoring.geml` (under this skill's base directory) holds the
detailed reference. Fetch just the section you need:

```sh
geml get <skill-base>/references/authoring.geml '#tables'
```

| section | covers |
|---|---|
| `#typed-block` | block anatomy, attribute object, examples of every registered type |
| `#tables` | pipe/CSV bodies, `compute=`, `summary=`, printf display, `span=` merges |
| `#charts` | `geml-chart` diagrams bound to a table via `data=#id` |
| `#data` | the `data` block — value tree, `json`/`jsonl` formats, blind append, chart binding |
| `#inline` | inline markup, links/refs/footnotes, task lists, media embeds |
| `#hidden` | `%%` comments, `{hidden}`, `{{key}}` interpolation, `=== embed` |
| `#cli` | every CLI verb — get/set/add/delete/rename, `--to` conversion, check |
| `#editing` | the blockwise editing loop + `.gemlhistory` versioning |
| `#project-config` | carrying a project's Claude config docs in GEML, quietly |
| `#checklist` | full pre-flight authoring checklist |
