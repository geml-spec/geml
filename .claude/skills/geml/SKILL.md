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
geml replace file.geml OLD NEW        # EXPERIMENTAL literal swap; --within '#id' to narrow
geml history save file.geml -m "…"    # snapshot to .gemlhistory after each meaningful edit
geml revert  file.geml '#id'          # roll ONE block back (--rev -2 | changed | <rev-id>)
```

Address a block, never a line range: `#id` · `'## Heading'` (its whole section)
· `'=== type'` · `@<hex>` (no id) · `L27` or `L27-58` (the smallest block holding
those lines — how a line number from an editor, a linter or a diff hunk becomes
an address). `list` and `find` print addresses that paste straight into the
others, so neither `grep` nor a line count is needed to locate anything.

Any section can be cut three ways, on `get` and `set` alike: `--head` (the
heading line), `--intro` (what it says before its first subheading — empty when
one follows immediately, the whole body when none does), `--body` (everything
under it, so it always contains the intro). `--intro` is how you edit a
section's opening without pulling its subsections into context, and setting an
empty one writes an opening where the section had none.

When the exact old text is already known and nothing needs reading — a version
string in six places, a renamed term — `geml replace` is the cheap path, and the
one to prefer over dropping to `sed`: same two short strings, but the result is
re-parsed before it lands, the blocks it touched are named back to you, and it
is in `.gemlhistory` to revert. It swaps a LITERAL, never a pattern, and refuses
a swap that would rename an id (use `geml rename`, which fixes the references
too). **It is EXPERIMENTAL and may be withdrawn** — reach for it, but do not
build anything on it that cannot change.

A write is refused when it would break the document, never merely because it
removes something: a replacement that drops blocks is carried out and NAMED on
stderr — unnamed blocks included — with `geml revert` as the way back. Read,
edit, write back, and nothing is dropped, because `get` handed those blocks to
you. Send content that omits them only when removing them is the point.

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
