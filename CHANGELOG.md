# Changelog

All notable changes to **`@geml/geml`** (the reference parser, CLI and MCP
server). The **specification** is versioned separately and independently — it
has been `1.0` (Stable) since the first npm release; see
[`spec/GEML-spec.md`](spec/GEML-spec.md) and
[`GOVERNANCE.md`](GOVERNANCE.md#versioning).

`geml --version --json` prints both: `{"parser":"…","spec":"…"}`.

The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/); this
project follows [Semantic Versioning](https://semver.org/). Entries for `1.0.0`
through `1.7.2` were reconstructed from the release commits, so they record what
each version shipped rather than a contemporaneous editorial note.

The browser extension (`integrations/geml-viewer/`) versions on its own track
and is released under `viewer-v*` tags.

## [Unreleased]

Nothing yet.

## [1.9.1] — 2026-09-01

- **`.gemlhistory`'s three block types are prefixed `history-`**: `revision`,
  `keyframe` and `blob` are now **`history-revision`**, **`history-keyframe`**
  and **`history-blob`**, so they stop squatting bare names §8.5 reserves for
  future versions of this specification. **The old spelling is not read.** A
  sidecar written by an earlier build is one substitution away and the
  substitution is lossless — a revision's `hash` covers the snapshotted
  document, not these fence lines, so every hash in the chain survives it:

  ```
  perl -i -pe 's/^(={3,} +)(revision|keyframe|blob)( |\{)/$1history-$2$3/' <file>.gemlhistory
  ```

- **`geml-version` in a `.gemlhistory` named a version that never existed.** The
  key means "the GEML language version the history conforms to" and the writer
  hardcoded `"0.1"`; the language is at 1.0. The profile spec disagreed with
  itself — §3.1's example showed `0.1` and §3.2's showed `1.0` — and §3.2 was
  right. Nothing reads the key, so the correction is safe and a sidecar can be
  fixed with one substitution; its hashes are unaffected either way.
- **§4's line continuation was folded by `parse` and by nothing else.** A block
  whose attribute object wraps with `\` — the spec's own §6 table example among
  them — checked clean and could not be addressed: `geml get '#fy25'` answered
  "no block with id". `collectSpans`, `sectionEnd` and `collectMeta` walked raw
  physical lines, so the parser saw a table with an id while the addressing index
  saw prose. That index is what `list` / `get` / `set` / `add` / `delete` /
  `revert` and the MCP write verbs are built on, so such a block could not be
  edited by an agent at all. The fold is one shared function now.

## [1.9.0] — 2026-08-31

### Added
- **`profile` — how GEML is extended (§8.6).** A document declares an
  application-layer vocabulary in `=== meta`, and that declaration is the only
  thing that admits block types, attribute keys and `diagram` format names this
  specification does not define. §8.5 always said the type registry was open;
  §8.6 says how it opens and closes every other route. A processor that
  recognizes no vocabulary at all is conformant, and admission licenses names
  only — it MUST NOT change the document model, which is what keeps the
  conformance suite independent of who knows which vocabularies, and what makes
  `get`, `set` and `=== embed` behave identically either side of a declaration.
- **`geml-history/v1`.** The `.gemlhistory` sidecar's own vocabulary
  (`revision`, `keyframe`, `blob`) is declared like any other layer, and
  `geml history save` writes the declaration. Until now every history file this
  project produced reported its own blocks as `unknown-block-type` — 333
  occurrences across seven sidecars. A file written before this is fixed by its
  next save or by adding the one meta line; the revision chain does not notice
  (`geml history verify` passes on all seven).

### Changed
- **The space after a fence is optional.** `===note {#a}` is the same block as
  `=== note {#a}`, and `===#a` closes what `=== #a` closes. A glued line used to
  fall through to paragraph text, so an OPEN left no addressable block and a
  CLOSE stopped closing, surfacing far below as `unterminated-block` — while
  `check` answered exit 0 on a document `list` reported as empty. Keeping a
  fence-like line literal is what it always was, §5.1's `\===` block escape,
  which works for every spelling where the space worked for one. Census before
  the change: zero lines in 172 in-repo documents change meaning.
- **`type` no longer shares the `NAME` production.** A block type is ASCII and
  starts with a letter (`TYPE-NAME`), which is what the reference parser always
  read; the specification was the loose one, and `=== 中文块 {#a}` was
  spec-legal and universally rejected. Ids, classes and attribute keys keep the
  wider `NAME` — an id is derived from text the author already wrote, a type
  name is chosen.
- **Profile names are prefixed `geml-`**: `codemap/v1` is now
  **`geml-codemap/v1`**, joining `geml-style/v1` and `geml-history/v1`. Free
  today and not later — the profile mechanism landed after 1.8.8 and has never
  been published. A document declaring the old name gets no vocabulary and
  warns; the fix is the new name, or a rebuild for generated documents.
- **`GEML-history-spec` is now the `geml-history/v1` profile**, not a companion
  specification. Its three block types carry `raw` bodies and need nothing from
  §3's registry, so the rank was the only thing wrong; the document's substance
  is unchanged. GEML has one specification, and the CC-BY-4.0 list in
  `spec/LICENSE-spec.md` shrinks to it — an application layer is not the
  specification, which is also why `docs/comparisons/COMPARISON*` left the list.

### Removed
- **`fence-glued-text`.** The warning existed because the strictness created the
  trap; the trap is gone rather than merely unreported, so the code is retired.
  Anything matching on it will stop seeing it.

## [1.8.8] — 2026-08-28

### Added
- Three diagnostics for near-miss headings and fences — shapes that parsed into
  something the author did not write and said nothing about it. All three are
  warnings, so such a document still parses and stays writable.
  - `heading-attrs-trailing-text` — an attribute object followed by more text on
    the heading line (`## Title {#sec}aaa`, and `## Title {#sec}aaa}`, where the
    trailing `}` pairs with nothing). §4 requires the object to END the line, so
    it is not read as attributes at all: the explicit id is lost and the heading
    falls back to its derived one. The reason this earns a diagnostic rather than
    a footnote is what the loss costs downstream — a heading's section runs to
    the next heading of its level, so `geml get`/`set`/`revert` on the only
    address left resolves to the whole rest of the document, and a one-block
    revert quietly becomes a whole-document one.
  - `heading-attrs-unclosed` — the object is never closed by `}`
    (`## Title {#sec`): same loss, different cause. Worth knowing while it is
    still unfixed: a canonical `--to geml` re-format of such a heading also
    re-anchors its section (`## B {#sec2` becomes `## B {#sec2 {#b-sec2}`, whose
    attributes parse as `{#sec2 {#b-sec2}`), which turns every reference to it
    into an `unresolved-reference`. Closing that hole needs the line scan to
    honour `\{`, a parsing change not made here; this diagnostic is what keeps
    the shape from reaching a re-format unseen.
  - `fence-glued-text` — a `=` run glued straight to text (`===dddd`, `===note`,
    `===#sec`): not an open fence, not a bare close, not a labeled close. Meant
    as a close it stops closing, and the block it should have ended surfaces as
    an `unterminated-block` far below.

### Changed
- `fence-like-line` also fires when the type name is NOT registered but the rest
  of the line carries attribute evidence — a brace, or a `key=` token — so
  `=== aaa}` and `=== aaa src=#a` are reported like their registered-type
  siblings `=== note}` and `=== note src=#a`. One stray `}` used to buy silence
  for a whole line: `=== aaa` warns as `unknown-block-type`, and `=== aaa}` said
  nothing at all. A wall of `=` stays quiet, having neither a brace nor a `key=`
  token: `=== decorative divider ===`.
- `fence-like-line`'s message now names the cause, because the cause decides what
  the author has to do: an object never closed on this line (with the `\`
  continuation named as the other way out), text after the object, a `}` that
  pairs with no `{`, or attributes written without braces at all. `=== code {` is
  a habit rather than a slip, and "attributes must be braced" told its author to
  do what they had just done.

### Fixed
- Appendix B's `bare-word` production admitted only `NAME | number`, which the
  specification's own examples contradict — `data=#fy25`, `src=b.geml#tbl` and
  `src=rows.csv` are none of those. A bare value is now every character except
  whitespace, `"` and the object's own braces: the three that actually delimit
  one.
- Appendix B's `number` production was narrower than the value typing it
  describes — no sign, no exponent, no leading dot, leading zeros forbidden —
  while `+1`, `1e3`, `.5` and `007` have always typed as numbers. A test now
  pins the ten bare-word shapes that type as a number and eight that stay
  strings, so the digest cannot drift from `coerce()` unnoticed again. Appendix B
  is non-normative and no parsing behaviour changed.
- The browser extension carries this parser, so the same diagnostics reach the
  checks it runs on a page. *(`viewer-v1.2.3`, on its own track.)*

## [1.8.7] — 2026-08-26

### Added
- `unitSpans(source)` — the block scan without the content addresses. It is the
  same walk `addressedUnits` performs, minus the per-unit hash that gives an
  id-less block its `@<hex>` address, because that hash runs on node's `Buffer`
  and therefore throws in a browser bundle. A caller that only needs to know
  where the blocks are — which one holds this line, how many bytes it is —
  should not have to pay for an address it will not use, and should not have to
  reimplement the scanner to avoid it. The playground uses it to report what
  one block costs an agent while you type; it shipped in that page a version
  early, under 1.8.6, which is corrected here.

## [1.8.6] — 2026-08-25

### Fixed
- **`--to md` carries the content `--to html` shows.** The renderer was given a
  document resolver and the Markdown export was not, so the same file exported
  two ways disagreed about whether the reader sees anything: `=== embed` and an
  inline `![[#id]]` projection each degraded to a link to the target, and a
  `data {src=…}` block — whose value the parser had already loaded — came out as
  an EMPTY fence with no note at all. Both projections now expand in place,
  through the same walk `--view` uses (chains followed, cycles refused, reads
  confined to `--root`), and fall back to a link only when the target cannot be
  read. What is lost is the machinery, and it is lost on purpose: an export
  invites edits, so a marker that let a return trip restore the projection would
  re-evaluate it over the top of those edits and drop them in silence.
- **A `table {src=…}` stops reporting a loss it did not suffer.** The note fired
  on `src` alone and claimed the export held the header only, over a table
  carrying every row. A reader told the data is missing goes and adds it back;
  it now speaks only when the rows really are absent.
- **Three tests in `cli.test.mjs` had never run.** A `process.exit(0)` — there
  because a live handle on Linux can hang the whole npm-test chain — sat above
  them, so they were dead code that read as passing. It moved to the end of the
  file and the three were repaired: one was missing an import, one generated a
  syntactically invalid script (a template literal's `\n` became real newlines),
  and the third caught a real drift — `geml.ts` had grown an `fs.realpathSync`
  import its allow-list did not mention. That guard exists because the viewer
  build fails on any library import its stub cannot answer, and it had been
  asleep for as long as the exit line was above it. The stub does provide
  `realpathSync`, so the list was the stale half.

### Added
- A test that asserts the two exports agree on WHAT they carry, rather than on
  any one construct: same document, both targets, every piece of content a
  reader came for present in each. The shapes differ by design — `<td>` on one
  side, pipes on the other — and the content has no excuse to.

## [1.8.5] — 2026-08-25

### Fixed
- **A defect the document already carried no longer blocks an unrelated edit —
  in Markdown.** The write guard re-parsed the result and refused on ANY error,
  so a document with an older problem was permanently unwritable, while saying
  the edit "would break the document" about an edit that broke nothing. It bit
  hardest on the plain Markdown these verbs also address: a `[…](#anchor)`
  aimed at an `<a id>` — which GEML does not model — is an unresolved reference
  here and perfectly good Markdown on GitHub, so one such link in a README
  blocked every write to that file. Outside a `.geml` document the guard now
  refuses only the errors an edit ADDS, counted by message so a second `#foo`
  beside a pre-existing one is still caught, and `duplicate-id` is never
  forgiven — every other defect is elsewhere in the document, but a duplicate id
  empties the address the write is aimed at. Inside a `.geml` document nothing
  changes: "every reference resolves" is the contract its author opted into, so
  it stays locked until repaired, and the MCP server still tells the model the
  errors predate its edit. `geml check` reports pre-existing defects exactly as
  before — this changes what is refused, not what is diagnosed.
- **`set` no longer stamps an id a heading already derives.** Replacing a whole
  section wrote `## Alpha {#alpha}` — invisible to GEML, literal text in
  GitHub-Flavored Markdown. Content whose own head already resolves to the
  target id is spliced as it stands; a renamed heading, a foreign id and a typed
  block without one are still normalized, so no address moves. The judge is the
  parser, never a second copy of the slug rule.
- **The two spec `.gemlhistory` chains verify again.** `geml history verify` had
  been failing on `GEML-spec` and `GEML-spec_CN` since 2026-07-31: one bad
  reverse patch, and because a sidecar carries only the committed-current
  keyframe, every revision older than it became unreconstructable — 24 of 47 and
  15 of 35. None of that content survived anywhere else (checked against every
  git blob of both files), so it could not be repaired; the unreadable tail is
  removed and the oldest surviving revision is now the root. Every tracked
  sidecar in the repo verifies clean.
- CI now runs `geml history verify` over every tracked `.gemlhistory`. `geml
  check` proves references resolve and says nothing about whether the history
  beside a document can still be reconstructed — which is how the above went
  unnoticed for a month, in the repo that ships the verb.

### Changed
- The README leads with the read layer on documents you already have —
  `geml list/find/get` address any `.md`, nothing is converted — and presents
  the format as the upgrade for validated writes, per-block history and bound
  charts. The npm, MCP-registry and plugin-manifest descriptions follow the
  same order.

## [1.8.4] — 2026-08-24

### Fixed
- **A hard-wrapped list item is one item, not an item plus a paragraph.** A
  non-blank line directly below an item, indented past its marker — not an item
  line, not a `%%` comment — now joins the item as a soft wrap, the same join a
  paragraph gives its lines, so emphasis pairs across the wrap. The old reading
  silently split the item and `--to md` faithfully emitted the broken model: a
  blank line between the halves and the unpaired `**` escaped to `\*\*`. The
  boundaries are unchanged — a blank line still ends the item (multi-paragraph
  items stay outside the language) and the task marker is read on the first
  line only. Both serializers emit the wrap as continuation lines aligned under
  the content column, so `--to geml` round-trips and GFM reads `--to md` output
  as the same single item. §2.2 and the item grammar now say so; the second
  implementation and 8 conformance cases moved in the same change.
- The second implementation now recognizes an INDENTED `%%` comment line, as
  the §3.1 grammar always specified (`comment-line = indent , "%%" , …`); it
  had only matched column 0, which the new conformance cases exposed.

## [1.8.3] — 2026-08-24

### Added
- A **Codex plugin** (`integrations/codex-plugin/`), and the repo-level
  marketplace source (`.agents/plugins/marketplace.json`) that makes it show up
  in `/plugins` from a checkout. Same payload as the Claude Code plugin — both
  skills, the `geml` MCP server, and the `SessionStart` hook — repackaged for
  the harness: `.codex-plugin/plugin.json`, the server in a separate
  `.mcp.json`, and `${PLUGIN_ROOT}` in the hook command. Tests pin the copies
  against each other and both manifests against the package version.

### Fixed
- **A `=== meta` inside a `raw` body no longer defines document metadata.** The
  metadata pre-scan was a flat sweep for `=== meta` over every line, so a meta
  block shown as an EXAMPLE inside a longer-fenced `code` block supplied real
  `{{key}}` values — and `geml check` reported nothing, because as far as it
  could tell the key was defined. It now descends exactly as the block scanner
  does, into `flow` bodies only; a `raw` or `data` body is opaque (§3). Two
  visible effects: example text stops shadowing the document's own metadata, and
  a document whose example repeats a key it also defines stops warning
  `duplicate-meta-key` against a redefinition that does not exist — which the
  authoring skill's own reference (`references/authoring.geml`) had been doing.
  §4 now says this outright, and `interp.json` pins it for other
  implementations; the second implementation had the same bug, which is why the
  suite had not caught it. A `=== meta {#id}` may now also close on its labeled
  fence, like every other block.

## [1.8.2] — 2026-08-17

### Added
- `name-not-a-name` (warning) — an `id`, class or attribute key that is not a
  NAME (§4: letters, digits, `-`, `_`). `{#a & b}` has always parsed as the id
  `a` plus boolean flags named `&` and `b`, and said nothing about it, so the id
  you went on to address did not exist. Quoting keeps the space but leaves the
  quotes in the id, which warns too.

### Fixed
- `--root` works on every read and write verb, not just `check`. A write is
  refused when the result would not parse, so a document whose `../sibling.md`
  links resolve only from a wider root could not be edited at all — not even by
  writing a block back unchanged, while `check --root .` called it clean. The
  guard was refusing its own blind spot.
- `geml mcp` hands the CLI the root it already had. Every write tool was
  affected, which is the surface agents actually use.

## [1.8.1] — 2026-08-15

### Fixed
- **Inline parsing no longer hangs or crashes on crafted delimiter input.** A
  tilde run spent down to one character (`~~~a~~~`, seven bytes) re-paired
  forever, and `~~~~a~~~` drove a run length negative into a `RangeError`; a
  spent `~` run is now literal, as a lone `~` always was. Latent since before
  1.8.0 — the emphasis rework surfaced it under audit.
- **Emphasis pairing is linear again.** The delimiter-search bound
  (`processEmphasis`) tracked a position on the wrong list and never took
  effect, so pathological `*`/`~~` floods went quadratic (≈19 s on 205 KB);
  the reworked delimiter chain restores the CommonMark linear scan. Output is
  unchanged — 53,952 emphasis cases diff identically before and after.
- **Bracket and paren scanning is linear again.** Every position that failed
  to open a link, image, ref or footnote re-scanned the tail
  (`readBracket`/`readParen`), so `[[…`, `![…`, `[^…` and `[a](…` floods went
  quadratic (≈40 s on 160 KB); partners are now found in one pass.
- **A prototype-chain name is no longer a valid block type.** `=== constructor`
  (and `toString`, `valueOf`, `hasOwnProperty`, …) indexed the type registry's
  prototype and returned an inherited function, suppressing the
  `unknown-block-type` warning and putting a non-string in a block's `mode`;
  the registry is now a `Map`.
- **`geml_find` (MCP) rows are root-relative on a symlinked root.** With a
  `path` argument the search root came back realpath-canonicalized (macOS
  `/var` → `/private/var`), so rows kept an absolute prefix; both spellings are
  now stripped to root-relative coordinates.
- **The code-graph MCP wrapper's "build the parser first" guard now fires.** It
  sat below a static import that already pulled in the unbuilt `dist/`, so a
  missing build died with a bare `ERR_MODULE_NOT_FOUND`; the dependent import
  is now dynamic, after the guard.

## [1.8.0] — 2026-08-14 *(never published to npm — these changes reached users in 1.8.1)*

### Changed
- **Emphasis pairs across inline atoms** ([GEP-0007], accepted). §5.3 phase 2
  now runs over the whole inline sequence with atoms as opaque units, so
  `*see the [spec](s.geml)*` is emphasis containing a link — as in CommonMark —
  where it used to fall apart into silent literal asterisks. Works for `*`,
  `**` and `~~` around links, code spans, inline math, images, auto-refs,
  inline projections, footnote refs, escapes and hard breaks; at an atom
  boundary the flanking test reads the atom's edge source characters. A
  document that meant the asterisks literally keeps `\*` as the supported
  spelling. The second implementation and the conformance suite moved in the
  same commit.
- **A `code` block body alongside `src=` is now an error** (`code-src-and-body`,
  replacing the `stale-code-snapshot` warning): a block carries the route or
  the body, never both — the same rule `table` and `data` sources already
  follow. The body is kept in the model and the route is not fetched.
- **Across `=== meta` blocks the first definition of a key wins.** A
  redefinition is the new `duplicate-meta-key` warning and is ignored (a later
  block used to overwrite silently).
- **Derived heading ids keep underscores**: `# foo_bar` now derives `#foo_bar`,
  distinct from `#foobar` (step 3 of the §4 derivation used to drop `_`).

[GEP-0007]: spec/proposals/0007-emphasis-across-atoms.md

## [1.7.8] — 2026-08-12

### Fixed
- **`--to html` no longer drops content.** A `data` block kept its first 500
  lines and a table its first 500 rows; the rest were gone, under a note
  pointing at the document source. Every line and row reaches the page now —
  past the bound the remainder folds into a collapsed `<details>`, so the page
  is as short as before and one click from complete. No option can drop content,
  and no CLI flag exposes the bound.
- A long table in an ordinary document renders folded and whole instead of open
  and truncated: its first 500 rows are now one click away.
- The browser extension had the same hole at 20 lines, and was the only block
  type bounded at all. Now 100 open, the rest folded. *(`viewer-v1.2.2`, on its
  own track.)*

## [1.7.7] — 2026-08-12

### Changed
- The skill says to GIVE every section a stable `{#id}`. It had only said ids
  must be unique and references must resolve, which a document with no ids at
  all satisfies perfectly — so the one habit the rest of the tooling rests on
  was the one thing never asked for. A document with no ids costs what Markdown
  costs: there is nothing for `geml get` to read or `geml set` to replace short
  of the whole file.
- The skill covers a project moving TO GEML: new documents are authored as
  `.geml` in one directory with an `index.geml` for a map, and **existing files
  are left alone**. Writing a `.geml` version of a document is not licence to
  delete the Markdown it was drawn from, however completely the content was
  carried across — deleting a file is a request a person makes, never an
  inference from a "one home per topic" convention. Saying "this project's
  documents are GEML now" should not require also saying "and don't delete
  anything".
- The skill page carries less. `--head`/`--intro`/`--body`, the `replace` verb
  and the drops-a-block reporting rule moved into `references/authoring.geml`,
  which is fetched a section at a time. They are needed rarely and the page is
  read every time — 12% off what loads on every trigger, onto what loads on
  request.

## [1.7.6] — 2026-08-12

### Changed
- The authoring skill wakes up for documents that were never GEML. Its
  description is the whole trigger, and it only matched when the task already
  sounded like GEML — while the case worth catching is a long README in a
  project that has never heard of the format. The description now names the
  situation, and the skill opens with the route for a document that stays
  Markdown: `list` to map it, `find` to locate a phrase as an address, `get` to
  read one block, then the ordinary editing tool. Nothing is converted and
  nothing is written, and the first rule in that section is when NOT to take
  the route — what is saved is only ever the part of the file you did not have
  to read.

### Added
- The Claude Code plugin ships a `SessionStart` hook: six hundred bytes naming
  what exists and when to skip it, in every session, because a description is a
  match and not a guarantee. It points at the MCP tools rather than the CLI,
  since the plugin registers the server but cannot promise `geml` is on PATH.
  `geml skill install` still installs no hooks, so the hook reaches plugin
  users and nobody else.
- `plugin.json`'s version is asserted against `package.json`. It had sat at
  1.7.0 while the package shipped 1.7.5, and a plugin's users only receive
  updates when that field is bumped — so the lag failed nothing and delivered
  nothing.

## [1.7.5] — 2026-08-12

### Changed
- `geml find` searches a file you NAME whatever its extension. `list` and `get`
  already read Markdown, and having only `find` refuse meant
  `geml find GEML README.md` exited 1 against a file holding forty-four
  matches — a search that answers "no" about a file you pointed straight at.
  The `.geml` filter belongs to the DIRECTORY walk, where taking every file
  would drag a whole source tree through the parser, and it still applies
  there. With this, `find` + `list` + `get` address a plain README the same way
  they address a GEML document, without converting anything.

## [1.7.4] — 2026-08-12 *(superseded — do not use)*

Published to npm and superseded by `1.7.5` eight minutes later; no commit in this
repository ever carried the version `1.7.4`. It ships nothing `1.7.5` does not,
and it is listed here only so the npm version list has no unexplained gap.
**Upgrade to `1.7.5` or later.**

## [1.7.3] — 2026-08-07

### Added
- `geml list` — the listing `geml get <file>` already printed with no selector,
  under the name the MCP surface uses, and told to be called first. The
  capability was there; nothing pointed at it.
- `geml find <pattern> [path…]` — searches block CONTENT and answers with an
  ADDRESS rather than a line number, so a hit survives the next edit. Reports
  the innermost block holding the match, once per block, and exits 1 on no match
  so `if geml find …` works in a script.
- `L27` / `L27-58` position selectors — the smallest block fully containing
  those lines. Editors, linters, diff hunks and stack traces speak line numbers;
  this is where they cross into block addressing.
- `--intro` on `get` and `set` — a heading's opening region, everything under
  it up to its FIRST subheading. Empty when a heading follows immediately (and
  setting an empty one writes an opening where the section had none); the whole
  body when none does. A block has no intro and asking for one is a usage error.
- `geml replace <file> <old> <new> [--within <selector>]` — **EXPERIMENTAL, and
  may be withdrawn.** A literal swap, never a pattern. Costs what `sed -i` costs
  and adds what it cannot: the result is re-parsed and refused if it would break
  the document, the blocks it touched are named, and the write is in
  `.gemlhistory`. Refuses a swap that would rename an id and points at
  `geml rename`, which fixes the references too.
- `geml_find` on the MCP server, answering in paths relative to the root so a
  row pastes straight into `geml_get`.

### Changed
- Removing content now has ONE rule across every verb: a replacement that drops
  blocks is carried out and REPORTED — every id named, unnamed ones counted,
  orphaned references warned about — with `geml revert` as the way back. It used
  to be refused when the block had an id and done in silence when it did not, so
  a block's fate turned on whether anyone had named it, and a section whose
  opening held a note could not have that opening replaced at all. What is still
  refused is a write that BREAKS the document.
- A link to a directory is no longer a broken link. `ParseOptions.docExists`
  answers the narrower question for LINK checking only; `embed`, `table src=`
  and `data src=` need bytes and still refuse one.
- A fragment is read as a block id only when the target is a `.geml` document.
  In `page.html#sec` or `notes.md#sec` it belongs to that format. The old
  behaviour was wrong in both directions — it accepted `{#brace}` ids no forge
  resolves and refused `<a id>` and slug anchors that every forge does — and it
  passed by ACCIDENT whenever the name appeared anywhere in the target.
- `geml list` prints a line range on EVERY row, headings included. The range is
  itself an address, and a section's was the one most worth having.

### Removed
- Four branches that could never run: `runTransform`'s no-input-file guard
  (dispatch only reaches it with a file) and three in `replace` that restated a
  guarantee `selectUnits` already makes.

## [1.7.2] — 2026-08-06

### Changed
- The CLI is a separate entry point (`dist/cli.js`) from the library
  (`dist/geml.js`), so importing the package no longer pulls the command-line
  layer in.
- `geml codemap serve` renders the graph fullscreen.

## [1.7.1] — 2026-08-05

### Security
- Follow-up hardening for the areas covered under *Scope notes* in
  [`SECURITY.md`](SECURITY.md).

## [1.7.0] — 2026-08-05

### Added
- **`=== data` blocks** ([GEP-0005](spec/proposals/0005-data-block.md)) — a
  block whose body is a *value*, not text: `json` (default) and `jsonl`, with
  `yaml`/`toml` reserved. A malformed body fails the build, `geml get --json`
  returns the value itself, and a chart can bind to it directly.

## [1.6.1] — 2026-08-04

### Added
- **`geml skill install`** — one command sets up the authoring skill, the CLI
  and the MCP server for Claude Code, user-global. It edits no `settings.json`
  and installs no hooks.
- A Claude Code plugin channel (`claude plugin marketplace add geml-spec/geml`).

## [1.6.0] — 2026-08-04

### Changed
- **One selector syntax across `geml get` and `geml set`** — `#id`, a copied
  heading line, `=== type`, and `@<content-hash>` all resolve the same way, and
  a heading id addresses its whole section.
- **`geml history` becomes four verbs** — `save` / `get` / `restore` / `verify`.

## [1.5.1] — 2026-08-01

### Fixed
- Maintenance release.

## [1.5.0] — 2026-07-31

### Added
- **`=== embed` transcludes a block** — in the same document by `#id`, or across
  documents by `src=other.geml#id`, rendering the target's current state in
  place.

### Changed
- `src=` and `data=` resolve under one rule.

### Removed
- The `output` attribute was withdrawn before it shipped in a stable form.

## [1.4.6] — 2026-07-30

### Fixed
- Maintenance release.

## [1.4.5] — 2026-07-29

### Changed
- **Breaking (MCP clients):** every MCP tool is renamed to its CLI command path
  — `geml set` → `geml_set`, `geml codemap search` → `geml_codemap_search` — so
  the terminal and the agent share one vocabulary. Re-register the server after
  upgrading.

## [1.4.4] — 2026-07-28

### Added
- Published to the **MCP Registry**; `server.json` carries the server manifest
  and is versioned in lockstep with `package.json`.

## [1.4.3] — 2026-07-28

### Fixed
- Maintenance release.

## [1.4.2] — 2026-07-24
## [1.4.1] — 2026-07-24
## [1.4.0] — 2026-07-23

### Added
- Block-mutation CLI work landing across these releases: `get` / `set` / `add` /
  `delete` / `rename` / `revert` over addressed blocks, each write re-parsed and
  refused before it reaches disk.

## [1.3.2] — 2026-07-23

### Added
- `geml codemap serve --watch`.

### Fixed
- `geml codemap refresh` pathspec handling.
- `render-html` split into its own module (no API change).

## [1.3.1] — 2026-07-22

### Changed
- Refreshed npm README and package metadata.

## [1.3.0] — 2026-07-22

### Added
- **`=== text` blocks** ([GEP-0004](spec/proposals/0004-text-block.md)) — a run
  of prose becomes addressable without inventing new syntax.

### Fixed
- `{{key}}` interpolation now skips code spans and math, and `\{{key}}` escapes
  it.

## [1.2.3] — 2026-07-21

### Added
- **`geml check --root <dir>`** — widens cross-document reference resolution to
  a directory, so sibling directories can reference each other. Escapes past the
  root are still refused.

## [1.2.2] — 2026-07-21

### Security
- Round-two security-audit fixes. Codemap recipes became structured
  (`{cwd, env, argv}`) behind a schema version gate; older recipes are refused or
  upgraded rather than executed as-is. Plus fixes for scheme control characters,
  same-origin `fetchDoc`, `vscode:`/`action:` schemes, recursion and DoS limits.

## [1.2.1] — 2026-07-21

### Security
- Round-one security-audit fixes: a trust gate closing a remote-code-execution
  path in the codemap recipe runner.

## [1.2.0] — 2026-07-17

### Added
- Published to npm as `@geml/geml`.

## [1.1.1] — 2026-07-13

### Fixed
- Maintenance release.

## [1.1.0] — 2026-07-06

### Added
- **The codemap toolkit ships in the package** — `geml codemap
  build|verify|render|serve|mcp`, writing a codebase's call graph as a tree of
  GEML documents. (The separate `geml codemap mcp` entry point was later
  removed; the code-graph tools are served by `geml mcp --root <dir>` when the
  root holds a graph.)

## [1.0.0] — 2026-06-29

### Added
- First npm release of the reference parser, validator, renderer and CLI,
  against **GEML specification 1.0**.

[Unreleased]: https://github.com/geml-spec/geml/compare/main...HEAD
