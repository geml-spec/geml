# geml-parser-rs

*English | [中文](README_CN.md)*

A second, independent GEML 1.0 parser in Rust, compiled to WebAssembly. It was
written from [the specification](../spec/GEML-spec.md) and
[its conformance suite](../geml-parser/test/conformance/) alone: no code of the
reference parser was read. Markdown reading is the exception — the
specification does not define it, so it follows the reference implementation's
rules. Its purpose is the one §8.4 gives a second
implementation — to show that the specification, not one program, decides what
a document means.

**Status: conforms.** All 453 parse cases pass, with every capability the
suite's manifest names declared (`tables`, `views`, `ids`, `addresses`,
`blocks`, `diagnostics`, `bytes`, `yaml`, `host`, `edits`, `markdown`), so no
case is skipped. The suite runs twice:

- natively, through this crate's harness (`tests/conformance.rs`);
- as WebAssembly, through the suite's own `_runner.mjs` and `_project.mjs`, so
  the model the module returns is read by the suite's projection rather than by
  code of this crate (`wasm/conformance.mjs`).

It recognizes all six vocabularies under [`spec/profiles/`](../spec/profiles/)
and runs each one's checks (see *Vocabularies* below). Every profile
conformance file passes in both of its readings, declared and undeclared,
natively (`tests/profiles.rs`) and as WebAssembly (`wasm/profiles.mjs`).

The eleven editing operations of §8.2(10) pass all 343 of the suite's
`edits-*.json` cases — the 53 of `edits-markdown.json`, which need the
optional `markdown` capability, among them — natively (`tests/edits.rs`) and
as WebAssembly through the suite's own `_edits.mjs` (`wasm/edits.mjs`).

## Build and test

```bash
cargo test
```

```bash
cargo llvm-cov --fail-under-lines 95 --fail-under-regions 95 --fail-under-functions 95
```

```bash
wasm-pack build --target nodejs --out-dir wasm/pkg --release -- --features wasm
```

```bash
node wasm/conformance.mjs
```

```bash
node wasm/profiles.mjs
```

```bash
node wasm/edits.mjs
```

The coverage gate holds lines, regions and functions at 95% or more; branch
coverage needs a nightly compiler and is not measured. CI runs all six in the
`parser-rs` job.

`examples/geml-rs.rs` is a small command line over the crate that reads from a
directory: `check`, `style`, `history` and `codemap`.

```bash
cargo run --release --example geml-rs -- check <root> <file.geml>
```

## API

Rust:

```rust
let doc = geml::parse("# Title {#t}\n\nSee [[#t]].\n");
geml::project(&doc);      // the conformance projection
geml::blocks_of(&doc);    // the conformance block tree
geml::to_json(&doc);      // the document model as JSON
doc.diagnostics;          // code, severity, line, message
doc.ids;                  // block ids, declared and derived
doc.addresses;            // what a listing gives (§4)
```

A document that refers outside itself is parsed with a name and a host. The
host reads a file's text — another document, a table's data file, a code or
data route — and reports a file's SHA-256; `host::MapHost` holds both in
memory, and the host enforces §9.4's confinement, since only it knows the file
system:

```rust
let host = geml::host::MapHost::from_json(r#"{"files": {"lib.geml": "…"}}"#)?;
let opts = geml::Options { name: "docs/a.geml".into(), host: Some(&host), ..Default::default() };
let doc = geml::parse_with(text, &opts);
doc.profiles;             // the declared vocabularies this processor recognized
doc.profile_diagnostics;  // what their checks report: code, level, address
```

WebAssembly (`wasm/pkg`): `parse(text)` and `parseBytes(bytes)` return the
model as JSON, with `children`, `diagnostics`, `meta`, `ids`, `addresses`,
`profiles` and `profileDiagnostics`; `decode`, `project`, `blocksOf`,
`addresses` and `version` are the rest of the core. A host is passed as JSON,
`{"files": {path: text}, "hashes": {path: sha256}, "complete": bool}`, every
member optional: `files` holds text files, whose hashes are computed from their
bytes; `hashes` holds the files given by hash alone (images, video, audio); and
`complete` says the host holds every file, so a path it lacks is missing:

| function | returns |
|---|---|
| `parseIn(name, text, host)` | the model, references resolved and checks run through the host |
| `styleCheck(host, sheet, corpus, registries)` | the `geml-style/v1` view model; `corpus` is a JSON array of paths |
| `historyVerify(sidecar, live?)` | `{errors, warnings, verified}` for a `.gemlhistory` |
| `historyReconstruct(sidecar, revision)` | one revision's content, checked against its hash |
| `codemapVerify(name, host)` | `{ok, dangling, unchecked, problems}` |

`edit(case)` runs one editing operation of §8.2(10), given as an
`edits-*.json` case — `{geml, file?, files?, history?, op}` — and returns its
outcome as JSON: `{text}`, `{output}`, `{rows}`, `{hits}`, `{diagnostics}`,
`{unchanged: true}`, `{refused, message, diagnostics}`, or `{unsupported}`
for what the crate does not do yet. In Rust, `geml::edit::run_json` is the same
call, and `geml::edit::run` takes a parsed `Case` and returns the outcome or
the refusal.

## What it implements

