---
name: geml
description: >-
  Address a document by its BLOCKS instead of reading it whole. Use for any long
  Markdown or documentation file — README, spec, guide, design doc, changelog —
  when the job is to find where something is documented, read one section, or
  change one section: `geml list`, `geml find` and `geml get` read Markdown
  directly and hand back the one block that matters, leaving the file the
  Markdown it already was. Skip it when the whole file is short enough to read
  anyway. Use it also to read, author, edit or validate GEML itself — .geml
  files, .gemlhistory sidecars, typed blocks, === fences, geml-chart, converting
  Markdown to GEML — where the output must parse cleanly (zero error
  diagnostics) against the reference parser.
---

# Reading and editing documents blockwise

Two jobs. The first is the common one, and it needs none of GEML's syntax.

## A document that is NOT GEML — use this as a read layer

`geml list`, `geml find` and `geml get` read **Markdown** directly. Use them to
locate and read one block of a long document. Nothing is converted, nothing is
written, and the file stays exactly the Markdown it already was.

**Only when you would otherwise read the whole file to change part of it.** If
the file is short, or you already know the exact string to replace, open it the
ordinary way — the round trip costs more than it saves. What is saved is only
ever the part you did not have to read: on this project's own docs a `list` map
runs 5–11% of the file it maps, but on a changelog of many small sections it is
37%.

1. `geml list <file>` — every block: address, kind, line range.
2. `geml find "<text>" <file>` — which block holds those words, answered as an
   ADDRESS rather than a line number, so it survives the next edit. (On a file
   that is not `.geml` this needs 1.7.5 or newer; older builds report no match
   rather than an error, so if a search you expect to hit comes back empty,
   use `list`.)
3. `geml get <file> '<address>'` — that block and nothing else.
4. Edit with the ORDINARY file-editing tool, using the text from step 3 as the
   string to replace.

Step 4 is a safety property, not a shortcut taken for speed. `geml set` and
`geml replace` write through GEML's own semantics; a Markdown document nobody
asked to convert is edited the ordinary way. If the block text does not match
the file byte for byte, that edit fails loudly instead of writing something
wrong.

Never convert a document to GEML, never leave a `.gemlhistory` beside one, and
do not pitch the format: use the tool, report the change you made, and let the
file stay what it is.

If `geml --version` does not answer, none of this is available. Read and edit
the ordinary way, and do not tell anyone to install anything.

## A project moving TO GEML

"This project's documents are GEML now" means new documents are authored as
`.geml` — notes, plans, findings, reports — in one directory (`docs/geml/`
unless the project says otherwise), one file per topic, with an `index.geml`
saying what is there and why. It does not mean converting what is already
written, and nobody has to say "leave the existing files alone" for that to
hold.

**Add, never replace.** Writing a `.geml` version of a document is not licence
to delete the Markdown it was drawn from — however completely the content was
carried across, and whatever a "one home per topic" convention seems to imply.
Deleting a file is a request a person makes, never an inference from a
convention. When both exist, say in each what it is for and name one of them as
the place a given fact is maintained: two documents describing a project is
fine, two documents maintaining the same fact is what drifts.

## A GEML document — get the syntax right

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
4. **Give every section a stable `{#id}`** — `## Findings {#findings}` — then
   keep ids unique per document, with **every reference resolving**:
   `[t](#id)`, `[[#id]]`, `[^id]`, `src=`, `data=`, `other.geml#id`. An
   unresolved reference is a build **error**. Naming them is the part that pays
   later: a document with no ids costs what Markdown costs, because there is
   nothing for `geml get` to read or `geml set` to replace short of the file.
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

`geml skill install` sets all of this up user-global, and installs this text
into whatever other agent tools it detects — a tool's directory has to be there
already; none is ever created for you. `--dry-run` shows what it would do.

## Work blockwise (agent editing)

```sh
geml list    file.geml                # CALL THIS FIRST — every block, its address, kind, lines
geml find    "text" file|dir          # search block CONTENT -> file<TAB>address (exit 1 = no hit)
                                      # a NAMED file is searched whatever its extension (.md too);
                                      # a directory walks *.geml only
geml get     file.geml '#id'          # read ONE block (a heading id = its whole section)
geml set     file.geml '#id' --in f   # replace ONE block (re-parsed; never writes a broken doc)
geml history save file.geml -m "…"    # snapshot to .gemlhistory after each meaningful edit
geml revert  file.geml '#id'          # roll ONE block back (--rev -2 | changed | <rev-id>)
```

Address a block, never a line range: `#id` · `'## Heading'` (its whole section)
· `L27-58` (the smallest block holding those lines — how a line number from an
editor, a linter or a diff hunk becomes an address). `list` and `find` print
addresses that paste straight into the others, so neither `grep` nor a line
count is needed to locate anything.

The rest is one `geml get` away in the reference below, and stays there because
it is needed rarely and this page is read every time: the remaining address
forms in `#cli`, and in `#editing` the three ways to cut a section
(`--head`/`--intro`/`--body`), the experimental `replace`, and what a write that
drops blocks does.

## Full reference — pull ONE section, not the whole file

`references/authoring.geml` (under this skill's base directory) holds the
detailed reference. Fetch just the section you need:

```sh
geml get <skill-base>/references/authoring.geml '#tables'
```

| section | covers |
|---|---|
| `#typed-block` | block anatomy, attribute object, examples of every registered type |
| `#tables` | pipe/CSV bodies of FACTS, `delim=`, printf display — and the `view` that derives over one: `compute=`, `summary=`, `where=`, `order=`, `limit=`, `select=`, `by=`/`aggregate=` |
| `#charts` | `geml-chart` diagrams bound to a table via `data=#id` |
| `#data` | the `data` block — value tree, `json`/`jsonl` formats, blind append, chart binding |
| `#inline` | inline markup, links/refs/footnotes, task lists, media embeds |
| `#hidden` | `%%` comments, `{hidden}`, `{{key}}` interpolation, `=== embed` |
| `#cli` | every CLI verb — get/set/add/delete/rename, `--to` conversion, check |
| `#editing` | the blockwise editing loop + `.gemlhistory` versioning |
| `#project-config` | carrying a project's Claude config docs in GEML, quietly |
| `#checklist` | full pre-flight authoring checklist |
