# geml-media profile v1 — assets, cuts and generation lineage

*English | [中文](geml-media-profile_CN.md)*

- Status: **draft**, and its `media-text` type depends on [GEP-0013](../../proposals/0013-prose-body-for-vocabularies.md) (draft): until a vocabulary may declare a prose body, that type is a divergence from §8.6.2 rule 4, not a licensed extension. The vocabulary below is registered in the reference
  implementation and exercised by one real use case
  ([`playground/geml-media-demo/`](../../../playground/geml-media-demo/README.md));
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
`code {src=file#L14-24}` pointing at a span of source.

## 1. Declaring the profile

```geml
=== meta
profile = "geml-media/v1"
===
```

Without the declaration the same document parses to the same model (§8.6 rule 4)
and the three type names are `unknown-block-type`. A processor that does not
recognize the profile name treats the declaration as absent (§8.6 rule 3) and is
still conformant: it sees prose and raw blocks, which is what they are.

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
| `role` | recommended | what it does in a generation: `sheet`, `master`, `lora`, `voice`, `first-frame`, `last-frame`, `style-ref`, `workflow`, `take`, or a host word. Open set |

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
| `mode` | yes | `t2i`, `i2v`, `t2v`, `tts`, `lipsync`, `upscale`, `other` |
| `prompt` | conditional | the prompt or line block |
| `prompt-sha256` | with `prompt` | the hash of the prompt **after projections are expanded**: the string the model saw |
| `prompt-refs[]` | with `prompt` | `{ref, sha256}` for **each block the prompt projects**. `prompt-sha256` alone can only say "the prompt changed"; this says *which source* changed |
| `inputs[]` | no | `{ref, sha256, role?}`: reference images, LoRAs, key frames, voice samples, the take and voice-overs a lip-sync consumes, a ComfyUI workflow |
| `seed`, `params` | no | a seed; an open map |
| `at` | yes | ISO-8601 |
| `cost`, `tool`, `prompt-text`, `error` | no | a number; where it ran; the full prompt for reproducibility; why it failed |

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
| `media-orphan-record` | info | no entry's `output-sha256` equals the asset's current value: the bytes it has now have no recorded provenance |
| `media-stale-generation` | warning | in the entry that matches the asset's current value, an input hash, `prompt-sha256` or a `prompt-refs[]` hash disagrees with the current value; the message names what changed |
| `media-stale-clip` | warning | a cut's `src` is the output of a stale entry, or of one whose ancestor is stale; the message carries the chain |

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
  (`xywh`) is a different thing and is a documented fact.

## 10. Versioning and scope

`geml-media/v1` is this list of names. Adding a name is a minor change; removing
one, or changing what a name means, needs `v2`. The specification does not change
either way: this profile only admits names §8.6 already lets a vocabulary admit.