- §0 normalization; §2 paragraphs and lists; §3 typed blocks, fences, labeled
  closes, the ``` shield, line folding; §3.2 `json`, `jsonl` and the `yaml`
  subset under I-JSON's limits; §4 attributes, NFD names, heading ids, prose
  addresses, merged `meta`, interpolation; §5 inline atoms and emphasis by
  delimiter-run flanking, references and coordinates; §6 tables; §6.1 views,
  with the full `compute`/`where`/`by`/`order`/`limit`/`select`/`summary`
  pipeline and its display formats; §9.2 nesting bounds; §9.5 the scheme rule.
- §5.2 and §9.3 across documents, through the host: a reference, an inline
  projection, an `embed`, a view's or a chart's source and a `data` schema in
  another GEML document resolve one level deep, the target parsed for its ids
  and units and its own references left alone.
- The files a document names, through the host. A `code` route (§3.3) is read
  and its range checked against the file — a drifted range is
  `bad-source-range`, an unreadable file `unresolvable-code-source`. A `data`
  route (§3.2) is read, narrowed to its range and parsed into the block's
  value, the extension naming the format unless `format=` is written. A
  table's, a view's or a chart's local data file (§6, §6.1, §7.1) is read at
  build time and its columns checked then, whatever its suffix: a table's is
  read under its `format=`, a view's or a chart's is `tsv` by suffix and `csv`
  otherwise, and a chart's `.json`/`.jsonl` record source has its records and
  columns validated. A route resolves
  document-relative, then against the host's root (§3.3's `--root`); an
  `http(s)` source is the renderer's and is never read: the block has no model
  at build time, and a view, a chart or a coordinate reading it defers with it.
- §9.3's transclusion chains: every `embed` and every inline projection that
  may stand in a sentence is followed, through the host into other documents,
  and a chain that returns to a document already being expanded is
  `transclusion-cycle`. Nothing is expanded into the model.
- Appendix A's codes for everything above, with the catalogue's severities,
  checked by `tests/behaviour.rs`. `tests/robustness.rs` parses every prefix
  of every case and a set of hostile inputs (a 20 000-deep label, 100 000
  stars, a 5 000-key attribute object, …).
- §8.2(10)'s editing operations on a GEML document's text — `list`, `find`,
  `get`, `check`, `to` (`geml`, `md` and `json`), `replace`, `set`, `add`,
  `delete`, `rename`, `revert` — with §4's addresses, GEP 0011's coordinates
  read and written, and Appendix A.6's refusal codes. A write changes only the
  lines of the unit it names and is parsed before it is returned. A `.md`
  document is read and edited as Markdown (the suite README's *Markdown
  documents*); `to` reads Markdown and this crate's model JSON, and does not
  write HTML.

## Vocabularies

A document is read under the vocabularies its own `meta` declares (§8.6). A
recognized one admits its block types, attribute keys and `meta` keys, and
gives each type its body mode — flow, raw, or GEP-0013's prose, which holds
paragraphs and nothing else. A key in a recognized vocabulary's namespace that
it does not define is `unknown-meta-key`; a name this processor does not ship
is `unrecognized-vocabulary`. `Options::recognize = false` reads every document
as a processor that recognizes none.

Each vocabulary's checks report by address (`doc.geml#id`, or the document and
a line for an anonymous block), in the profile's three levels — error, warning
and info:

| vocabulary | what is checked |
|---|---|
| `geml-form/v1` | GEP-0008's family diagnostics: a family block outside its form, a field without `name=` or sharing one with another field of its form, a field with a body, an unknown field type, `options=` and `#note` attributes naming the wrong block, a `form-options` or `form-note` no field uses; a coordinate on a `form` or a `form-group` names a field by its name (`#signup["email"]`), and a reference to it says the field's label |
| `geml-media/v1` | every code in the profile's §8 table, 36 of them: timelines and their track tables, cuts and the kind of source each track takes, intrinsic durations, assets against their files' SHA-256 through the host, lines and speakers, comps and layers, interactions resolved by geometry (crop, scale, mirror, offset), and the generation log's lineage across documents — stale generations, stale cuts, records with no provenance |
| `geml-style/v1` | `check::style::check` solves a stylesheet against a corpus into the §10 view model: selectors, arbitration by condition sets within a layer, the three layers of a style entry, `when=` variants, the box/params split, tokens, embeds, the documents a corpus's `embed`s bring in, states, screens and frames with the rules that dress them, and the frame graph, with every code in the profile's §8 table, 21 of them; `geml check` on a stylesheet runs the checks that need no corpus |
| `geml-history/v1` | `check::history` reads a sidecar, verifies every revision on the parent chain against its recorded hash in one walk, reconstructs any revision, and warns when the live file differs from the current one |
| `geml-codemap/v1` | `check::codemap::verify` resolves every cell of the edge tables and every `entry`, across documents through the host, and reports what dangles |
| `geml-translator/v1` | its attribute and `meta` keys; the profile defines no checks |

The repository's own data agrees: the specification's history sidecar verifies
every revision it holds (`tests/history.rs`), and the site's style demo solves to the
same view model as the reference parser's.

## What it does not

- **Nothing outside the document without a host.** A cross-document reference
  is then `unchecked-cross-document-reference`, and no file is read.
- **No renderer** (§8.3 makes one optional).
- **No `toml` or `edn` engine.** A `data` block in either keeps its body raw
  with `data-format-no-engine`, as §3.2 lets a processor do.
