# codemap profile v1 — vocabulary & conventions

*English | [中文](codemap-profile_CN.md)*

- Status: finalized alongside `DESIGN-codemap-delta.md` (2026-07-03)
- Nature: **an application-layer profile, not part of the GEML standard.** The
  GEML standard stays untouched; this document defines the block types,
  attributes, meta keys, table schemas, and verification rules that codemap
  output uses — the way schema.org relates to HTML. The generator and verifier
  ship with the `@geml/geml` package: `geml codemap build` /
  `geml codemap verify` (source: `geml-parser/codemap/`).

## 1. File layout

```
.geml-code-graph/          %% default output directory (older codemap/, graph/ dirs: regenerate once to replace)
  index.geml                 the entry point: repo metadata + module aggregate table
  <container>.geml           one per container (module|dir|file granularity, --container)
  _index/name-lookup.json    name → {anchor, doc, id} (F4)
  _build/                    raw indexer output + symbols/edges.jsonl (intermediates; regenerable / gitignore-able; agents don't read them)
```

Container document name = the container's **display path**, sanitized (see §2
`module`; `/`→`--`, anything outside `[A-Za-z0-9_.-]`→`-`); collisions append `-2`.

**Build scope**: by default, build skips source files ignored by `.gitignore`
(vendored copies and build artifacts stay out of the graph); `--exclude <glob>`
(repeatable) drops paths that are still git-tracked; `--no-gitignore` turns the
git-side filtering off. Edges of excluded symbols disappear with them — no
dangling references are left behind.

## 2. Document rules

