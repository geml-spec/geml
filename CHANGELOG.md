# Changelog

All notable changes to **`@geml/geml`** (the reference parser, CLI and MCP
server). The **specification** is versioned separately and independently — it
has been `1.0` (Stable) since the first npm release; see
[`spec/GEML-spec.md`](spec/GEML-spec.md) and
[`GOVERNANCE.md`](GOVERNANCE.md#versioning).

`geml --version --json` prints both: `{"parser":"…","spec":"…"}`.

Entries are grouped by version, newest first, under `## [x.y.z] — date`
headings; versions follow [Semantic Versioning](https://semver.org/). Up to
`1.9.0` a version's bullets sit under *Added* / *Changed* / *Fixed* /
*Security* subsections; from `1.10.0` on each bullet carries its own bold lead
instead, and a security-audit round is a bullet that begins **Security audit,
round N**. The headings are not compare links — the parser's releases are not
tagged in git (the lone `parserv1.3.2` tag, annotated "old cli commands", is not
a release marker) — so the record of what is on npm is the
[npm version list](https://www.npmjs.com/package/@geml/geml?activeTab=versions);
a heading marked *(never published to npm)* names the release its changes
reached users in, and one marked *(unpublished from npm)* — published, then
withdrawn — names the oldest release on npm that carries its changes. Entries
for `1.0.0` through `1.7.2` were reconstructed from the release commits, so they
record what each version shipped rather than a contemporaneous editorial note.

The browser extension (`integrations/chrome-geml-viewer/`) versions on its own track
and is released under `viewer-v*` tags.

## [Unreleased]

## [1.12.4] — 2026-10-08

- **Every refusal now says why with a code.** A verb that writes nothing
  carries one of spec Appendix A.6's eight reasons — `no-such-unit`,
  `ambiguous-address`, `bad-address`, `bad-content`, `would-drop-unit`,
  `broken-result`, `rename-refused`, `revert-refused` — on the `--json`
  refusal frame (`reason`) and on the MCP write result. Messages are unchanged.
- **The conformance suite pins the eleven editing operations.** `edits-<verb>.json`
  pairs an input with an operation and the exact outcome — rewritten text,
  output, or refusal code — so a second implementation is held to the same
  effect, not only the same parse (spec §8.2(10), §8.4). The model `to json`
  prints is compared through the suite's projection, as a parse case is.
  Markdown documents, which the specification does not define, have cases of
  their own in `edits-markdown.json`, behind an optional `markdown` capability.
- **The Rust crate performs the eleven editing operations.** `geml-parser-rs`
  passes every `edits` case, natively and as WebAssembly (`edit(case)`),
  Markdown documents included: it reads a `.md` as the reference parser does.
  A link into a document of another format is now checked as §5.2 asks — the
  document must exist — and a missing document is reported once.
- **`delete`, `add --before/--after` and `revert --before/--after` take every
  address a listing gives** — a content address, a line range, a heading line,
  a type or attribute filter — not only an id. An anchor that matches several
  blocks is refused; `delete` removes every block its filter matches. The MCP
  tools `geml_delete` and `geml_add` take the same forms.
- **Fixed: a heading line two headings share resolved to the first.** `get '## Same'`
  with two same-level `Same` headings now refuses as ambiguous, as the
  text-only form already did.
- **Fixed: `revert` trusted a sidecar it never checked.** A revision read for
  `revert` or `--rev changed` is compared with its recorded hash; a sidecar
  altered by hand is refused instead of spliced in.
- **Fixed: `--to geml` dropped a prose block's body.** A block a vocabulary
  reads as prose (GEP-0013, `media-text` among them) keeps no raw lines, and
  the serializer wrote only those: the block came out empty. It is written
  from its paragraphs now.
- **Fixed: a view filtered to no rows was reported unreadable.** `--to md`
  said its source "could not be read", and GEML written into a `.md` with such
  a view was refused. A source that was read has columns; only a missing one
  is reported now.
- **Fixed: `set --body` on a setext heading dropped its underline.** The
  heading became a paragraph and the write was refused; its head is both
  lines, as `get --head` already said.
- **Fixed: `--to geml` from Markdown broke a GEML block the file already
  carried.** The block's last line and closing fence read as a setext heading;
  the block now passes through as written.
- **Fixed: `data-parse` named the wrong line.** A json body that breaks on a
  stray character or ends too soon was reported on its fence, other mistakes
  on their own line; every json error now names the line the body breaks on.
  A `src=` file's errors are reported on the block that names it, not on lines
  of the document past it.
- **Fixed: the yaml engine read an unclosed `[` or `{` as text.** `a: [1` is a
  flow collection, outside the subset, and is refused as §3.2 requires.
- **A coordinate write moves no other byte.** `set` into a `json` or `jsonl`
  body replaces the value's own text and keeps the rest: before, the whole
  body was re-serialized, so a neighbouring integer past 2^53 came back
  rounded (`12345678901234567890` as `12345678901234567000`), `1.50` as
  `1.5`, and the layout was redone. The new value is written as given; a
  `jsonl` write changes its record's line only.
- **Value trees take appends, insertions and removals.** `set '#d["tags"][N]'`
  with N the sequence's length appends; `add --before/--after
  '#d["tags"][i]'` inserts a value beside an element; `delete '#d["key"]'`
  removes a member, an element or a `meta` key. Each splices the text the way
  a write does; with `get` and `set` this covers what JSON Pointer and JSON
  Patch's add/remove/replace do.
- **`inexact-number` warning.** A number in a `json`/`jsonl`/`yaml`/`edn`
  body or a `meta` value that binary64 cannot read back as written is said at
  `check`, so a long identifier can be made a string before anything rounds
  it.
- **`#meta` is the document's one `meta` block.** `geml list` printed `#meta`
  for it; now `add --before/--after`, `delete`, a whole `set` and `get
  --head/--body` take it too. With several `meta` blocks `#meta` names their
  merge, and those operations refuse it as `ambiguous-address`, listing each
  block's address.
- **Fixed: a coordinate write of JSON outside the value domain.** `1e400` was
  written as `null`, a repeated key kept its last value, and a value nested a
  few thousand levels deep crashed the CLI; each is refused as
  `broken-result` now. A map or sequence written into `meta` came out as
  `"[object Object]"` or `"1,2"`; it is refused.
- **Fixed: `delete '#meta'` reported success and deleted nothing.**
- **Rust implementation:** `to md` expands embeds and inline projections and
  keeps a table's alignment and its cells' inline formatting; a reference
  inside a table cell is checked; a list item's marker may be followed by
  several spaces or a tab, and a continuation is measured from the item's own
  marker; a pipe grid's header is the row above its separator. It reads an
  `edn` body as the reference parser does, reports every `jsonl` line that
  is not JSON, and names the line a body breaks on.
- **`--to md` writes a stand-alone ``` pair as a fenced block.** A code span
  whose delimiters stand alone on their lines — §3.1's shield, as a list item's
  example carries it — was written back with single backticks, which Markdown
  reads as inline code: the lines ran together, and inside a list item the
  example became one long string. It is now a fence, at the item's
  indentation, longer than any backtick run inside it.
- **`set --body` on a heading keeps the blank lines around the text.** A
  heading's body includes the blank lines that separate it, so text typed by
  hand landed the heading, the text and the next heading on consecutive lines.
  The separators are given back, as `--intro` and `add` already did; a
  `get --body` → `set --body` round trip still changes nothing.
- **A `../` reference that fails without `--root` says so.** `check` and a
  transform print a note that resolution stops at the file's own directory
  unless `--root` widens it, rather than leaving "cannot resolve document" to
  read as "no such file".

## [1.12.3] — 2026-10-05

- **A `.md` has the outline GitHub shows.** A setext heading — a paragraph
  over a `===` or `---` underline — is a heading, its head both lines, so
  `get --head` and `--body` split it where GitHub does; it was prose. A line
  inside `$$` display math, an HTML comment, `<pre>`, or a block-level HTML tag
  up to its blank line no longer starts a heading, a fence or a footnote
  definition: a `# …` there was a section. A `=== word` line whose type this
  reader does not know is text, as GitHub prints it; it opened an unknown block
  that ran unclosed to the end of the file, taking every heading after it.
  GEML's own typed blocks of known types are still blocks in a `.md`, and a
  `.geml` reads nothing differently.
- **The empty string is never an id (spec §4).** `#` alone is a URL's empty
  fragment, the top of a document, so it names no block: a heading whose text
  derives nothing — `## !!!`, a heading that is only a code span — has no id,
  no address, anchors no prose and collides with nothing, where it derived the
  empty id and a second one was a `duplicate-id` error. `{#}` reads as if no id
  were written: a typed block has none, a heading derives one, and the
  `name-not-a-name` warning stands. The reference listed `#` and named prose
  after it (`#-before-x`) while the Rust crate listed neither; both now read the
  rule the same way, and the conformance cases that pinned the old one are
  turned round, with one each for `{#}` and for prose beside such a heading.
- **`geml list` leaves no content out.** A document of prose alone — a note
  with no heading and no block — listed nothing, so no address reached its
  text; it is one run now, listed by its content address like any run in the
  body. A Markdown footnote definition holds what GFM gives it, its lazy
  continuation and the lines indented under it, so `get #n` is the whole note;
  it was its first line, and the rest opened the next run. In a `.geml` a
  `[^n]:` line is prose, as the parser has read it since the definition line
  was withdrawn; the listing still walked it as a footnote and listed `#n`
  beside an `unresolved-footnote` error. And a repeated id is listed once: a
  later holder gets its content address, where it printed `#id`, which pastes
  back to the first.
- **`geml-media/v1`: a video or audio asset has its file's duration, written
  or not.** `media-duration-required` is for a cut on a still image or on
  prose; a song or a take with no `duration=` no longer makes every cut on it
  an error, so a timeline that only plays its cuts in order — a playlist —
  needs no lengths. A cut with no `out` runs to the end of its source, and
  whatever lays the timeline out reads that from the file. The reference
  required `duration=` on the asset and ignored a cut's `out`, where the Rust
  crate took `out` but also required one or the other; the profile's case pins
  the rule. An asset with no `kind` takes it from its extension, in any case,
  by a table the profile now spells out — the reference read only image
  extensions there, and `media import` a shorter list than the crate.
- **`geml-media/v1`: a cut fits its track, and a single source is a cut.** A
  `video` track takes a `video` or `image` asset, an `audio` track an `audio`
  asset, a `prose` track a `media-text`; anything else is `media-src-not-asset`,
  and reported alone. A `media {src=}` must name a `video`, `audio` or `image`
  asset, and on a still says how long it lasts. A still or prose needs a cut's `duration=`
  whether or not the cut's track is declared. The reference checked none of
  this — it took any asset on a `video` or `audio` track, never looked at a
  single source's `src`, and skipped a cut on an undeclared track — and the
  Rust crate took a model or an `other` file as a single source; two profile
  cases pin the rules.
- **`geml-media/v1`: a timeline is its body.** A `media` with a body is an
  assembly and one without, given a `src=`, a single source; a body is
  anything between the fences but `%%` lines, so a note with no cut yet is an
  assembly, and a comment beside a `src=` is not a body. A cut is a direct
  child of a `media` body, a layer and an interaction of a `media-comp` body;
  one anywhere else is `*-unassembled`, reported for that alone, and the
  timeline layout under `geml media`, the viewer's player and export leaves it
  out. A timeline's tracks are its own `tracks=`: `tracks`, `primary` and
  `fps` are no longer `=== meta` keys of the profile. The reference read the
  shape from the cuts, owned a cut, a layer or an interaction at any depth and
  checked a stray one's references too; the Rust crate counted a `%%` line as
  a body and read `tracks` from the document's `meta`. The three shape and
  assembly codes join the profile's diagnostics table; three profile cases pin
  the rules.
- **The browser extension plays an audio timeline as a playlist.** A
  stylesheet rule `component=playlist` turns a `geml-media` timeline into a
  track list with one player, previous and next, shuffle and repeat (off, all,
  one). It reads no lengths and fetches nothing until a track plays. Shuffle
  and repeat are how one listens, not what the document says: the rule sets
  where they start (`shuffle=on repeat=all`) and the panel's buttons change
  them. `tools/media-page.mjs` writes the same panel as one static page, with
  asset URLs relative to it. *(`viewer-v1.3.7`, on its own track.)*
- The browser extension and the VS Code extension carry this parser, so the
  Markdown outline, the listing and the empty-id rule reach their previews
  too. *(`viewer-v1.3.7` and VS Code 1.1.6, on their own tracks.)*

## [1.12.2] — 2026-10-04

- **Security audit, round 6 — what a document or a tool call could make run or
  read.** The MCP write tools wrote any file under `--root`, and `.git/config`
  takes an appended `[core] fsmonitor = "<command>"` as valid GEML: one
  `geml_add` from a model a web page had steered answered `ok`, and git ran the
  command on the next `git status`. Writes land only in `.geml` and `.md`
  documents now, judged on the real path, before any sidecar is touched. `geml
  get --view`, the `--to md` embed expansion, MCP `geml_get` and the media
  profile's reads and hashes confined a target by its spelling, so a `.geml`
  symlink committed inside the tree read `/etc/hosts`, and a media check
  reported the SHA-256 of any file on the machine — or hung on a FIFO; §9.4's
  real-path rule, which the check and `--to html` always followed, holds on every
  read. `media build` spliced a clip's `gain` into the ffmpeg filtergraph as
  written (`0dB[mid];[mid]volume=0.3` opened a chain of its own) and handed each
  asset's `src` to `-i`, where `concat:a.wav|secret.wav` pulled in a file the
  timeline never declared: a gain is a dB value or nothing, and every input goes
  through ffmpeg's file protocol after the CLI confirms it is a regular file
  inside the media root. A labeled close with no space, `===#c`, which §3 and
  `fences.json` admit, ended a block for the model but not for `list`, `get`,
  `set` or meta collection, so a `--body` could close `#c` early and plant an
  `embed` the write guard never saw; every walk asks one test now. The VS Code
  extension started the CLI in an untrusted workspace, by a name the document's
  folder could answer — a configured `npx @geml/geml` ran the cloned repository's
  own package, and on Windows cmd.exe found a committed `geml.cmd` first; it
  starts nothing until the folder is trusted, resolves the program to an
  absolute path from absolute PATH entries, and refuses package runners. The
  IntelliJ plugin takes the same rules, and its preview no longer lets a
  document link navigate the pane to a page that the editor's buffer is then
  posted to. The Obsidian vault script ran `geml` through cmd.exe with vault
  file names in the command line. A codemap recipe trusted in one repository ran
  byte-identical in any other; trust is filed under the codemap directory's real
  path now, so **existing approvals are dropped** and are given again with
  `geml codemap refresh --trust` or a rebuild. And the browser extension's code
  graph appended a `<script>` for its search index from the content script,
  where it runs in the page's world: a `.js` beside a `.geml` executed; a file://
  graph has no search box now.
- **Security audit, round 6 — what reached a reader.** In a Markdown file,
  `[[javascript:alert(document.domain)//#x]]` rendered as a live link labelled
  `x`; a wikilink naming a scheme stays text, as it does in a `.geml`, and the
  renderer gates every auto-reference href as it gates links. `--to md` escaped
  only the backslash, the backtick, `*`, `_` and brackets, so GEML prose — which has no raw HTML — exported
  `<img onerror=…>` as a live tag, and a code span holding a backtick closed
  itself; `<` and `&` are escaped, code spans outgrow the backticks they hold,
  `<` in math is `\lt`, and destinations percent-encode spaces and angle
  brackets. (A Markdown file read and exported again now shows its raw HTML as
  the text GEML reads it as.) A codemap palette accepted `url(…)`, which made a
  published map fetch a third party; it keeps colours only. The browser
  extension read `/\host`, `\\host` and `\/host` as local paths, which the
  browser resolves to another host: such media loaded without the click-to-load
  gate and such links went off-site. Its player gave a media asset's `src` to a
  `<video preload=auto>` with no origin check; it loads only same-origin (or,
  on file://, same-directory) assets, and only their metadata until play. A
  link with any `target` gets `noopener noreferrer`. Hidden blocks and headings
  went to the translator — in VS Code, the editor's language model; they stay
  home. A refusal's text could carry the document's `translate-to` into a live
  link in the extension's own bar; only a link the host sets is linked, and a
  value that is not a language tag is refused unrepeated.
- **Security audit, round 6 — work a small document could demand.** Each of
  these held the parser for seconds to minutes, or threw a `RangeError` through
  `parse()`, from kilobytes of input: an unclosed `{` after every link (quadratic
  rescans); edn, json and yaml data nested thousands deep (bounded at 200, a
  `data-parse` diagnostic); a yaml block scalar of 130k lines and a long `- k:
  v` sequence; `geml list` and `find` over tens of thousands of blocks;
  coordinates, projections and links that re-read and re-parsed their target
  per reference, including a document naming itself; the transclusion cycle
  walk re-selecting a whole target at every step; views written consumer-first,
  resolved one link per sweep; every `=== x\` line folding the rest of a run of
  them; a media prompt projecting itself, or projecting the next block four
  times sixteen deep, which spelled out 4^16 characters; and the stylesheet
  loader, `--to md` and `--view` expanding embeds to the depth bound with no
  total, which is K^16. The three expanders stop at the renderer's 1000
  expansions and say so, and a prompt counts every projection it expands
  against the same 1000.
  Twenty one-line views over one million-cell table held twenty copies of it —
  2.6 GB from 2 MB of input — and a `table {src=big.csv}` written twenty times
  read the file twenty times: every relation a document reads from elsewhere now
  spends from one budget per document, 4,000,000 cells in both implementations,
  and is refused before the read or the copy once it is spent (§9.2).
  History verification remembers unit hashes by text while it replays a patch.
  In the browser extension, a timeline ruler drew one tick per second of a
  duration the document chose; it draws at most 200. The VS Code heading
  grammar and the IntelliJ lexer backtracked cubically on a heading with a long
  run of blanks.
- **Security audit, round 6 — the Rust implementation.** The same audit read
  `geml-parser-rs/`, which others may deploy. A JSON string escaping a
  multibyte character panicked, and so did a `printf` precision near
  `usize::MAX`; `\u+041` read as `A`. Views sourcing each other, `yaml`
  sequences, expressions and inline nesting across links each recursed without
  a bound until the stack overflowed, and so did a stylesheet's frame graph. A
  media prompt, a stylesheet's embeds and a transclusion step re-expanded their
  targets at every occurrence; prose addresses, unresolved references, `meta`
  keys, unmatched link and wiki brackets, folded `===` lines, unmatched ```
  openers and a heading's code spans were each the square of their input; a
  history patch re-hashed every unit after every operation. Each is bounded or
  linear now, with a regression test that fails without the fix. The example
  host hashed a media file outside its root. The crate also follows every rule
  above: its bounds come from `src/bounds.rs`, which `tests/bounds.rs` reads
  against the specification's tables; data values nest 200 deep in `json` and
  `yaml`; tables and views keep the million-cell bound; a view that cannot be
  derived is empty; the media checks place cuts on the profile's time model;
  a history sidecar's shared ids and second `current` are errors; and the
  profile cases' `checks` are compared natively and as WebAssembly.
- **Security audit, round 6 — CI and the supply chain.** The website workflow
  checked the site out with its write deploy key and kept it on the runner
  through `npm ci`, every install script and an unpinned `npx`
  scip-typescript; the viewer release kept a `contents: write` token through
  `npm install` and the test suite. Each publishing workflow — website, viewer
  release, npm, VS Code, and the Logseq mirror's — is now a job that installs
  and builds with no secret and keeps no credentials, and a job that holds the
  secret and runs no package. scip-typescript, vsce and ovsx run at exact
  versions; the `mcp-publisher` download is checked against its published
  SHA-256; every action is pinned to a commit again.
- **Security audit, round 6 — what the specification now says.** Where the
  audit found two implementations free to differ, the rule is written down and
  the suite pins it. Every number the specification fixes stands in one table in
  §9.2 — `chain-depth` 16, `data-depth` 200, `table-cells` 1,000,000 and
  `nesting-floor` 64 — and the text names it instead of restating it; the
  reference implementation's own nesting bounds moved to the parser guide. A
  `data` body's value tree is at most `data-depth` containers deep in every
  engine, `data-parse` past it (§3.2); a `table` or `view` holds at most
  `table-cells` cells, padded ones included, and one that would hold more is the
  new `table-too-large` error and keeps no rows (§6). Both are fixed rather than
  implementation-defined, because what they refuse is in the model. The suite's
  cases on the edges of these bounds, two new ones on a `view` chain's
  `chain-depth` among them, carry a `bound` field and are made from the table by
  `test/conformance/_bounds.mjs`; `test/bounds.test.mjs` fails when a copy of the
  specification, an implementation or a case drifts from it. The Chrome viewer
  and the VS Code preview followed a transclusion chain, and prefetched a
  stylesheet's, only 8 deep; they now follow `chain-depth`, as §9.3 requires.
  A view whose relation cannot be derived — no `src=`, a source that resolves to
  nothing or to no relation, a chain that meets a cycle or runs past
  `chain-depth` — is empty, no columns and no rows, and each view whose chain
  meets a cycle is reported, the cycle's own and those running into it (§6.1,
  Appendix A). A renderer that confines `src` judges it by the URL a user agent resolves, so
  `/\host` and `\\host` are another origin (§9.4). `geml-media/v1`: an
  asset's `src` is a relative path (`media-src-not-relative`), a cut's `gain` is
  decibels with the unit (`media-gain-invalid`), and every time, a cut's end
  included, is at most `max-time` (`media-time-out-of-range`). The profile's two
  numbers, `max-time` 86,400 s and `apart-tolerance` 2 px, stand in a table of
  their own (§8.1); its conformance cases carry a new `checks` field for what its
  own checks report, and `bound` on the two made from that table. A prompt's
  projection of a block already being expanded contributes nothing to the text
  `prompt-sha256` hashes, and a processor may bound the projections one prompt
  expands (§6). An asset's current value is its file's SHA-256, not its
  declared `sha256` — the reference compared the file and the Rust crate the
  attribute; a file that cannot be read gives none, and its lineage is not
  checked; staleness is judged only on the entry matching the current value,
  where the reference fell back to the latest; and hashes compare without regard
  to case (§6). A profile case may carry `files`, read beside the document.
  `geml-style/v1`'s frame depth is the core's `chain-depth`, and its cases on
  that edge are made from §9.2's table like the core's.
  A view's column lists — `select=`, `by=`, `order=` — take names, single-quoted
  when a name holds a comma, and an `order=` key's direction is only a last
  `asc` or `desc`; a spreadsheet letter is a reference inside a §6 expression
  and nowhere else, `AA` the 27th column. An entry in error is reported and the
  rest of its attribute still applies: a `select=` or `order=` entry contributes
  nothing, so a `select=` with none valid leaves the view no columns; a
  `compute=` or `aggregate=` formula in error still adds its column, empty, and
  is reported once rather than once per group; a `summary=` entry in error
  leaves the row standing; `by=` and `where=` apply whole or not at all (§6.1).
  The two implementations disagreed on most of these. §9.2 now asks a processor
  to bound the cells one document reads into its relations from anywhere but
  its own text; the bound is implementation-defined, and a relation past it is
  `table-too-large`.
  `geml-translator/v1`: nothing hidden is sent to an engine.
  `geml-history/v1`: an id shared by two revisions, keyframes or blobs, or a
  second `current`, is corruption — the same sidecar used to reconstruct one
  text in a processor that took the first and another in one that took the
  last, and verify clean in both. A unit's id is the one its attribute object
  declares: the reference keyed `{src=#foo}` as `#foo`, where the Rust crate
  read the block's own id. The profile's new `sidecars` cases pin it.
- **The CLI's output through a pipe is complete.** Every verb ends with
  `process.exit`, which dropped whatever a piped stdout or stderr had not yet
  written: `geml check` behind a slow reader delivered under nine hundred of
  eight thousand diagnostics. The CLI writes blocking now; `geml mcp`, a
  long-running stdio server, keeps Node's queued writes.

## [1.12.1] — 2026-10-03

- **A link's text and its destination end where CommonMark's do.** A link's
  text and an image's alt run to the `]` that balances the `[`, a bracket inside
  a code span, inline math or a backslash escape not counting, so
  ``[a`]`b](x)`` is a link; the destination balances its parentheses on one
  line, `\)` not counting, and is kept as written. The reference parser counted
  every bracket and let a destination run across a line end, so such text made
  no link there, or a different one; §5.3 states the rule and
  `precedence.json` pins it.
- **What a third implementation needs to read a document the same way, stated
  and checked.** Running both implementations over every document in this
  repository and the site found readings the specification left open; each is
  now a rule in the text and a case in the suite. An attribute object on a fence
  line runs to the line's last `}`, a heading's is found leftwards from its
  final `}`, White_Space separates items, and a `"` groups rather than
  delimits, so `src=#t[1]["Q 1"]` needs no outer quotes; an object after a
  link or an image closes at the first `}` outside quotes; of a repeated id or
  key the first is read; a fold's whitespace
  collapses into one space; `$$` opens no math; an id-less `meta` block anchors
  prose as `#meta` when it is the only one, and a gap of `%%` lines is no
  prose; a projection's target may hold `%%` lines but is never a stretch of
  prose; a data file that cannot be read leaves the table empty, and a remote
  one leaves it with no model at all, a view, a chart or a coordinate reading it
  deferring with it — so a coordinate into a remote table or `data` block is no
  longer an `unresolved-reference` error, and the page and the Markdown export
  name the source where the rows will come from; every relative
  path a document names resolves against its directory, then the root; a
  transclusion chain steps only through the content each target selects,
  follows projections as well as embeds, and is reported once per line. The
  suite gains a `host` capability and `documents.json`, whose cases give a file
  tree; its README says the specification decides wherever a case and the text
  differ, and what the specification leaves to the implementation stays out of
  the cases. The media profile says so of one such choice: whether a check
  repeats the diagnostics of the documents it reads is the processor's.
- **The style profile arbitrates the same way whatever order the rules are read
  in.** Of the rules setting an attribute, the ones no other contains decide,
  and the first written of those holds it; across `when=` sets the holders are
  compared all at once. A binding names its rules `#id` or `[n]`, a stretch of
  prose is one node named by its prose address, the bindings' order and empty
  variants are fixed, and variants come fewest `when=` entries first. The step
  before an inline part matches the node that owns it, not an ancestor of it,
  and a node has a part only when it holds an inline of that kind; a heading an
  ancestor step matches is a `heading` with its level, which an author's
  `level=` does not override; `caption` and `hidden` keep their core meaning on
  every style block; a closed-domain value outside its domain is dropped.
  Loading is stated too: a stylesheet's `embed` selects what the core's `embed`
  selects, `part=` included, a bare `#id` naming a target in its own file and a
  relative path resolving against that file's directory, then the root; style
  blocks and `embed`s count wherever they stand; an embedded file brings its
  own `default-style`; the entry is on the expansion chain from the start, so
  naming itself as its default is a cycle read once. A rule whose `match=` is
  one bare `#id` naming a screen or a frame dresses it, merged by §4, and the
  view model's screens and frames carry `params`, `box` and `variants`; a
  container can produce a state. The corpus takes in each GEML document an
  `embed` in it names, whole and once, in the order met — `geml style check`
  and the browser viewer alike — and `geml style check` follows these rules
  through a loader that resolves each path from the file naming it. The
  conformance file gains `views`: thirty-four cases, each a file tree with a
  stylesheet and a corpus, whose whole view model must be reproduced. The
  browser viewer places a stretch of prose as one unit.
- **GEP-0008's structural rules are checked.** With `geml-form/v1` declared, a
  `form-*` block outside a `form` — a field not directly in a form or a group,
  a group inside a group, an options list or a note anywhere but directly in a
  form — is `form-child-outside-form`; a `form-field` without `name=` is
  `form-field-missing-name`, and two fields of one form sharing a name are
  `form-duplicate-name`, all errors the GEP defines, and the form profile's
  conformance file lists the codes with cases. A `form` or a `form-group`
  answers a coordinate with the field the step names — `#signup["email"]` —
  so `geml get` prints a field by name, `[[#signup["email"]]]` says its label,
  and `![[…]]`, an `embed` and `geml set` of a field are refused. The viewer's
  controls carry the name. The Rust implementation now follows every rule the entries
  below settle: CommonMark code spans, the chain bound of 16, `header=` as a
  boolean, local data files read at build time whatever their suffix, `[n]`
  view-model addresses, `style-reserved-name` as the profile defines it, the
  style contest as a warning with the first-written rule's value kept, the
  form names and field coordinates, the history unit key with `~n`
  occurrences, and the media hashes with interaction lines.
- **Four more rules the second implementation asked for, decided.** A code
  span closes at the next run of *exactly* its opening length, CommonMark's
  rule: a longer run inside is content, so `` ``a`b`` `` carries a backtick
  and `` `a``b` `` is one span, not two. The parser, the heading-id derivation
  and the Markdown importer read it so; one conformance case moved from the
  old reading to the new and three pin it. A contest between two style
  rules (`style-ambiguous-rule`) is a warning, not an error, and the
  first-written rule's value is what the binding carries; the later rule's
  appears nowhere, so a build still succeeds and says where order decided.
  GEP-0008's fields carry a mandatory `name=`, unique within their form, and
  a field is addressed with GEP-0011's coordinate — `#signup["email"]` — so
  it needs no id; a field without a name, or two fields of one form sharing
  one, is an error (`form-field-missing-name`, `form-duplicate-name`), and
  `[[#signup["email"]]]` says the field's label, `geml get` prints the field,
  and a projection of a field is refused. The scoped-id design
  (`#signup#email`) is recorded under the GEP's alternatives. The history profile fixes the unit key a
  sidecar uses — `#id`, else `@` and eight hex digits of the unit's SHA-256,
  `~n` on repeats — and the parser follows it where it did not: a block closed
  by its labeled fence is one unit, an id is any NAME, and a heading's
  explicit `{#id}` keys its segment. A sidecar written under the earlier
  tool-defined keys does not read back; this repository's was rebuilt under
  the rule, every revision id and hash unchanged.
- **The specification states what the reference parser enforced.** Writing a
  second implementation from the text alone exposed rules the parser applied
  and the specification never said. The text now says them. A data-form
  table's first row is its header unless `header=false`; a headerless table
  letters its columns as a spreadsheet does, `AA` after `Z`. A local data file
  named by a table, a view or a chart is read at build time and its columns
  are checked then; only an `http(s)` source defers to the renderer, and the
  file's suffix no longer matters — `format=` decides, a view's or a chart's
  file is `tsv` by suffix and `csv` otherwise. `unresolvable-table-source`
  covers a view's or a chart's file as well as a table's and a disallowed
  scheme, and `table-source-not-a-table`, which nothing ever emitted, leaves
  Appendix A and the parser's catalogue. A media
  embed may name `data:image/…`, and only a media embed. A change of
  list-marker kind ends a list. A `meta` value with spaces needs no quotes. A
  blank line inside a ``` pair still ends a paragraph. An `embed` of a target
  in its own document is not a cycle, and the cycle rule is stated per
  document. The bound on a transclusion or `view` chain is a fixed 16 — it was
  the reference's own 8, written nowhere — and the renderer, the style
  checker's embed expansion and the media checker's prompt expansion follow
  it. The media profile defines the bytes `prompt-sha256` hashes, interaction
  lines included; the style profile catalogues `style-reserved-name` and names
  an id-less block `[n]` in the view model; the codemap profile says which
  edge-table cells are plain text.
- **A second implementation, in Rust and WebAssembly.** `geml-parser-rs/` is a
  GEML 1.0 parser written from the specification and the conformance suite
  alone, without reading the reference parser. It passes all 376 cases with
  every capability the manifest names declared, natively and as WebAssembly
  through the suite's own `_runner.mjs` and `_project.mjs`; reports Appendix A's
  codes with their severities; and holds lines, regions and functions at 95%
  coverage or more. CI runs it in a `parser-rs` job. It recognizes the six vocabularies under
  `spec/profiles/` and runs their checks: form, media (all 33 codes, lineage
  across documents included), style (the view model), history (sidecar
  verification and reconstruction) and codemap; every profile conformance file
  passes in both readings, and the style view-model cases with them. A host resolves references into other documents and
  reports file hashes, and the WebAssembly build exposes it as `parseIn`,
  `styleCheck`, `historyVerify`, `historyReconstruct` and `codemapVerify`.
  Through the host it also reads the files a document names — code routes
  with their ranges, `data` routes into the block's value, the data files of
  tables, views and charts — and follows transclusion chains across
  documents, reporting `transclusion-cycle`.
- **Stopping `geml codemap` or `geml mcp` stops what it started.** Both run
  their program as a child, and a signal sent to `geml` alone, such as a
  supervisor's SIGTERM or a test's kill, ended `geml` without it: `codemap
  serve` kept listening with no parent, on a port the next run might pick.
  Every signal that would end `geml` is now passed on to the child, and `geml`
  exits with the child's status. `geml mcp` went down with `geml` only because
  its stdin closed; in a container `geml` is PID 1, for which Linux takes no
  default action on SIGTERM, so `docker stop` waited out its timeout. A
  server stopped by a signal also takes its token out of the temp dir, which
  only a normal exit did. Windows has no signals to pass on; there, stop the
  process tree.
- **The Chrome extension lives in `integrations/chrome-geml-viewer`**, renamed
  from `integrations/geml-viewer` so the directory says which browser it is
  for. Its name, its package name, the release zip and the `viewer-v*` tags are
  unchanged; the workflows, Dependabot, the VS Code, Obsidian and IntelliJ
  builds that import its renderer, and the docs follow the new path.

## [1.12.0] — 2026-10-02

- **`geml_find` walks a directory named in `path`.** The tool says a
  directory narrows the search, and `path: "docs"` answered `not a file:
  docs`: the gate in front of it admitted files only. A directory now passes
  the same confinement check a file does, and one above the root is still
  refused.
- **`delete` takes the blank line that separated the block.** `add` puts one
  blank line between new content and its neighbours, and `delete` left it
  behind, so deleting what was just added grew the file by a line. Each removed
  block now takes one separating line with it: the one after it when blank
  lines stand on both sides, the one at the document's edge otherwise. An add
  followed by a delete leaves the bytes as they were; spacing beyond one
  blank line stays as the author wrote it. The MCP tool runs the same verb.
- **A coordinate reference says what its inline projection says.**
  `[[#v[1]]]` read a row in its body's own form — `| y | b |` for a view or a
  pipe grid, `a; b` with `delim=;` — while `![[#v[1]]]` read `y, b`. Both now
  read the cells joined by ", " (§5.2). A whole column or a non-leaf value-tree
  node still resolves and links to its block, but carries no value.
- **Derived heading ids follow §4 to the letter.** A double-backtick code span
  left its content in the id (`## Use ``x`` here` derived `#use-x-here`); every
  code span is now deleted as §5.3 recognizes one. Whitespace is the Unicode
  `White_Space` property, so U+FEFF is deleted rather than separating and
  U+0085 separates.
- **A `data` value stays inside I-JSON (RFC 7493).** A name twice in one
  object, a lone surrogate, a number past binary64's range are `data-parse`
  errors in json, jsonl, yaml and edn alike (§3.2) — JSON.parse kept the last
  name silently and made `1e400` null.
- **A table row of the wrong width says so.** Extra cells were dropped and
  missing ones padded silently; both now raise the new `ragged-table-row`
  warning naming the row (§6, Appendix A).
- **`\|` is a literal pipe in a visual table cell**, code spans included, as
  on GitHub; `geml set` writes `|` as `\|` instead of refusing it (§6(a)).
- **A cell's text is trimmed of `White_Space`.** `trim()` matched no Unicode
  property (it removed U+FEFF, kept U+0085); a coordinate write keeps the same
  set as padding (§6).
- **Display formats are one exact subset.** `%d` rounded ties toward +∞
  (`-2.5` → `-2`) while `%.0f` gave `-3`; both now round ties away from zero.
  `%g` keeps N significant digits (it ignored N), `%e` writes two exponent
  digits, any other `%…` form stays text, a precision past 100 is held at 100.
  The unformatted display is now written in §6.
- **Prose inside a typed block's flow body has an address** —
  `#outer-before-a`, `#a-between-b`, `#outer-after-b` — listed, readable and
  writable with get/set, and a reference to it resolves (§4). It had no address
  at all before, not even a content one.
- **`--to md` puts one backslash before a cell's pipe.** The exporter doubled a
  backslash run first, so a code span holding `x\|y` came out as `x\\|y` on
  GitHub; `--from md` now reads the row back exactly.
- **The conformance suite is language-neutral.** `manifest.json` +
  `_runner.mjs`; optional `ids`/`addresses`/`blocks`/`diagnostics` and
  `geml_base64`; tables and views project as relations; new files ids,
  normalize, blocks, addresses, yaml; profile files state diagnostics as code
  multisets.

## [1.11.6] — 2026-10-02

- **In a Markdown file, a renamed heading takes the anchor of its new text.**
  A Markdown heading's anchor is its text, so `set` that changes a heading's
  text no longer stamps `{#old}` onto it — GEML syntax, which GitHub prints.
  The heading takes the id its new text derives where it stands (a repeated
  title gets GitHub's `-1`), and the page's links to the old id follow in the
  same write: inline links, ones with a title, and reference definitions; not
  code spans, not fences, not another anchor that shares the prefix. `set`
  says `#old is now #new`. `rename` refuses a Markdown heading's derived id
  and says how to rename it instead, rather than failing on the links it had
  rewritten. A heading in the file that declares `{#id}` is GEML syntax and
  keeps GEML's rule. In a `.geml` nothing changed: a renamed heading keeps its
  declared address, and `rename` answers as before.
- **GEML written into a Markdown file lands as Markdown.** `set` and `add` on
  a `.md` convert content that is GEML — a `=== type` block, a heading with
  `{#id}` — as `--to md` converts it: a note becomes a blockquote, a table a
  pipe table, `## Risks {#r}` plain `## Risks`. The write says so and names
  what was lost. Such content had landed as written, GEML syntax that GitHub
  prints as text. Content Markdown cannot hold, such as a view whose source is
  not in it, is refused. Markdown content still lands byte for byte, a GEML
  block already in the `.md` stays GEML when it is replaced, and a `.geml` is
  not converted.
- **A Markdown link's title is a title.** `[t](#x "Title")`, `'Title'` and
  `(Title)` link to `#x`, and `[t](<#x>)` does too; read whole, the title was
  part of the target and every such link was reported broken. A `.geml` reads
  a link's parenthesis as it always has — GEML has no link titles.
- **The MCP server reads a `.md` as Markdown, as the CLI does.** `geml_check`
  and the validation every write runs before it lands parsed a `.md` with
  GEML's grammar, so a README the CLI checked clean failed there with dozens of
  errors (`{{brand}}` as a meta reference, `<a id>` anchors unseen) and an edit
  to it could be refused for errors it never had. A `.geml` is validated as it
  was.
- **MCP write results carry the verb's notes.** A write that went through and
  did something worth saying — dropped the blocks a shortened section held,
  moved a heading's address — returns it as `notes`. `geml_set`'s description
  promised the dropped blocks would be named, and the result did not name them.
- **MCP tools declare annotations, and their descriptions say how they fail.**
  Each of the eleven tools — and the four code-graph tools — now carries a
  `title` and MCP annotations: the six reads and the graph tools are
  `readOnlyHint`; `geml_add` and `geml_rename` write without destroying
  anything; `geml_set`, `geml_delete` and `geml_revert` are `destructiveHint`;
  none is open-world. A client can now tell a read from a destructive write
  without reading prose. The descriptions were reworked against Glama's tool
  review: every one says what happens when its target is missing, the write
  tools state their result shape once (`{ok, file, diagnostics, revision}`, a
  refusal with a `hint` and the file unchanged), `geml_add`, `geml_delete` and
  `geml_get` name the sibling to use instead, and `geml_find` and `geml_set`
  are shorter. Nothing a tool does changed.
- **`LICENSE` is the MIT text and nothing else.** A note had been appended
  below it saying which parts of the repository the MIT license covers, and
  that was enough for GitHub — and every listing that reads its answer — to
  report the license as "Other". The scope it described is in the README's
  License section, which says the same thing; the package's `LICENSE` and the
  six plugin copies are the plain text again.
- **A `Dockerfile` runs the MCP server.** It builds the parser from the
  checkout and starts `geml mcp --root /workspace` on stdio, which is what MCP
  directories such as Glama build to inspect a server's tools; `docker run -i
  -v "$PWD:/workspace"` gives a local client the same thing.
- **The GitHub-anchor scan reads tags in one pass by hand.** The text a
  heading's GitHub anchor is slugged from had its tags removed with two
  regular expressions, a shape code scanning reports as an incomplete
  sanitizer even though the result is only ever slugged. A scanner does the
  same work; its output matched the old one on 711,111 inputs, and every
  anchor checked against GitHub's renderer still resolves.
- **`get` and `set` say how much of the file they touched.** A read ends with
  `read 1.5 KB of 50.7 KB (3%)` on stderr, and the `wrote` line of a `set`
  reads `wrote README.md — 10 B changed, 50.7 KB of 50.7 KB untouched`, so what
  addressing saves shows on the first call rather than in a benchmark. The
  counts are UTF-8 bytes. stdout is unchanged. The listing, `--json` and
  `--view` print no read line, since none of them is a slice of the file named;
  a `set` whose document goes to stdout prints its line on its own. The MCP
  tools' results are unchanged.

## [1.11.5] — 2026-10-01

- **An embed on the line after its target is not a cycle.** The self-cycle
  checks read a span's `end` as the block's last line, but it is the first line
  after it — the half-open span `geml list` prints. An `=== embed {src=#q1}` or
  a `![[#t]]` written right under its target's closing fence, with no blank line
  between, was reported as `transclusion-cycle`. An embed or a projection inside
  its own target is still one.
- **An embedded view keeps its rows in `--to md`.** The Markdown export expands
  an `embed` from a slice of the target document, and the slice holds the view
  but not the table its `src=#id` reads: the view came out as an empty grid
  ("table from external source `#fy` could not be read") where `--to html`
  shows its rows. A relation whose same-document source the slice lacks now
  takes its rows from the whole document, for an embed in the same document and
  across documents alike.
- **A whole row may be projected; a whole column may not.** §5.2 allowed only a
  leaf value as a projection target, yet `check` passed any slice:
  `![[#fy["revenue"]]]` put a newline into the sentence, and
  `=== embed {src=#fy[2]}` passed `check` but rendered as a dangling link. A row
  — `#fy[2]`, `#fy[summary]` — now projects inline as its cells joined by ", "
  on one line, and as a block embed renders a one-row table under the table's
  header, in `--to html`, `--to md` and the browser viewer alike, across
  documents too. A whole column, or a value-tree node holding more nodes, is
  `inline-transclusion-not-inline` inline and the new
  `embed-target-not-projectable` as an embed's `src=`, and the message says what
  to use instead.
- **A coordinate on an `embed` names the address that resolves.** §5.2 makes
  `#tbl[1]["Item"]` on an embed an `unresolved-reference` error and says the
  diagnostic SHOULD name the same coordinate on the embed's source; the message
  only explained why. `get`, `set`, `check` and the MCP tools now end the
  refusal with that address — `a.geml#tbl[1]["Item"]` for `src=a.geml#tbl`,
  `#src-tbl[1]["Item"]` for a same-document `src=#src-tbl` — and `check`
  rebases it onto the referenced document when the embed lives there. A
  whole-document embed (`src=a.geml`) has no block to start from and keeps the
  bare refusal.

## [1.11.4] — 2026-09-30

- **A `.md` link to GitHub's anchor for a heading resolves.** §4's heading-id
  derivation and GitHub's slug part ways on three points: §4 deletes a code
  span, folds a run of whitespace into one `-` and drops diacritics; GitHub
  keeps code text, turns each space into its own `-` and keeps `é`. So
  `## C++ & Rust` is `#c-rust` to GEML and `#c--rust` on GitHub,
  ``## `geml get` in 5 minutes`` is `#in-5-minutes` and
  `#geml-get-in-5-minutes`, and a README contents table written against
  GitHub failed `check` on every such link. Under Markdown reading GitHub's
  anchor is now a link target too — slugged from the heading's rendered text
  (link text without its URL, no emphasis markers or HTML tags, no closing
  `##`, a trailing `{#id}` kept as the text GitHub prints), with
  github-slugger's `-1`, `-2` for a repeated one — for `check` and for the
  write gate. Like an `<a id>` anchor it is a target and not an address:
  `get`/`set` still take the heading's §4 id, which is unchanged, and a
  `.geml` reads §4's id alone.
- **A `.md` link to an `<a id>`, `<a name>` or `<span id>` anchor
  resolves.** Many READMEs anchor their sections with raw HTML —
  `<a id="why-now"></a>` — because
  Markdown has no way to name a place, and GitHub follows every
  `[Why now](#why-now)` that points at one. Read as the text GEML keeps raw
  HTML as, each of those links was an `unresolved reference` error: this
  repo's own `README.md` checked with 16 of them and `README_CN.md` with 17,
  all false, and the same errors stood in the write gate. MinerU, which turns
  PDFs into Markdown for agents, anchors each page footnote the same way with a
  `<span id>` — `[\[1\]](#note-one)` — and a footnote added in that shape was
  refused. Under Markdown reading an `<a>` element's `id`, or its legacy
  `name`, and a `<span>`'s `id` are now link targets for `check` and for every
  write that re-checks the document. Those two elements and no others: GitHub
  keeps an `id` on more, but each one added is another case to get right, and
  these are the two real documents anchor with. It is a target and nothing
  more: not a block, not an id `get` can address, and the HTML
  still renders and converts as the text it was. An element inside code (a
  fence, an indented block, a code span) or an HTML comment is not an anchor,
  and `data-id=` or an `id=` inside another attribute's value is not an `id`.
  A `.geml` is untouched: GEML has no raw HTML (§8.2(9)), and there the same
  line is prose. Both READMEs now check clean.
- **`geml find` takes a pattern that starts with `-`.** A Markdown list
  item's own text begins `- `, and that was the one pattern `find` could not
  take: as a bare argument it read as an unknown flag, and `--` was refused
  on every verb. `find` now honours `--` — everything after it is an operand,
  taken as text however dash-shaped (`geml find -- '- list item' notes.md`),
  and a `--json` or `--help` after it is searched for rather than obeyed.
  An unknown flag on `find` now also says where such text goes. Every other
  verb still refuses `--` with the `./<name>` alternative: their positional
  scanners step over dash-arguments, so the marker would be dropped silently.
  MCP's `geml_find` was never affected — it passes the pattern straight
  through. The two benchmarks under `docs/benchmarks/` now pass `--` before
  their phrase: in `addressing-cost.mjs`, 2 of today's 11 phrases begin with
  `- `, so arm B had been charged a refusal message for a search that never
  ran (131 bytes more than the real output; the printed ratios move from
  1.79× to 1.80× input and stay 7.49× for saying where).
- **geml-media: a library without a generation log is refused, not a crash.**
  `geml media log`, `geml media import <manifest.json>` and
  `geml media compose --log` append to the library's
  `data {.gen-log}` block, and when it had none — or it was never closed —
  each one died with a Node stack trace. `compose` had already run ffmpeg by
  then, so the image sat on disk unregistered. Each verb now checks the
  library before it does anything, `compose` before ffmpeg runs, and refuses
  in one line (exit 2) that names the empty block to add.
- **The title is a heading in both projections.** The spec keeps a document's
  title in `=== meta` (`title = "…"`, the §4 style note) so that every heading
  is a section; Markdown and HTML readers expect the title as the first `h1`
  and sections from `h2`. `--to md` wrote the title into YAML frontmatter only
  (a table on GitHub; a stray rule plus a setext heading in renderers that do
  not know frontmatter) and left the sections at `#`, so the first section's
  name read as the title. Now `--to md` writes `# <title>` under the
  frontmatter and moves every body heading down one level; `--to html` opens
  the page with `<h1 class="geml-title">` and does the same (`<title>` is
  unchanged). An author whose first heading already reads the title —
  `# {{title}}` — has written the title heading: nothing is added and nothing
  moves, so a page never says its name twice. No heading is counted: one
  level-1 heading or six, the meta decides. Borrowed content (`embed`) takes
  the host's shift and brings no frontmatter or title of its own. The return
  trip (`geml notes.md`) recognises exactly the shape `--to md` writes —
  frontmatter `title`, then a level-1 heading of the same words — drops the
  echo and moves the headings back up, so `geml → md → geml` keeps the title
  in meta and the sections at level 1. So does the shape Jekyll, Hugo and
  Docusaurus write — a frontmatter `title` over sections that start at `##`,
  with no level-1 heading anywhere in the body: those sections sit under the
  title and move up with it, so they project back to `##` rather than being
  pushed to `###`. A heading pushed past level 6, or one that cannot rise above
  level 1, is clamped and reported in the notes. `docs/PUBLISHING.md` is
  regenerated in the new shape.
- **A write refused by an old error names that error's line in the file.**
  When `set`, `add`, `rename`, `revert` or `replace` was refused by an error the
  document already had, the refusal gave its line in the rejected candidate, so
  an edit that added or removed lines sent the reader to the wrong place: a
  replacement one line shorter reported line 6 for a broken reference that
  `geml check` puts on line 7. An error the document already had is now
  reported at its line on disk, in the sentence, in the `--json` refusal frame
  and in the MCP result alike. An error the edit introduced keeps the
  candidate's line, the only one it has.
- **Block selectors filter by attributes, and `--within` narrows get, list
  and find.** Braces holding more than a lone `#id` or `@<hex>` are an
  attribute filter: `=== code {lang=py}`, `{.warn}`, `{#id .warn}`. They are
  read with the same attribute syntax a block uses, and a block or heading
  matches when it carries every key given with the same value, so several keys
  must all hold and a selector can match 0..N blocks. A content address is one
  more condition: `=== note@2bac3f13 {#warn}` names `#warn` only while its
  content is the one that address was taken from, so a write through it is
  refused once someone else has changed the block. `--within <selector>`,
  which `replace` already took, now narrows `get`, `list` and `find` to the
  blocks another selector names: `geml get notes.geml '=== code' --within
  '#install'`. `find` counts a match by its line, so text in a section's own
  opening is inside that section, and it skips a file where the scope names
  nothing. The MCP tools `geml_get`, `geml_list` and `geml_find` take the same
  optional `within`, and `geml_get` now passes a braced selector through
  instead of reading it as an id.
- **A selector no longer drops part of what it was given.** A content address
  written beside another key, as in `=== note@deadbeef {#warn}`, was ignored and
  `#warn` came back with exit 0 although the hash was wrong; every key now has
  to hold, and a wrong hash matches nothing (exit 1). A type in front of an id
  was dropped too, so `=== code {#warn}` answered a note; the type is now
  checked the way it already was on `@<hex>`, with exit 1 when it does not
  match.

## [1.11.3] — 2026-09-29

- **geml-media: a shot composed from layers.** Two new block types,
  `media-comp` (a canvas) and `media-layer` (one image asset cropped, scaled,
  flipped and placed on it), a `composite` log mode and four diagnostics
  (`media-layer-unassembled`, `media-comp-size-missing`, `media-comp-empty`,
  `media-layer-not-image`). `geml media compose <doc>#<comp> --out x.png`
  renders one comp deterministically with ffmpeg; `--log <library>` registers
  the output and appends the entry with every layer as an input. A comp is
  hashed like a prompt — its canonical text — so moving a layer stales exactly
  the shots that used it, and `geml media todo` lists an unclaimed comp as a
  `composite` item. `geml media log` gains `--params <json>`. Design record:
  `docs/design/specs/2026-09-15-geml-media-design.md` §16.
- **geml-media: interactions.** Where two things meet is a fact of the shot:
  `points` on an image asset (named positions in its own pixels, plates
  included), `points` on the character or scene block it is `of=` (the names
  — a schema), `media-interaction` inside a comp (`a=#layer:point
  b=#layer:point kind=contact|gaze`, a prose block whose body is the beat),
  `at` on a comp for a sequence of frames, `dx`/`dy` on a layer. `compose`
  moves the later layer onto the earlier one's point; `check` and `compose`
  share one geometry (`media-compose.ts`); a moved point stales the comps that
  used it. Eight codes, from `media-interaction-unresolved` to
  `media-interaction-apart`. Design record §16.8.
- **`geml media todo` lists stale work too.** A prompt, line or comp whose
  output `check` reports as stale comes back on the list with `stale: true`,
  so a pipeline driven by `todo` regenerates what a changed look or a moved
  layer invalidated instead of only what was never made. `compose` now refuses
  a comp whose interaction names a layer or point it cannot resolve. A
  `flip=h` layer's points mirror with it (the first fight scene needed a stand
  facing the other way).
- **An entry's `output` must be an asset** (`media-gen-output-not-asset`,
  error): the first layered episode lost its key-frame blocks because the
  id check behind `compose --log` and `import` read `"#s01-key"` inside a log
  record as a block; that check now asks the parser for the document's ids,
  and a log that names a file the library does not have is reported instead
  of silently leaving every consumer of that file unable to see it change.

## [1.11.2] — 2026-09-28

- **A `.md` is read as Markdown.** GEML parses Markdown directly — that is what
  keeps a write byte-exact — and until now read it with GEML's grammar wherever
  the two disagree. An outside evaluation on a real Obsidian vault measured the
  cost: a page with two `## 小结` headings was read-only in full, a block holding
  `[[Note#Heading]]` could not be written, and every Markdown footnote was an
  error even beside its own definition. `ParseOptions.markdown` — set by the
  host from the extension — now names every place the grammars disagree and
  reads each as Markdown does. Nothing a `.geml` sees changes.
  - A repeated heading gets GitHub's suffix: the second `## Notes` is `#notes-1`,
    the anchor GitHub gives it. `set` judges the id a heading carries **in
    place**, so it no longer stamps `{#notes-1}` — GEML syntax GitHub prints as
    text — onto a heading that already has it. An explicit duplicate id is still
    an error, and §4's rule for GEML is unchanged.
  - `[^label]:` defines a footnote, and a `[^x]` nothing defines is text, as on
    GitHub: `[^0-9]` in a sentence is not a reference.
  - `{{title}}` is a template placeholder, not a `=== meta` reference — the
    reading `--to geml` already gave it.
  - `~~~` fences and indented code blocks are code, as ``` ones were; nothing
    inside is a heading, a link or a footnote.
  - `[[Note]]`, `[[Note#Heading|alias]]`, `![[Note#Heading]]` and `[[#^block]]`
    are Obsidian links. The note is found by name anywhere under the resolution
    root; one not yet written is the new warning `markdown-unresolved-wikilink`,
    which sits outside Appendix A by Appendix A's own rule for conditions the
    specification does not define. The search never leaves the root and follows
    no symlink (R7-1); below a vault's `.obsidian/`, `geml check` names the
    `--root` that resolves the rest.

  The walks behind `list`, `get` and `set` — `addressedUnits`, `blockSpans`,
  `unitSpans`, `narrowToIntro`, `sliceUnit` — take the same switch as an optional
  argument, so the parse and the addresses cannot disagree about a heading's
  name. A library caller that passes nothing reads GEML, as before.

- **`add`, `rename` and `revert` use the write gate `set` and `replace` already
  had.** In a `.md`, a defect the document already carried somewhere else is not
  the edit's doing; `set` knew that, and the other three refused while naming
  the old defect as the thing the edit broke. In a `.geml` nothing is forgiven,
  as before — and the refusal now says the error predates the edit. `delete`
  reports only the references it left dangling itself.

- **A reference reports the line it is on.** A paragraph or a list item is
  inline-parsed as one string, and every reference, footnote and `{{key}}` in it
  reported the paragraph's first line, in both formats. The evaluation's
  "reported 245, actually 249" was this.

- **A fence-like line inside a ``` pair no longer draws a fall-through
  warning.** §3.1 names two ways to keep such a line literal — the `\` escape
  and a matched ``` pair around it. The escape was always quiet; the shield was
  not, and `fence-like-line` told the author of a correct `=== note {#x}` example
  that "attributes must be braced", while `stray-labeled-fence` flagged a
  labeled close shown the same way. Both codes are for a line that fell through
  by accident, and a shielded one was put there. The shield itself is
  unchanged: after a blank line inside a pair the text is flow text again, and
  its references are checked — showing GEML as code is `=== code`.

- **`--in F` without `#src` says what it read.** When F holds no block with the
  target's id, the refusal names the stdin form that writes F's text instead.

- **A line inside a matched backtick fence no longer ends the section around
  it.** `collectSpans` computed the shield §3.1 requires but never handed it to
  `sectionEnd`, so a `#` comment in a shell sample cut its section in half, and
  a shielded `===` ran it to end-of-document. `geml check` stayed silent,
  because only the addresses were wrong. Worst on `set --body`, which replaced
  up to the phantom boundary and left half a fence behind at exit 0. Twenty-one
  documents here addressed differently before the fix.

- **`geml_get` and `geml_set` accept the `part=intro` their schemas offer.** The
  enum and the validation were separate and only the enum learned `intro`, so
  MCP refused a value it advertised while the CLI's `--intro` worked on the same
  file. One `PARTS` list now feeds both.

- **`geml_get` and `geml_set` take the `L27-58` position `geml_list` prints.**
  `selectorArg` prefixed it with `#`, turning a position into a request for a
  block NAMED `L27`. It now recognises one with `BARE_LINE`, the selector's own
  pattern; a block really named `L27` keeps its key form, `#L27`.

- **A missing required argument is refused by name.** Nothing enforced each
  tool's declared `required` list, so a forgotten field surfaced as whichever
  TypeError the verb reached first — `Cannot read properties of undefined` named
  neither the tool nor the argument. The schema and the check now read from one
  source.

- **`geml media` no longer reads a flag's value as the entry document.** The
  entry was the first argument that did not start with `-` and was not the value
  of `--root`, `-o` or `--into`, so `geml media export --to json` took `json` for
  the document, found nothing, printed nothing and exited 0; and a document named
  like some flag's value was skipped as that value. The scan is positional now
  and steps over a valued flag's value, from one table that also feeds flag
  checking — which `geml media`, a vocabulary's verb, never had: `--josn` is
  refused now, as on every core verb. `--to=json` says the value belongs in its
  own argument instead of silently falling back to the default, a boolean
  written `--json=yes` is refused instead of read as not given — which printed
  the human text where JSON was asked for — and `geml media <verb> --help`
  answers on stdout with exit 0.

## [1.11.1] — 2026-09-18

- **The core no longer names a vocabulary anywhere it dispatches.** Three places
  did. The renderer's `diagram` dispatch had `geml-code-graph` in the same `if`
  chain as the specification's own `geml-chart` and `mermaid`; the command line
  had `media`, `style` and `codemap` as branches of its own; and `=== meta` keys
  had no owner at all, so a vocabulary's parameters and a document's own
  metadata were indistinguishable.

  All three are lookups now. `RenderOptions.diagrams` is a `format` → renderer
  table the host fills — §7 always said a `format=` names a **renderer** and
  that an unknown one degrades to a labelled source block, so the extension
  point was the specification's; what was missing was that the table could be
  extended. The specification's own two are looked up first, so a host may add
  formats and may not quietly redefine one the specification defines.
  `ProfileDef.verbs` declares a vocabulary's CLI verbs and a host-side table
  implements them.

  **For a library consumer this changes behaviour**, and the CLI's own paths
  hide it: `geml … --to html`, `geml codemap serve` and `codemap render-all` all
  register `geml-code-graph`, so nothing about using the command line moves. A
  host calling `renderHtml` **directly** gets §7's labelled-source fallback
  where it used to get a graph. One line restores it:

  ```js
  import { renderHtml, codeGraphDiagram } from "@geml/geml";
  renderHtml(doc, { loadDoc, parseDoc, diagrams: { "geml-code-graph": codeGraphDiagram } });
  ``` `unknown-meta-key` reports a key that lies in a declared
  vocabulary's **namespace** and that the vocabulary does not define — only the
  namespace, because `=== meta` also carries the document's own metadata, which
  is the author's and open. An earlier draft checked the whole block and
  reported this repository's own tutorials for `chapter = "6 / 7"`.

  `geml-code-graph`'s implementation moved out too, and the measurement is the
  argument: **1683 of render.ts's 2894 lines were one vocabulary** — the
  browser-side layered layout is the larger half — and its stylesheet, 5615
  bytes, was inlined into every page this renderer produced whether or not one
  drew a graph. `code-graph.ts` holds both now; the page shell asks for the CSS
  through the same `ctx.use()` the runtime script already went through, so a page
  that draws no graph is **46% smaller**. `render.ts` re-exports the symbols,
  which is compatibility and is labelled as such: the viewer, the playground,
  `codemap/serve.mjs` and a runtime URL import written into generated HTML all
  take them from `render.js`, and moving that path is a cross-package migration
  with a string in generated output at the end of it.

- **A third party can register a vocabulary without forking the parser, and the
  switch is off by default.** `PROFILES` is a compile-time list, so "which
  vocabularies a processor recognizes is implementation-defined" (§8.6.2 rule 3)
  meant *fork this parser* in practice. `enableProfileRegistration()` plus
  `registerProfile()` opens a runtime route. Off by default because a host that
  registers one reports different diagnostics from a host that does not — rule 1
  permits exactly that, and it stays the host's decision rather than something an
  `import` makes for it. This is not the inference rule 2 forbids: rule 2 is
  about guessing a vocabulary from a document, and a host saying "I ship this
  one" is a statement about the host. Registration **enforces** the naming
  convention rather than merely testing it — the six built-ins carry historical
  exceptions, a new one gets none.

- **Every profile carries a conformance file.** §8.4's suite is the
  specification's and is stated over the document model, so it says nothing about
  any vocabulary on purpose — its own cases declare a name nothing recognizes,
  precisely so no expected projection can depend on a processor's vocabulary
  list. Right for the core, and it left a processor claiming to implement
  `geml-media/v1` with nothing to reproduce.

  `spec/profiles/geml-<x>/conformance.json` states each vocabulary's observable
  contract as data: its diagnostic codes with default severities, and per case
  the addresses a document carries **with and without** the declaration, plus
  which names stop being `unknown-*`. A test holds the files against the
  registry, so `codes` and `state` cannot drift into two versions of one fact.

  The addresses carry the weight. §8.6.2 rule 4 lets a declared body mode change
  the addressable set and lets nothing else do it, and these files pin that per
  vocabulary: `geml-form/v1` is the one whose two readings differ — its `form`
  holds id-bearing `form-field` blocks — and `geml-media/v1` is the contrast, a
  prose body creating no ids. A case drifting across that line fails, in either
  direction.

  Writing them surfaced an asymmetry worth recording: a **nested** admitted name
  produces no `unknown-block-type` in the undeclared reading, because its
  container falls back to a `raw` body and the block inside is never scanned as a
  block — it is text. So the suite asks a document for *some* `unknown-*` without
  its declaration, not every admitted name for one.

- **A vocabulary's checks run from `geml check`, and its codes carry a prefix.**
  There were three shapes for the same job: `geml-media` ran through one
  hardcoded `if` in `cli.ts`, `geml-style` and `geml-history` through verbs of
  their own. Whether a document should be read by a vocabulary's rules is
  something the document already says in `=== meta`; asking the caller for a
  second command name asks twice. `check` now loops over the vocabularies a
  document declares and this processor recognizes. A separate verb stays right
  when the input is different — `geml style check` takes a stylesheet *and* a
  corpus — so that one is unchanged.

  Profile diagnostics keep their own shape, `ProfileDiagnostic`, and that is
  deliberate: they are cross-document, so they report an **address** (`doc#id`)
  where a core diagnostic reports a line, and they carry a third severity,
  `info`, that Appendix A has no use for. Forcing them into the core shape would
  have meant a fabricated line 0 on every one.

  `--severity <code>=<error|warning|info>` re-levels one profile code, with
  `info` as the floor — a level that silences is what `--only <pattern>` is for,
  and the difference is that a downgraded diagnostic still appears in the output
  and in `--json`, it just stops deciding the exit code. Neither flag takes a
  core code: Appendix A fixes those severities and a processor that moved one
  would not conform.

  **`geml-style`'s seventeen unprefixed diagnostic codes are renamed** —
  `unknown-component`, `unknown-handler`, `frame-cycle`, `reserved-name` and the
  rest now carry `style-`. The profile documents itself as EXPERIMENTAL and says
  its vocabulary moves with the first real use case; seventeen entries in an
  exception table would have been the naming rule repealed politely. The
  exception table is down to eight, and `ProfileDef.diagnostics` now points at
  the checkers' own severity tables rather than restating them.

- **The route out of a profile.** `spec/proposals/README.md` gains the direction
  it was missing. It said where a
  construct should START; it now says how one LEAVES a profile: a second
  independent vocabulary needing the same thing, or an obligation on every
  conforming processor. Neither is a single vocabulary's convenience, which is
  the bar a registry entry deserves.

- **Only the parser moves in this release.** `geml-viewer` and the Logseq
  artifacts stay where they are: neither has a source change here, and the
  "one patch per parser release" line in `docs/PUBLISHING.geml` is a convention
  for when they do, not a rule that a parser release drags them along. The
  viewer bundles the parser at build time, so it picks 1.11.1 up on its next
  release whenever that is; the Logseq packages depend by range and their
  lockfile pin is refreshed as its own act.

- **Profiles carry a name prefix and a status, and a test holds both.** Two
  namespaces had no rule at all: a vocabulary's diagnostic codes and the
  `=== meta` keys it reads. `geml-style` emits `unknown-state` and
  `unknown-token`; `geml-media` reads `fps` and `aspect` — names a second
  vocabulary would plausibly want, colliding silently if it took them. A
  vocabulary now owns the prefix of its own name across three namespaces: block
  types, diagnostic codes and meta keys. Attribute keys stay exempt, and for a
  reason rather than an oversight — they are registered per block type, so the
  type already scopes them.

  `ProfileDef` gains a required `state` (`draft` | `stable` | `deprecated`)
  plus `since`, `metaKeys` and `diagnostics`. Status became load-bearing with
  GEP-0013: before it a vocabulary could only add names, and now it can declare
  body modes, which change how documents parse for everyone who recognizes the
  name. `stable` therefore means additive-only inside `/vN`.

  Both rules are repository conventions, not specification text — §8.6.2 rule 3
  makes it implementation-defined which vocabularies a processor recognizes, so
  the specification has no place to require a vocabulary carry a status. The
  fifteen names that predate the convention are recorded as exceptions, each
  with a reason and what clears it, and a second test fails when one goes stale
  so the table cannot quietly become permanent. One of them is a real §8.5
  squat: `geml-media/v1` admits the bare type name `media`, and no GEP claims it.

## [1.11.0] — 2026-09-17

- **The packaged skill stops saying "never write to a Markdown file".** It said
  to locate and read with `geml`, then edit with the ordinary tool, and called
  that a safety property. Half of it was: a document nobody asked to address by
  block should be edited the way its author edits it, and that stays the default.
  The other half was untested caution. Measured on a real vault, `geml set` on a
  `.md` leaves the frontmatter and every unaddressed block **byte-for-byte
  unchanged** and writes the body verbatim — no escaping, no reflowing — so
  block-addressed editing is available when it is what was asked for.

  What made the caution reasonable is now written down instead of implied:
  `references/markdown-writes.md` carries the five rules that bite, two of them
  **silent** — `set` on the frontmatter block deletes the closing `---` and the
  page loses every property, and `--body` on a prose block appends instead of
  replacing because a prose block has no body of its own. Both exit 0. The other
  three refuse loudly: a `[[name#anchor]]` link is GEML reference syntax and is
  resolved on write, two identically-titled headings make a whole file
  unwritable, and `--in <file>` takes a block id from that file rather than its
  text.

- **A vocabulary may declare a body mode, and a processor says when it does not
  recognize one** (GEP-0013). §8.6.2 rule 3 used to require meeting an
  unrecognized `profile` name in silence — "not an error, not a warning" — and
  rule 4 then had to make that silence safe by forbidding admission to change
  anything observable. The two were one decision, and this takes the other side:
  a processor MUST now report `unrecognized-vocabulary` (warning) naming the
  vocabulary it does not ship, and rule 4 relaxes from "MUST NOT change the
  document model" to "MUST NOT change the set of addressable units, except as
  the vocabulary's declared body modes require". Nothing about the degradation
  changes: a processor that does not recognize a vocabulary still admits nothing
  and still reads those bodies as `raw`. What changes is that it says so. This
  is the shape §3.2 already uses for a RESERVED `data` format a processor ships
  no engine for — the body stays raw, `data-format-no-engine` says why, and the
  value tree is not addressable there. `geml-form/v1`'s flow containers and
  `geml-media/v1`'s prose body stop being recorded divergences from rule 4 and
  become licensed extensions. The GEP-versus-profile test in
  `spec/proposals/README.md` changes with it: *does GEML have to read inside the
  body?* is withdrawn, and *does it put an obligation on every conforming
  implementation?* — which was already written there as the second test —
  becomes the only mechanical one.

  The report **follows the content across an `=== embed`**, and only for a
  target the host itself names. §3 already had the
  good case right: a host that declares nothing, read by a processor that ships
  the target's vocabulary, gets the target's blocks read the way its home reads
  them. The bad case was silent — a host embedding a target whose vocabulary the
  processor lacks rendered a fenced code block where prose should be and
  answered `ok: no diagnostics`, and the host is the document the reader is
  looking at. It is now reported at the embedding block. That draws a line the
  specification did not have to state before: a diagnostic about what this
  PROCESSOR cannot do follows the content, and one about a DOCUMENT's own fault
  stays with that document.

  The depth limit is the security half of that rule, and it is why the rule is
  half a sentence longer than it first was. Hanging the report off the
  transitive walk that already existed for cycle detection disclosed a third
  document: `A` borrows one PUBLIC block of `B`; `B`, in a block `A` never took,
  embeds `secret.geml`; `A`'s diagnostics and `A`'s published HTML then carried
  `secret.geml`'s path and its vocabulary name, about a document `A` never named
  and content it never received. **A diagnostic may name only documents this
  document names.** Pinned as `R6-1` in the security suite. The page notice is
  narrowed the same way from the other end: it appears only when the page
  actually shows a block it could not read, so a vocabulary whose absence
  changed nothing visible is never named at all.

  The notice reaches the **rendered page**, not only `check`. The unknown-type
  fallback labels such a block *unknown block type* — the same label a mistyped
  type gets, so a reader cannot tell "this document is wrong" from "my renderer
  is missing a vocabulary", which is the whole question of whose fault it is.
  A full-page `--to html` now says once, above the content, which vocabularies
  it was rendered without and what that label means there. `--fragment` gets
  none of it: a fragment goes into someone else's layout, and the viewer already
  renders every model diagnostic as a banner of its own, so it picks this one up
  with no change. `Diagnostic` gains an optional `subject` carrying the name the
  diagnostic is about, so a renderer never has to scrape it back out of a
  message Appendix A says may be reworded.

- **A ``` fence shields `=== meta` from the metadata pass too.** `scanBlocks`
  shielded backtick fences and `collectMeta` did not, so the two passes
  disagreed about what a block is: a document that merely *showed* the syntax
  silently acquired its keys. This specification's own §8.6 example was setting
  `profile` on the whole specification that way — found because GEP-0013's new
  diagnostic made it audible. Eight documents in `spec/` were affected;
  `geml-history-profile.md` loses four spurious warnings.

- **`geml find` walks Markdown too.** A directory handed to `find` was searched
  for `*.geml` and nothing else, so pointing it at a folder of notes answered
  "no matches" about a word on every page — silently, and with the exit code
  that means "searched, found nothing". `list`, `get` and `set` all take a
  `.md`; only the walk that has to FIND one refused, which made it not a
  narrower search but a wrong one. The walk now admits both formats the parser
  reads from a path, `*.geml` and `*.md`, matched case-insensitively so a
  `NOTES.MD` from a case-insensitive filesystem is not skipped. It still
  filters — a `.ts` or a `.py` would drag a whole source tree through the
  parser — and a `.gemlhistory` sidecar is not a document, so it stays out.
  **This is a behaviour change, not a fix**: `geml find X .` in a repository
  holding Markdown now returns hits it used to hide. The MCP `geml_find` tool
  and the VS Code workspace-symbol provider (Ctrl+T), which both go through the
  same walk, widen with it.

## [1.10.3] — 2026-09-12

- **`geml-style` places blocks, not just decorates them.** The profile could
  say how a block looked; it could not say where a block went, so every page
  that used it still needed a hand-written host around it. `style-screen` and
  `style-frame` are containers with `slots=` and `axis=`, a rule may aim at one
  by its bare `#id`, and `when=` binds a variant to a declared state. The
  vocabulary a container understands is a closed list of built-in words rather
  than open CSS, because a profile that accepts anything cannot tell an author
  they made a typo. A sheet's own `meta` is now a token table — `{{accent}}` in
  any attribute value takes the value from it, keeping its type, so a numeric
  word can be fed one — and a dangling token is an `unknown-token` error rather
  than a silent empty string. The demo page is a template plus one `embed`,
  which is the arrangement the layer is for: change the document, keep the page.

- **A name written twice in one attribute object is an error.** §4 promises
  attribute order is insignificant, and measured, it was not:

      {#a .link link=http://x link}  ->  classes ["link"], attrs {link: true}
      {#a link .link link=http://x}  ->  classes ["link"], attrs {link: "http://x"}

  Same parts, different order, different document, no diagnostic. A class, a
  `key=value` and a bare flag all write the same NAME — a flag already IS
  `key=true` in the model — so a repeat is `duplicate-name`, an error rather
  than a warning because the second one quietly wins. `#id` does not take part:
  it is the primary key, the way `id` and `class` are separate in HTML.

- **The braced spelling of a selector key parses everywhere the short one does.**
  `#id` is `{#id}` written short and `@<hex>` is `{@<hex>}` written short, and
  of the four expanded spellings exactly one used to parse. All four do now, and
  each lands on the same selector as its short form, so nothing downstream learns
  there are two. A coordinate's base takes the long form too. Two smaller gaps
  beside it: `geml get --help` never mentioned coordinates at all, though GEP
  0011 had been implemented for months; and a coordinate landing on a block with
  no inner units claimed only tables and `data` blocks have them, while
  `#meta["title"]` has always worked.

- **An `embed` keeps the classes its author wrote.** The rule beside `clsAttr`
  is that author classes ride on a block's outermost element for every typed
  block, and `embed` was the one type that skipped it — `{.big}` vanished with
  nothing said. It rides now, on the fallback markup too: whether a class
  survives should not depend on whether that embed happened to resolve.

- **A `view` reading `http(s)` is left to the renderer, as a table's source is.**
  It said so by answering `undefined`, which the resolution loop reads as "not
  ready yet" — so the view never left the pending set and the closing sweep
  reported it as a cycle it had never been part of. A table with the same source
  reported nothing. They read alike now, and real cycles are untouched.

- **An EDN map key written as the string `"__proto__"` is a key.** On a plain
  object that assignment replaces the prototype instead of adding a property, so
  the entry never became an own key — and a coordinate write asking for a
  different key dropped it from the body with exit 0 and no diagnostic:

      {"__proto__" {:polluted "yes"} :real "kept"}
      geml set '#d[":real"]'   ->   {:real "changed"}

  It also left the value tree wearing an author-supplied prototype. Maps are
  built without one now, which makes every name an ordinary key and removes the
  primitive rather than the single name that reached it.

- **A coordinate write into a `yaml` body is refused instead of rewritten as
  JSON.** `yaml` has a reader, so such a write reached the JSON fall-through and
  changed the block's format — then the document's own validation refused the
  result and blamed the body the tool had just produced. `serialize` already
  refuses exactly this, and says why: a yaml body's authored bytes are its
  canonical form. The refusal now happens up front and names what to do instead.

- **Security audit, round 5 — batch 1: two crashes and a guard that held only at
  the top.** A cross-document `view` cycle — `A.geml: view src=B.geml#v` beside
  `B.geml: view src=A.geml#v`, or a file naming itself — recursed until the stack
  ran out, and `geml check` (the CI gate, and what MCP runs around every write)
  died with a `RangeError` from a two-line file; the same-document `src=#v` cycle
  had been a diagnostic all along. It is `view-source-cycle` now, naming the
  chain, and a chain of distinct documents stops at the depth bound an embed's
  does. The remote document is parsed once per path rather than once per view
  (twelve files of seven lines took eight seconds). A borrowed document's own
  `src=` resolves against ITS directory, not the host's, so a same-named file
  beside the host no longer replaces the data the borrowed author pointed at.
  And a remote view that failed to resolve in its own document reached the
  consumer as an empty relation with the reason thrown away; it is an error at
  the consumer now, carrying that reason. The `yaml` engine bounds nesting at
  200 levels with a refusal — six thousand `- ` in twelve kilobytes threw a
  `RangeError` straight through `parse()`. The `--body` and coordinate write
  guard compared TOP-LEVEL block counts, so a fence in the body of a block
  nested in a note closed it early and planted a sibling `=== meta` inside the
  note while the count never moved; the re-parsed target must now span exactly
  the spliced region, at any depth, and a whole-row coordinate write refuses a
  value that is a fence or a `%%` line. `geml codemap serve`: the recipe's
  `root` — repository content — chose the very directory the source route
  confined itself to, so a cloned map could serve `~`; it is bounded by the
  enclosing repository now, the rule the MCP side already applied. The server
  answers only a `Host` naming this machine (DNS rebinding), and `--stop`
  signals only a pid whose token twin exists in this machine's temp dir, the
  pid file being repository content too.
- **Security audit, round 5 — batch 2: integrity.** A `history save -m` summary
  was written into the sidecar's attribute line unescaped, and the reader
  SEARCHED that line for `hash=` — so a summary of `x" hash="sha256:0…` planted
  a second `hash=` the search found first, and `verify` failed on a chain nobody
  had touched; a summary with a newline ended the line and the rest was read as
  new lines of the sidecar, a forged `history-revision` block included. Values
  are written escaped per §4 now, the attribute object is read as a sequence of
  pairs, and a newline in a summary or author is refused by name before anything
  is written. `splitName` (the `[printf]` suffix of a computed column) and
  `orderView` (an `order=` key's `asc`/`desc`) matched with lazy patterns that
  backtracked quadratically over the attribute — 128 KB held the parser for 23
  and 8 seconds; both are linear scans. In the browser extension, a fetched
  `src=` body was inlined between the HOST's fences, so a data line of `===`
  closed the table there and everything after it parsed as top-level blocks of
  the trusted document — including a `=== embed` the host never wrote, pulling a
  same-origin file the reader never asked for; the body now chooses a fence
  longer than any `=` run it contains. In the VS Code extension, the check that
  an `embed` target lies inside the document's folder was lexical, and a
  symlink committed to a repository is spelled inside the folder while resolving
  wherever it points — `notes.geml -> /etc/passwd` walked through and landed in
  the preview; the realpaths decide now.
- **Security audit, round 5 — batch 3: hardening.** §4's two escapes, `\"`
  and `\\`, are now honoured by the attribute parser and emitted by the
  serializer: a quoted value could not hold a quote (the tokenizer ended the
  span at any `"`), so 532 of 3000 random values did not survive one `--to
  geml`; none fail now. The serializer also puts the `\` back on a paragraph
  line that would otherwise start a block — `\=== meta {…}` parsed to prose
  and was emitted as a live meta block, `\# H {#pwn}` as an addressable heading,
  `\%% x` as a hidden line. `geml … --from md` keeps passing `===` and `%%`
  lines through (a Markdown file may already carry GEML blocks) but says so in
  its notes instead of silently making structure out of prose. The `yaml`
  engine: `1e999` is refused like `.inf` rather than becoming Infinity; a
  `__proto__` key is an own key of the value tree, not its prototype; anchors,
  aliases and tags are refused in key position too; a block scalar keeps its
  `#` and its blank lines, being text. `--to html` no longer applies an author
  class that names the renderer's own chrome (`.render-error` on a note wore the
  build-error styling). Outside the parser: every third-party GitHub Action is
  pinned to a commit SHA; a `CODEOWNERS` asks review for the workflows, the
  Claude Code hooks and the codemap recipe; the SessionStart hook presents the
  repository's instructions as notes, not as authorization; the browser
  extension drops the `offscreen` permission its parked engines would have
  needed, and that parked path now inserts an engine's SVG only through a
  caller-supplied sanitizer, its sandboxes answering only their parent.

## [1.10.2] — 2026-09-09

- **`data {format=edn}`, so nested data can be ADDRESSED rather than only
  carried.** The Logseq integration put a block's properties in a
  `code {lang=edn}` block, and a `code` body is raw — no value tree, so no
  coordinate reaches into it. The properties therefore had no address at all:
  only the blob's content hash, which changes the moment you edit it, so "set
  this block's status to done" could not be written as an addressed operation.
  `edn` joins `yaml` and `toml` as a RESERVED format name (§3.2) and this
  processor ships an engine for it, so `geml get '#meta[":build/properties"]
  [":user.property/status"]'` reads one property and `geml set` writes one.

  The reading is deliberately NOT in the spec. `yaml` gets a mandated subset
  because YAML is implemented everywhere; `edn` has one consumer to calibrate
  against, and a reading pinned by a single use case is one the second use case
  has to live with. The spec reserves the name and says so, cost included: until
  it is specified, two processors with an `edn` engine may read a body
  differently. This processor's reading is in `src/edn.ts` — keywords keep their
  colon (`:x` is not the string `"x"`), sets and tagged literals wear a `$`
  wrapper, and the kinds outside the subset (lists, symbols, characters,
  bignums, ratios, other tags) are refused BY NAME rather than guessed at, the
  same stance the `yaml` engine takes. Zero dependencies, hand-written, like the
  rest of the parser.

- **A coordinate write no longer rewrites an EDN body as JSON.** `planCoordWrite`
  ended in `JSON.stringify` under a comment saying no format could reach it —
  true when only `json` and `jsonl` produced a value tree, and false the moment
  another engine did. Writing one EDN property would have silently changed the
  block's format. `edn` bodies re-emit as EDN. `yaml` still lands in that
  fall-through and still re-emits as JSON: the same bug wearing another format's
  name, now named in the code rather than implied to be impossible.

## [1.10.1] — 2026-09-06

- **A coordinate crosses a document into a `view`, and into `#meta`.** A borrowed
  document is loaded by a scan, and a scan leaves every `src=` block empty — so a
  `view`, whose whole content comes from `src=`, carried zero columns across the
  boundary and `other.geml#fy[1]["FY"]` failed on the very numbers most worth
  referencing, while the same file checked clean on its own. The loader now runs
  the table, view and data resolve passes on what it scanned, still with no
  `resolveDoc`, so a same-document `src=#id` fills in and two documents that
  reference each other cannot resolve in circles (§9.3). Separately,
  `A.geml#meta["version"]` — which GEP 0011 writes beside `#meta["version"]` —
  was resolved only in the same-document branch: across a boundary the loader
  looked for a block whose id is `meta` and found none. The reserved merged view
  is built there too now, and a document that declares `{#meta}` on its own block
  still means that block.

## [1.10.0] — 2026-09-04

- **A `view` block owns every operation that derives a relation (GEP-0012).**
  `table` holds facts and derives nothing: `compute=`, `summary=` and a `src=`
  that names a block move to `view`, which adds `where=`, `order=`, `limit=`,
  `select=`, `by=` and `aggregate=`. The evaluation order is SQL's logical one,
  with `compute=` running in two passes so `where=` may name a per-row derived
  column while an aggregate-derived one is refused as circular; `summary=` runs
  last, over the rows actually shown. A source's report row does not cross into
  a consuming view, a chain of views is bounded like a nested `embed` (§9.3),
  and a cycle is an error naming every view in it. Text ordering compares
  UTF-16 code units, so a row order never depends on the processor's locale. A
  coordinate READS a view's cells (GEP-0011) and can never write one.

  A `table` carrying `compute=`/`summary=`, or a `src=` naming a block, is not
  kept compatible: GEML is not adopted widely enough yet to owe an old spelling
  a bridge.

- **`format=yaml` is read, for a subset that means the same thing in every
  processor that reads it.** The name was reserved with no engine here, so a
  config written in the syntax most config is written in carried no value,
  could not be addressed and could not feed a chart. Full YAML is not the
  answer: the places it is large are the places implementations disagree —
  `yes` is a boolean in 1.1 and a string in 1.2, plus anchors, tags, merge
  keys, multi-document streams, flow collections with unquoted keys — so the
  engine reads block collections nested by indentation (including
  `- key: value` and `- - item`), plain/quoted/block scalars, comments, one
  document, `[]`/`{}`, with YAML 1.2 **core-schema** scalars, and REFUSES the
  rest by name rather than guessing. §3.2 states the subset as an obligation
  on anyone who implements the optional engine. `src=` now admits
  `.yaml`/`.yml` alongside `.json`/`.jsonl`, the extension naming the format,
  because a file on disk is where yaml normally lives. Zero new dependencies.
  `toml` remains reserved with no engine.

- **Canonical serialization is defined for `json` and `jsonl` only.** A
  `data` body was re-emitted from its parsed value, which was invisible while
  only JSON had an engine — and would have rewritten a `yaml` body into JSON
  on any `--to geml`. Every other format is byte-preserved now, whether the
  processor parsed it or not.

- **A unit inside a block has an address (GEP-0011).** `#fy[2]["Q1"]` names a
  cell, `#fy["Q1"]` a column, `#fy[summary]["FY"]` a reported row, and
  `#intake["sections"][0]["fields"][1]["name"]` walks a `data` block's value
  tree; `#meta["title"]` reads the merged meta namespace and writes the first
  `meta` block, which is the one that wins. `geml get` and `geml set` both
  take one, references resolve one (`[[#fy[2]["Q1"]]]` renders the value it
  names), and `#meta` is a reserved id.

- **A table that borrows its rows now applies its own derivation, and leaves
  the source's report behind.** A `src=#id` table was handed the source's
  finished model, so three things went wrong at once and every one of them
  silently: the source's `summary=` row came across as though it were a tuple
  (a total among the rows, for a later summary to count again), the borrowing
  table's own `compute=`/`summary=` were dropped (they parsed, `check` was
  clean, the render ignored them), and a formula would have written into the
  source's own row arrays. The borrowed grid now takes the source's tuples and
  the columns the source computes — derivation is the source's to publish —
  with row arrays of its own, and runs the borrowing table's formulas over it.
  The `.csv` branch beside it was always correct, because it re-parses with the
  borrowing table's attributes; only the `#id` branch shared a model.

- **The packaged skill no longer teaches an attribute that does not exist.**
  `skill/` ships inside this package, so 1.9.2's tarball still told an agent to
  merge cells with `span="r2c1:2x1"` — an attribute removed together with its
  parsing, its `bad-span` diagnostic and its renderer arm. Three retired verbs
  went with it: `geml fmt`, `geml convert` and `geml render` are `--to geml`,
  `--from md` and `--to html`, and the skill text, four proposals, two design
  notes and the GEP issue template said otherwise.

## [1.9.2] — 2026-09-02

- **A translation is asked for a block at a time, not a text node at a time.**
  `translateBlocks` used to hand the translator each inline `text` node on its
  own, which kept code spans and link targets out of the engine's reach by never
  sending them — and never sent a whole sentence either. Measured on
  `docs/MANIFESTO.geml`: 133 calls, **57 of them shorter than 25 characters**,
  including `" / "` four times and a lone `"."`; 12 of 34 prose blocks arrived in
  pieces, the worst in seven. A block's inlines now cross as ONE string with a
  placeholder standing in for each span the translator must not touch — code,
  math, a link's target — and paired placeholders around emphasis and links, so
  the sentence flows through them. Same document, same translator: **60 calls, 9
  short strings, and no bare-punctuation fragment at all**. Every placeholder
  sent must come back exactly once; one dropped, duplicated or crossed discards
  that block's translation and yields the source, under the partial-output rule
  GEP-0010 already states.

- **A projection may pin the terms an engine would otherwise re-decide.**
  `=== meta` names a **glossary** — `glossary = "#id"`, a reference to a table in
  the projection itself, normally hidden — and `glossaryFrom()` reads it. A term
  in that table never reaches the engine: it is masked out with the same
  placeholder machinery, and the settled translation is restored after. A
  translator is called per block and remembers nothing between calls, so a term
  appearing in eight blocks was decided eight times; structure cannot drift, but
  vocabulary can.

- `translateBlocks` / `translateInlines` take an options object
  (`TranslateOptions`); both signatures stay backward compatible.

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

## [1.8.7] — 2026-08-26 *(never published to npm — these changes reached users in 1.8.8)*

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

### Security
- **Security audit, round 4** — an audit of 1.8.0's emphasis-across-atoms
  rework. Its four fixes are the first four bullets under *Fixed* below (the
  `~`-run hang and crash, quadratic emphasis pairing, quadratic bracket/paren
  scanning, prototype-chain block types). The same round's probes of
  `__proto__`-style keys, the `data:` image gate, escaping under emphasis and
  scheme-allowlist evasions are pinned as regression tests.

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

## [1.6.1] — 2026-08-04 *(never published to npm — these changes reached users in 1.7.0)*

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

### Changed
- Version bump only: git records no source change over `1.4.1`. It is the
  oldest `1.4.x` on npm.

## [1.4.1] — 2026-07-24 *(unpublished from npm — these changes are on npm from 1.4.2)*

### Security
- **Security audit, round 3** — crafted document ids are escaped before they
  reach a `RegExp`, so they can no longer crash or stall the parser;
  `set --body` refuses a body whose fence would plant a sibling block, and
  `rename` refuses to also rewrite a different id sharing the prefix (`#foo`
  vs `#foo.bar`); the codemap's `pom.xml` `<module>` parse is linear and the
  cross-stack detector's cost is bounded on hostile source; the code-graph
  page confines its runtime fetches and loads to the page origin; and, outside
  the package, the repository's autocommit hook never shell-joins the edited
  filename. The findings are pinned as regression cases.

## [1.4.0] — 2026-07-23 *(unpublished from npm — these changes are on npm from 1.4.2)*

### Added
- Block-mutation CLI work: `get` / `set` / `add` / `delete` / `rename` /
  `revert` over addressed blocks, each write re-parsed and refused before it
  reaches disk.

## [1.3.2] — 2026-07-23

### Added
- `geml codemap serve --watch`.

### Fixed
- `geml codemap refresh` pathspec handling.
- `render-html` split into its own module (no API change).

## [1.3.1] — 2026-07-22 *(unpublished from npm — these changes are on npm from 1.3.2)*

### Changed
- Refreshed npm README and package metadata.

## [1.3.0] — 2026-07-22 *(unpublished from npm — these changes are on npm from 1.3.2)*

### Added
- **`=== text` blocks** ([GEP-0004](spec/proposals/0004-text-block.md)) — a run
  of prose becomes addressable without inventing new syntax.

### Fixed
- `{{key}}` interpolation now skips code spans and math, and `\{{key}}` escapes
  it.

## [1.2.3] — 2026-07-21 *(unpublished from npm — these changes are on npm from 1.3.2)*

### Added
- **`geml check --root <dir>`** — widens cross-document reference resolution to
  a directory, so sibling directories can reference each other. Escapes past the
  root are still refused.

## [1.2.2] — 2026-07-21 *(unpublished from npm — these changes are on npm from 1.3.2)*

### Security
- Round-two security-audit fixes. Codemap recipes became structured
  (`{cwd, env, argv}`) behind a schema version gate; older recipes are refused or
  upgraded rather than executed as-is. Plus fixes for scheme control characters,
  same-origin `fetchDoc`, `vscode:`/`action:` schemes, recursion and DoS limits.

## [1.2.1] — 2026-07-21 *(unpublished from npm — these changes are on npm from 1.3.2)*

### Security
- Round-one security-audit fixes: a trust gate closing a remote-code-execution
  path in the codemap recipe runner.

## [1.2.0] — 2026-07-17 *(unpublished from npm — these changes are on npm from 1.3.2)*

### Added
- Published to npm as `@geml/geml`; this version was later unpublished.

## [1.1.1] — 2026-07-13

### Fixed
- Maintenance release.

## [1.1.0] — 2026-07-06 *(unpublished from npm — these changes are on npm from 1.1.1)*

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
