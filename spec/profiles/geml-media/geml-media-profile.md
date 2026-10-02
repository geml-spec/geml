# geml-media profile v1 — assets, cuts and generation lineage

*English | [中文](geml-media-profile_CN.md)*

- Status: **draft**. Its `media-text` type declares a prose body, which [GEP-0013](../../proposals/0013-prose-body-for-vocabularies.md) both licenses a vocabulary to do and defines. The vocabulary below is registered in the reference
  implementation and exercised by one real use case
  ([the geml-media demo](https://github.com/geml-spec/geml-spec.github.io/blob/main/public/examples/geml-media-demo/README.md));
  the design record is
  [`2026-09-15-geml-media-design.md`](../../../docs/design/specs/2026-09-15-geml-media-design.md).
- Nature: **an application-layer profile, not part of the GEML standard.** It
  admits three block type names, attribute keys on those types, and one class
  (`.gen-log`) that says how a `data` block is read. §8.6 lets a vocabulary
  admit exactly this much. The specification is unchanged.

## 0. What it is in one paragraph

A pipeline that makes images and video with generative models produces far more
*intermediate* material than finished shots: a cast, character cards, a style
board, a shot list, prompts, lines, reference images, takes, voice-overs,
lip-synced composites, subtitles, a timeline. This profile gives each of those a
**block with an address**, records every generation as an **append-only entry**
carrying the hash of each input *at the time it ran*, and thereby turns "I
changed the character card, which shots have to be made again?" into a question
`geml check` answers. An asset is a file with an identity (`sha256`); a cut is a
**reference to a span of one**, never a copy of its bytes — the same shape as
`code {src=file#L14-24}` pointing at a span of source. A shot's picture can also
be **built from parts** — a scene plate, character stands, each an asset placed on
a canvas (§5.1) — and then the lineage reaches inside the picture: which layer
changed, and which shots used it.

## 1. Declaring the profile

```geml
=== meta
profile = "geml-media/v1"
===
```

Without the declaration the three type names are `unknown-block-type` and their
bodies are raw. A processor that does not recognize the profile name admits
nothing and reports `unrecognized-vocabulary` (§8.6 rule 3); it is still
conformant, and it reads `media-text` as a raw block rather than as prose, which
is the one thing recognizing this vocabulary changes about the model. Every
address the document carries is the same either way (§8.6 rule 4).

## 2. `media` — one playable thing

Every `media` block in a document is **one timeline**. The track table, the
primary track and the frame rate ride on the block, not in the document's
`meta`: they are facts about this timeline, not about the file that holds it.
On the block they are attributes, so the vocabulary's attribute table spell-checks
them — `primry=` is reported where a misspelled `meta` key is silent.

Two shapes, told apart by **shape** rather than by an attribute, exactly as
`<video>` does it:

```geml
==== media {#ep01 tracks="video:video dialogue:audio subtitle:prose" primary=video fps=24}

=== media-clip {#c01 track=video src=library.geml#s01-take3 in=0 out=4}
===

====
```

```geml
=== media {#hero-shot src=library.geml#s01-take3 in=0 out=4}
===
```

**With a body it is an assembly** (`<video><source>…</video>`); **with no body
and a `src=` it is a single playable source** (`<video src>`). A single source is
"a timeline holding one clip", so playback, encoding and export need no second
code path. There is no `type=` or `format=` restating the shape: one fact with
two spellings eventually disagrees with itself.

| key | shape | meaning |
|---|---|---|
| `tracks` | assembly | space-separated **`name:kind`** list. The kinds are `video`, `audio` and `prose` — what the content *is*. Declaration order is track order |
| `primary` | assembly | name of the primary track. **Defaults to the first declared track** — the spine every other track anchors to |
| `fps` | either | this timeline's frame rate. Needed only where an `hh:mm:ss:ff` timecode is written |
| `src` | single | a reference to a `media-asset`. Not allowed together with a body |
| `in` | either | **in-point inside the source**: where in the referenced file this cut starts. The word every NLE and W3C Media Fragments uses |
| `out` | either | **out-point inside the source**. Length = `out` − `in` |
| `duration` | either | the length, given directly, for a source with no `out` to speak of. Precedence: `out` > `duration` > the source's intrinsic duration |

Three keys are deliberately elsewhere. **Aspect ratio is presentation** and lives
on the stylesheet (`component=player aspect=9:16`). **Kind** is read from the
referenced `media-asset`'s `kind=`, never restated at the reference. **Playback
policy** — autoplay, loop, muted, controls — is not a document fact at all; none
of `<video>`'s attributes for it come across, because `<video>` is a presentation
element in a page and `media` is a statement about content.

**Audio gets no separate type.** HTML splits `<audio>` from `<video>` because the
rendering box differs. Here kind is *data* (`kind=` on the asset, `dialogue:audio`
in the track table), not type. A rough cut with only a dialogue track is still a
timeline, and every real timeline here is mixed anyway.

## 3. `media-asset` — one file

| key | required | meaning |
|---|---|---|
| `src` | yes | path to the file, resolved against the document, confined by §9.4's root |
| `sha256` | recommended | the file's SHA-256, **full 64 hex digits, never truncated**. The key names the algorithm, so the value carries no prefix. Missing → `media-asset-unhashed`, and that asset's lineage cannot be checked |
| `kind` | conditional | `image`, `video`, `audio`, `model`, `other` — inferable from the extension. There is no `text`: a subtitle file, a LUT or an external prompt file is `other` until a use case says what it really is |
| `duration` | video/audio | seconds. Absent, and with no `ffprobe` on the machine, in/out points go unchecked (`media-duration-unknown`) |
| `fps`, `size` | no | frame rate; `WxH` |
| `origin` | recommended | `generated`, `captured`, `licensed` — the first question a compliance review asks |
| `license` | conditional | the grant. Missing on `captured`/`licensed` → `media-license-missing` |
| `mime` | no | explicit media type, overriding the extension |
| `of` | recommended | **what this asset depicts**: a reference to the character, scene or prop block it belongs to |
| `role` | recommended | what it does in a generation: `sheet`, `master`, `stand` (a matted character cut-out, §5.1), `lora`, `voice`, `first-frame`, `last-frame`, `style-ref`, `workflow`, `take`, or a host word. Open set |

The body is raw and holds the author's own note. A note is a documented fact and
belongs in history; it is not a caption — how it renders is the stylesheet's
business.

**A missing file is a warning; a wrong hash is an error.** A library describing
assets that live elsewhere is still a legal document, merely unchecked
(`media-file-missing`). A file that is present but is not the one it claims to
be (`media-hash-mismatch`) is worse than an absent one: it is the wrong file.

## 4. `media-clip` — one cut on the timeline

| key | required | meaning |
|---|---|---|
| `track` | yes | the track's name, declared in `meta.tracks`. The track's **kind** decides which rules below apply, never the track's name |
| `src` | yes | a block reference. `video`/`audio` tracks must point at a `media-asset`; a `prose` track must point at a `media-text` |
| `in`, `out` | `video`/`audio` | start and end inside the source, in seconds **or** `hh:mm:ss:ff` timecode converted by `meta.fps` |
| `duration` | sources with no intrinsic duration | how long a still, or a piece of prose, occupies the timeline |
| `over` | non-primary tracks | anchor to a cut on the **primary** track |
| `offset` | no | seconds from the anchor's start, default 0 |
| `at` | no | an absolute start. An escape hatch: it overrides anchoring |
| `transition-in`, `transition-out` | no | `cut` (default), `dissolve`, `fade`, `crossfade`, or a host word |
| `transition-duration` | no | seconds |
| `gain`, `fade-in`, `fade-out` | audio | `-14dB`; seconds |
| `speed` | no | rate multiplier, default 1 |
| `xywh` | no | a crop of the source frame, in W3C Media Fragments syntax |

### 3.1 Track kinds

`meta.tracks` is a whitespace-separated list of **`name:kind`**, and the kind is
one of three: `video`, `audio`, `prose`. The kind says **what the content is and
where it lives** — a video file, an audio file, a prose block in the document —
not where it is drawn. An overlay track's kind is `video`; that it sits above the
picture is the stylesheet's decision, not the content's.

```geml
==== media {#ep01 tracks="video:video dialogue:audio bgm:audio subtitle:prose overlay:video" primary=video fps=24}
```

A bare name without a kind is an error, and so is a kind outside the three. There
is no fallback: a rule that has to guess the kind from the name cannot be stated,
because names are the author's to choose.

### 3.2 The time model

- The **primary track** (`meta.primary`, default `video`) is **sequential**:
  document order is playback order. Cut *i* starts where cut *i-1* ended, less
  the overlap its `transition-in` declares (`cut` is 0, `dissolve` and
  `crossfade` are `transition-duration`, `fade` does not overlap). The first cut
  starts at 0.
- A cut's length is `out - in`, or `duration` for a source with no intrinsic
  duration, divided by `speed`.
- **Other tracks are anchored**: start is the anchor cut's start plus `offset`.
  Insert a cut on the primary track and every anchored subtitle, voice-over and
  music cue moves with it. This is the same reason ids beat line numbers: the
  anchor is on content, not on a number.

## 5. `media-text` — the script layer

Prose that carries script meaning: a look, a prompt, a line. It is **`text` plus
five keys** — same flow body, same inline projection, same Markdown paragraph
projection — so the reference implementation declares it a *prose type*.

| key | on | meaning |
|---|---|---|
| `shot` | `.prompt` | which shot number this prompt belongs to |
| `speaker` | `.line` | the character block that says it, **required** |
| `to` | `.line` | who it is said to |
| `emotion` | `.line` | an emotion note: the script's *intent*. A TTS entry's `params.emotion` is what was actually asked for |
| `since` | `.look` | the episode from which this version of the look applies |

Conventional classes, admitted by nobody and checked as spelling by nobody — the
stylesheet and the checker recognize them: `.prompt`, `.line`, `.inner` (inner
monologue or narration), `.look`.

**References inside these keys are the profile's to check, not the core's.** The
core records references in four places only: `embed`'s `src=`, `data`'s
`schema=`, `view`'s `src=`, and inline `[[…]]`. An attribute value admitted by a
profile is never resolved by the core, so a dangling `speaker=` draws
`media-speaker-unresolved` from this profile and nothing from the core.

### 5.1 `media-comp` and `media-layer` — a prompt written in layers

A shot's picture can be asked for in words (a `.prompt`) or **built from parts**:
a scene plate and one or more character stands, each an image `media-asset`,
placed on a canvas. `media-comp` is that recipe and `media-layer` is one part of
it. The comp is to `compose` what a `.prompt` is to a model — both are "the block
a generation was made from", both carry `shot=`, both appear in a log entry's
`prompt`. It is **not** the shot: a shot may have no comp (one prompt, one picture)
or two (a first and a last frame).

```geml
==== media-comp {#s05-comp shot=s05 size=720x1280}

=== media-layer {#s05-bg src=library.geml#bedroom-master xywh=0,200,720,1280}
===

=== media-layer {#s05-hero src=library.geml#hero-sit x=300 y=340 w=480 flip=h}
===

====
```

| type | key | required | meaning |
|---|---|---|---|
| `media-comp` | `shot` | no | which shot this picture belongs to, as on `.prompt` |
| | `size` | yes | the canvas, `WxH`. A fact about **this picture**, not presentation, so not on the stylesheet. Missing → `media-comp-size-missing` |
| `media-layer` | `src` | yes | a `media-asset` of `kind=image`: a stand, a plate. Not an image → `media-layer-not-image`; dangling → `media-src-unresolved` |
| | `xywh` | no | a crop of the source **before** placing, W3C Media Fragments syntax as on `media-clip`. One plate, several crops: that is how a location gets its camera positions |
| | `w` | no | the width after scaling, aspect kept; default the source's (cropped) width |
| | `x`, `y` | no | the top-left corner on the canvas, pixels, may be negative; default `0 0` |
| | `flip` | no | `h` mirrors horizontally: one stand, two facings |

**Stacking order is document order**, first layer at the bottom — the same rule as
track order, so there is no `z=`. **Four transforms only** — crop, scale, flip,
place — each one ffmpeg filter, in that fixed order (`crop` → `scale` → `hflip`
→ `overlay`). Rotation, opacity and blend modes are not admitted: nothing has
needed them, and every extra transform is one more thing two renderers can
disagree on.

What is **not** a layout fact: how a stand was matted, a contact shadow, colour
matching, a harmonising repaint. Those are the compositor's and belong in the log
entry's `params` — so the same document composes on a cel-style pipeline with
`colorkey` and on a photoreal one with a matting model and a shadow pass, and
`check` tells the same truth on both.

**A comp is hashed like a prompt.** An entry whose `prompt` names a comp carries
`prompt-sha256` = the hash of the comp's **canonical text**: derived from the
model, not sliced from the source — one line for the comp, one per layer and one
per interaction, each the type, the id and the attributes sorted by key; §6
spells the lines out. Reordering attributes or whitespace changes nothing;
`x=300` becoming `x=340` stales the entry, and so does a moved point, because an
interaction line carries the coordinates it resolved to. Each layer's asset is
an `inputs[]` entry, so a regenerated stand stales it too.

`geml media compose <doc>#<comp> --out <file.png> [--log <library.geml> [--as '#id']]`
renders one comp with ffmpeg: a transparent canvas of `size`, each layer cropped,
scaled, flipped and overlaid in turn — the same document and the same inputs give
the same bytes. With `--log` it also registers the output (`role=first-frame`; a
new block, or the existing block's `sha256=`) and appends the entry —
`mode=composite`, `model=ffmpeg-overlay`, `prompt=` the comp, `inputs[]` the
layers' assets — because the only correct source of that `inputs[]` is the comp
itself. `geml media todo` lists a comp no entry claims as a `composite` item —
and, as for any prompt or line, lists it again with `stale: true` once `check`
finds its output no longer matches what produced it (a moved layer, a
regenerated stand): the to-do list is derived from the same facts the
diagnostics are.

### 5.2 Points and interactions — where two things meet

Where two things meet — a hand on a bowl, two people looking at each other, feet
on the floor — is a fact of the shot, not a reason to draw both in one image.
Three keys and one type carry it (design record §16.8):

| where | key | meaning |
|---|---|---|
| `media-asset` (stands **and plates**) | `points` | named positions in that image's own pixels: `points="hand:562,522 eyes:290,300"`. A plate's `floor`, `bed-edge`, `door` are what most blocking is about |
| the character or scene block the asset is `of=` — a heading's attribute, or `points` on a `.look` `media-text` | `points` | the **names** only: `points="hand eyes feet"`. A schema, not coordinates: a stand missing a point its character declares, or an interaction naming a point the character does not have, is reported before anything is composed |
| `media-interaction`, inside a `media-comp` | `a`, `b`, `kind` | `a=#layer:point b=#layer:point kind=contact\|gaze`. A **prose** type: its body says what happens in this beat — readable per step (`geml get '#s05-handoff'`), and the prompt of a generative finish where one is used |
| `media-comp` | `at` | the moment within the shot, seconds. Several comps sharing `shot=` are a sequence; layers correspond across frames by the character their asset is `of=`, not by id — ids are unique in a document |
| `media-layer` | `dx`, `dy` | an offset applied when an interaction places the layer |

```geml
==== media-comp {#s05-comp shot=s05 size=720x1280}

=== media-layer {#s05-bg src=library.geml#bedroom-plate}
===
=== media-layer {#s05-sister src=library.geml#sister-hand x=-90 y=370 w=560}
===
=== media-layer {#s05-bowl src=library.geml#bowl w=180}
===
=== media-interaction {#s05-handoff a=#s05-sister:hand b=#s05-bowl:left-grip kind=contact}
林岚双手端着碗，递到林夏面前。
===

====
```

**Placement.** Layers are placed in document order. Of the two layers an
interaction names, the **later one moves** toward the earlier; the order of `a`
and `b` does not matter. `contact` moves it so the two points coincide; `gaze`
aligns the vertical position of the two points and leaves `x` alone. A layer is
placed by its **first** interaction; later interactions on it only verify, and
report `media-interaction-apart` when the points end up more than 2 px apart. A
layer placed by a contact must not write `x`/`y`; one placed by a gaze must not
write `y` (`media-layer-position-conflict`) — adjust with `dx`/`dy` instead.
A `flip=h` layer's points mirror with it. Scaling a point by `w`, or mirroring
it, needs the source width: `xywh` supplies it, otherwise the asset's `size=`
(`media-asset-size-required`). Interactions hold at keyframes
only: what happens between two `at`s is the video model's or the tweener's.
The comp's canonical text carries the resolved point coordinates, so a moved
point stales every comp that used it. `check` and `compose` share one geometry,
and `compose` refuses a comp whose interaction names a layer or point it cannot
find rather than placing that layer at the origin and logging a plausible-looking
entry — a regenerated stand has new pixels, so its old points are no longer facts
about it and must be marked again.

## 6. The generation log — `data {.gen-log format=jsonl}`

One entry per generation, appended, never rewritten. It is a core `data` block
with a class, not a type of its own, and that buys three things a new type would
lose: the JSON is validated by the core, every entry and field has a coordinate
(`geml get '#gen-log[8]["inputs"]'`), and the array feeds `geml-chart` directly.

| field | required | meaning |
|---|---|---|
| `output` | yes | the asset block produced; **`null` on failure**, with `error` |
| `output-sha256` | yes, when `output` is not null | the hash of the produced file **at the time it was produced**. It answers "which entry produced the bytes this asset has now". Without it, one regeneration leaves the superseded entry mismatching the current value for ever, and the asset reads as permanently stale |
| `model` | yes | model name, free string, version included |
| `mode` | yes | `t2i`, `i2v`, `t2v`, `tts`, `lipsync`, `upscale`, `composite`, `other` |
| `prompt` | conditional | the prompt, line, comp or interaction block (§5.1, §5.2) |
| `prompt-sha256` | with `prompt` | the hash of the prompt **after projections are expanded**: the string the model saw, as defined below |
| `prompt-refs[]` | with `prompt` | `{ref, sha256}` for **each block the prompt projects**. `prompt-sha256` alone can only say "the prompt changed"; this says *which source* changed |
| `inputs[]` | no | `{ref, sha256, role?}`: reference images, LoRAs, key frames, voice samples, the take and voice-overs a lip-sync consumes, a ComfyUI workflow |
| `seed`, `params` | no | a seed; an open map |
| `at` | yes | ISO-8601 |
| `cost`, `tool`, `prompt-text`, `error` | no | a number; where it ran; the full prompt for reproducibility; why it failed |

**What `prompt-sha256` hashes** is fixed here so that two tools agree on it: the
SHA-256 of the UTF-8 bytes of the text below, which carries no trailing newline.

- For a `media-text` line, or any other **prose** prompt, the text is the block's
  first paragraph rendered to plain text: literal text as written; a code span or
  inline math as its body; emphasis, strong, strikethrough and a link as the text
  they wrap; an inline projection `![[…]]` as the projected block's text by this
  same rule, recursively, to GEML §9.3's transclusion depth bound — a projection
  that does not resolve contributes nothing; an auto-reference as the value it
  carries when it names a coordinate, else nothing; an image embed, a hard break
  and a footnote reference contribute nothing.
- For a `media-comp`, the text is its **canonical text**: one line for the comp,
  then one per `media-layer` in document order, then one per `media-interaction`
  in document order, joined by LF. A line is the block's type, its `#id` when it
  has one, and its attributes sorted by key as `key=value`, all separated by one
  space, a value written as its text (`true` for a bare flag). On an interaction
  line the `a=` and `b=` values carry the point they resolved to: the written
  value, `@`, then the point's `x,y` as the asset's `points=` gives them —
  `a=#s05-sister:hand@562,522` — or `@?` when the point does not resolve.

**Staleness is evaluated on the entry whose `output-sha256` matches the asset's
current value**, and it propagates down the lineage graph: a stale voice-over
makes the lip-sync that consumed it stale, which makes the cut that uses it
stale. Superseded entries take no part; that is what `output-sha256` is for.

**Whoever appends an entry also updates the asset block** — its `sha256`, and
`duration` where the tool knows it. An entry alone leaves the library claiming a
hash the file no longer has, which is `media-hash-mismatch` on the next check.

## 7. `=== meta` keys

| key | document | meaning |
|---|---|---|
| `tracks` | timeline | `name:kind` list; kinds are `video`, `audio`, `prose` |
| `primary` | timeline | the primary track's name, default `video`. Its kind is not constrained: an audio-only edit is a legal use |
| `fps` | timeline | the basis for timecode conversion |
| `aspect` | script, timeline | `9:16`, `16:9` — a rendering parameter, never affecting time |
| `target-duration` | script | the target length in seconds |
| `episode` | script | the episode number |

## 8. Diagnostics

Severity follows the core's rule: **a broken structure is an error, a stale fact
is a warning, a choice is info.** Staleness must be a warning and not an error;
otherwise one edit to a character card turns the whole pipeline red and people
learn to ignore it.

| code | level | when |
|---|---|---|
| `media-src-unresolved` | error | a cut's `src` names no block |
| `media-src-not-asset` | error | `src` disagrees with the track's kind |
| `media-file-missing` | warning | an asset's file is not there |
| `media-hash-mismatch` | error | the file is there but its SHA-256 is not the one declared |
| `media-asset-unhashed` | warning | an asset carries no `sha256`; its lineage cannot be checked |
| `media-duration-required` | error | a source with no intrinsic duration and no `duration` |
| `media-track-missing` | error | a cut with no `track=` |
| `media-track-undeclared` | warning | a `track=` not in `meta.tracks` |
| `media-track-kind-missing` | error | a `meta.tracks` entry with a name but no kind |
| `media-track-kind-unknown` | error | a kind outside `video`, `audio`, `prose` |
| `media-of-unresolved` | error | an asset's `of=` names no block |
| `media-speaker-unresolved` | error | a line's `speaker=` or `to=` names no block |
| `media-line-no-speaker` | error | a `.line` with no `speaker=` |
| `media-gen-schema` | error | a log entry missing a required field, naming the entry's index and the field |
| `media-gen-output-not-asset` | error | an entry's `output` names no `media-asset`: the log claims a file the library does not have, and whatever consumed it can no longer be told it changed |
| `media-orphan-record` | info | no entry's `output-sha256` equals the asset's current value: the bytes it has now have no recorded provenance |
| `media-stale-generation` | warning | in the entry that matches the asset's current value, an input hash, `prompt-sha256` or a `prompt-refs[]` hash disagrees with the current value; the message names what changed |
| `media-stale-clip` | warning | a cut's `src` is the output of a stale entry, or of one whose ancestor is stale; the message carries the chain |
| `media-layer-unassembled` | error | a `media-layer` outside any `media-comp` |
| `media-comp-size-missing` | error | a `media-comp` without `size=WxH` |
| `media-comp-empty` | error | a `media-comp` with no layer in its body |
| `media-layer-not-image` | error | a layer's `src` resolves to something that is not an image asset. A dangling `src` is `media-src-unresolved` |
| `media-interaction-unassembled` | error | a `media-interaction` outside any `media-comp` |
| `media-interaction-unresolved` | error | `a`/`b` is not `#layer:point`, names a layer outside this comp or a point its asset does not have; or `kind` is not `contact` / `gaze` |
| `media-interaction-point-undeclared` | error | the point is not among the names the asset's character or scene declares |
| `media-interaction-same-layer` | error | both ends of an interaction on one layer |
| `media-layer-position-conflict` | error | a layer placed by an interaction also writes the coordinate that interaction sets |
| `media-asset-size-required` | error | a point must be scaled by `w` and neither `xywh` nor the asset's `size=` gives the source width |
| `media-comp-at-duplicate` | error | two comps of one shot at the same `at` |
| `media-interaction-apart` | warning | an interaction that only verifies finds its two points more than 2 px apart |

**Deliberately not implemented in v1**, though the design record describes them:
the editorial checks (`media-runtime-off-target`, `media-emotion-drift`,
`media-look-outdated`, `media-episode-mismatch`, `media-gen-before-approval`),
the model-card checks, and the timeline-shape checks (`media-track-order`,
`media-track-overlap`, `media-transition-too-long`, `media-absolute-anchor`,
`media-subtitle-unmatched`). The first real use case came near none of them, and
a diagnostic nobody has needed is a guess wearing a code.

## 9. What this profile does not admit

- **No generator API, of any vendor.** What a log entry records is *what was
  used*, never *how to call it*: no endpoint, no key, no script (§9.1 — a
  document is data, never code).
- **No editorial rules.** Shot-size repetition, hook density and line length are
  the director's, not the document's.
- **No screenplay format.** Scene headings and action lines belong to Fountain
  and its kin; `.line` only guarantees that a line has an address and a speaker.
- **No workflow engine.** No queue, no scheduler, no retry policy. What GEML
  offers a pipeline is a derived task list, idempotent writes, and a gate that
  reads "these diagnostics are empty".
- **No picture geometry of the presentation layer.** Where an overlay sits is a
  parameter the stylesheet passes to the host. A crop of the *source* frame
  (`xywh`) is a different thing and is a documented fact — and so is a layer's
  `x`/`y`/`w` (§5.1): not where a track is drawn in a player, but where a
  compositor puts pixels in a file it produces.

## 10. Versioning and scope

`geml-media/v1` is this list of names. Adding a name is a minor change; removing
one, or changing what a name means, needs `v2`. The specification does not change
either way: this profile only admits names §8.6 already lets a vocabulary admit.

2026-09-29: `media-comp`, `media-layer`, the `composite` mode and four codes were
added (§5.1), then `media-interaction`, `points`, `at`, `dx`/`dy` and eight codes
(§5.2) — names only, so minor changes; `v1` stands.