- **Exactly one `meta` block per document**, keys:
  | key | present on | meaning |
  |---|---|---|
  | `module` | container docs | the container's **display path**: the real directory with the ceremony stripped. Module root = the directory holding the build manifest (pom.xml/package.json/tsconfig.json/go.mod/Cargo.toml, …); first strip the build source root (`src/main\|test/<lang>`, bare `src`), then strip the longest common segment prefix shared within the module: `magic-api/src/main/java/org/ssssssss/magicapi/core/config` → `magic-api/core/config`. Test code (`src/test/*`, top-level `test`/`tests`/`__tests__`/`spec`) folds into a top-level `test/` branch; a single-module repo uses the repo name as the module segment; file granularity normalizes the same way but keeps the file name (no whole-segment folding). Affects display and document naming only |
  | `src` | container docs | the **real** relative path of the source dir/file (not normalized — used to locate source) |
  | `entry` | when entries exist | space-separated reference list: methods **called from outside the container**, or app entry points (main); **checked by verify** |
  | `resolution-default` | all | `cpg` / `heuristic` (the default resolution source for this document's edges) |
  | `repo` / `commit` / `container` | index | repo name / git short hash / container granularity |
  | `graph-depth` | optional | render-depth override (renderer default: 6) |
  | `consts` | reserved | module-level constant roster (enabled once the extractor provides it) |
- Heading `# <container name>`; when a container spans several source files,
  one `## <file name>` section per file (containment = document structure).

## 3. Method blocks

```geml
=== code {#hashtableFind src=hashtable.c#L1606-1616 anchor="c:hashtable.c#hashtableFind(bool(hashtable*,void*,void**))"}
===
```

- **Empty body**; `src=` is an ordinary attribute (`path[#Lstart-end]`) — an
  agent reads it and opens the source itself; a renderer MAY use it to display
  source (that belongs to the `geml-code-graph` format, phase B).
- `anchor=` = the engine-level stable identity (`language:file#name(signature)`).
- `name=` (optional) = display name, written only when id sanitization changed
  it (e.g. `RenderCtx.block` → id `RenderCtx-block`); renderers use it for node
  labels, references still go by id.
- **id rules**: the method's short name (sanitized into a legal id); same-name
  collisions within a document → every member appends
  `-<first 6 hex chars of sha256(anchor)>`; if the first 6 still collide within
  that group, the whole group escalates to 8, 10, … chars (on demand — no
  global lengthening). A rename = a new id = dangling references = a verify
  error (a feature, not a defect).
- Symbol-level classes: `.leaf` (zero out-edges **including unresolved**, and
  is called), `.accessor` (bean-style get/set/is leaves — hidden by renderers
  by default, with a visible count and a toggle; table data unaffected),
  `.test` (test-territory path convention), `.flow-entry` (engine-provided key
  execution-flow entry, optional).
- **`entry` never sits on a block** — it is a module-level fact and appears
  only in meta (§2).

## 4. Edge tables (at most three per container; empty tables are not emitted)

| table id | columns | notes |
|---|---|---|
| `#calls` | `from, to, kind, confidence` | out-edges. kind ∈ `call` / `candidate` (virtual-dispatch / multi-implementation candidates, each right after its main `call` row, inheriting its confidence); empty confidence = high |
| `#called-by` | `from, to, kind, site` | in-edges (aggregated across the whole graph by the generator). site = `file:line`, plain text |
| `#unresolved` | `from, to` | the blind spots (hidden). `to` = the unresolved target verbatim, **plain text, unchecked** |
| `#ref-by` | `from, to, kind, member` | **reserved** (the reverse of reads/writes; member is a plain-text field name; enabling it is a separate decision) |

- **Reference syntax** (from/to columns, meta `entry` values): `#id` (this
  document) or `doc.geml#id` (relative-path sibling document); the reserved
  reads values may carry a plain-text `.member` suffix (the id charset excludes
  `.`, so it splits mechanically).
- Plain-text cells (site, unresolved `to`) must not contain commas or newlines
  (the generator replaces them with spaces), and square brackets are replaced
  with parentheses — **table cells are inline-parsed**, so `f[i](&x)` would be
  misread as a link.

## 5. Verification (division of labour)

- `geml check` (the standard): document structure, id uniqueness, native
  references. **CSV cells and meta values are opaque to the standard — by
  design; the standard grows no codemap-shaped holes.**
- `verify.mjs` (the profile): parses `#calls`/`#called-by`/`#ref-by` from/to
  cell by cell, plus meta `entry` values; dangling = build failure (exit 1).
  Run it after every build; red = the graph is stale or partially updated —
  rebuild before trusting navigation.

## 6. Rendering (phase B; the only GEP: the `geml-code-graph` diagram format)

- **Scenario ① (inside a codemap)**: generated documents are pure data — **no
  diagram blocks**. A renderer that recognizes a codemap document (meta
  contains `module =` / `container =`) SHOULD offer a layered method-flow view:
  roots = the document's meta `entry`, depth = `graph-depth` or the default;
  `.leaf` dimmed, `.test` filterable; back edges dashed, self-recursion badged.
- **Scenario ② (embedding the graph in any document)**:
  `=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml}` —
  **the only attribute is `src=`**; roots/depth always come from the meta of
  the document `src` points at (view configuration travels with the data).
  Drill-down is interaction, not an authoring attribute.

## 7. Versioning

`build.mjs --history [-m msg]`: changed documents are committed into their own
`.gemlhistory`; `geml history log` shows how the graph evolved, and
`geml revert doc '#method' --rev -1` rolls a single method back.

## 8. Consumption cheat-sheet (agents)

```sh
node -e "console.log(JSON.stringify(require('./.geml-code-graph/_index/name-lookup.json')['hashtableFind']))"
geml get .geml-code-graph/hashtable.c.geml '#hashtableFind'     # method block (src= is one hop to source)
geml get .geml-code-graph/hashtable.c.geml '#calls'             # out-edges; follow doc.geml#id refs onward
geml get .geml-code-graph/hashtable.c.geml '#called-by'         # who calls me (with site)
head -8 .geml-code-graph/hashtable.c.geml                       # meta: the entry surface at a glance
```

Trust semantics: `resolution-default` says where the edges came from (`cpg`
precise / `heuristic` syntax-level); the confidence column and candidate rows
are where the resolver refuses to guess for you; `#unresolved` is a blind
spot, not an absence; under heuristic, "no `#called-by` rows" ≠ "no callers".
