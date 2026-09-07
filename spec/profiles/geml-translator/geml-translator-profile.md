# geml-translator profile v1 — the language axis on `embed`

*English | [中文](geml-translator-profile_CN.md)*

- Status: **draft**, tied to [GEP-0010](../../proposals/0010-language-projections.md)
  (draft). It is registered in the reference implementation ahead of the GEP so
  that a translated document written today checks clean; every semantic below
  is the GEP's, and moves with it.
- Nature: **an application-layer profile, not part of the GEML standard.**
  §8.6.1 lists attribute keys among the things a vocabulary may admit, so the
  language axis costs the specification nothing: one key, on one block type. A
  processor that has never heard of this profile is fully conforming — it reads
  the same blocks, in the same order, and simply does not translate them.

## 0. What it is in one paragraph

A translation is the source document projected along the **language axis**, the
same shape a `.md` has along the format axis ([GEP-0006](../../proposals/0006-declared-projections.md)):
the translated file holds nothing but `embed` blocks, each naming a unit of the
source and saying which language it wants. A document that declares
`profile = "geml-translator/v1"` may write `translate-to` on those embeds — and
on `=== meta`, as the document's default — without `geml check` reporting it as
`unknown-attribute`. Because ids, block order and every non-prose byte stay in
the source and have exactly one home, a translation cannot drift from what it
translates: there is nothing in it to drift.

## 1. Declaring the profile

```geml
  === meta
  title        = "发布"
  profile      = "geml-translator/v1"
  source       = "PUBLISHING.geml"
  translate-to = "zh-cn"
  ===
  === embed {src=PUBLISHING.geml#topology}
  ===
  === embed {src=PUBLISHING.geml#prereq translate-to=none}
  ===
```

`profile` is a space-separated list, so a document may declare this alongside
another vocabulary. Admission licenses the **name** only: it does not change a
body mode, and the same bytes parse to the same document model whether or not
the profile is recognized (§8.6 rule 4).

## 2. One key, two positions

| Written on | Means |
|---|---|
| `=== meta` | the document default: every `embed` without its own value inherits this |
| an `embed` | overrides the default for that block |
| an `embed`, value `none` | hold this block back — project it, translate nothing |

The value is a language tag (`zh`, `zh-cn`, `de`). The specification does not
constrain the vocabulary of tags, for the same reason §3 does not constrain
`lang=` on a `code` block: the set belongs to the world, not to this format.

`none` earns its own spelling because **absent already means something**: an
`embed` with no `translate-to` inherits the document default, so there would
otherwise be no way to say "not this one" in a document that has a default.

## 3. Why `translate-to`, and not `lang`

`code {lang=sh}` names a **programming** language and is a statement about what
the body *already is*. A key naming a natural language here would be an
**instruction** about what to *do* with the body. Two value spaces and two word
classes under one key, in a format where a name is supposed to mean one thing.
`translate-to` is a verb, and cannot be read as either of the other two.

## 4. The prerequisite: the embeds must tile the source

This profile makes an `embed` mosaic the unit of translation, so a source
document is translatable exactly as far as it is **addressable**. The embeds
must cover the source from the end of its `meta` to the end of the file. Prose
that sits in no addressable unit — a paragraph before the first heading, say —
is not projected and therefore not translated, and nothing reports it, because
nothing was asked for it.

That is checkable: `geml list` prints a line range per unit, and gaps are
arithmetic. GEP-0010 measures the specification itself — sixteen `##` sections
tile it with no gap, and a 52-line translation projects 1349 lines of Markdown
byte-identical to the source's.

Prose nobody can address is prose nobody can embed, translate, or block-edit
either; §3's `text` block is the home for it.

## 5. What a translator must preserve

A specification cannot say how to translate. It can say what must survive, and
these are requirements on any processor that acts on `translate-to`:

- **Verbatim inline atoms.** Code spans and inline math are translated *around*,
  never through — the same rule §4 already applies to `{{key}}` interpolation.
- **Every reference, and its target.** A label may be translated; the target may
  not. `[[#id]]`, `[text](#id)`, `[^fn]` and link hrefs survive unchanged, or
  §8.2(5) turns the translation into a build error.
- **Every id, class and attribute key**, and those attribute values that *name*
  things rather than *say* them: `format=`, `src=`, `translate-to=`.
- **Block structure**: the same blocks, in the same order, with the same ids.
- **No partial output.** On failure, timeout or an unavailable engine, the block
  stands in the source language. Half a translated sentence is worse than none.

**Translate a block in one call, not one inline at a time.** Replacing the
immovable spans with placeholders keeps the atoms intact while still sending a
whole sentence; the placeholders must be inert in the target language, may be
moved by the translator, and must be **verified** on return — each exactly
once — with the whole block falling back to the source language if they are
not. Sending inline runs separately instead is measurably worse: GEP-0010
records 133 calls over one document, 57 of them shorter than 25 characters,
with 35% of prose blocks split into fragments that were then reassembled with
mismatched punctuation.

## 6. A glossary pins the words an engine would decide afresh

Structure does not drift; vocabulary does. A translator called per block
remembers nothing, so a term appearing eight times is decided eight times. The
translation may carry a settled rendering for such terms:

```geml
  === meta
  profile      = "geml-translator/v1"
  translate-to = "zh-cn"
  glossary     = "#terms"
  ===

  === table {#terms hidden}
  | term | zh-cn |
  |---|---|
  | Single Source of Truth | 单一事实来源 |
  ===
```

Three rules already in the specification do all the work: `hidden` (§4) is the
flag for structured content that enters the model and is not displayed; a
`meta` value cannot hold a table, so the key is a reference; and the table is
an ordinary block. The glossary is applied by the projection layer, not asked
of the engine — and it lives in the **translation**, because a settled
rendering is a property of the translation and not of the source.

## 7. What this profile does not admit

- **`translator=`** — reserved, not shipped. With one engine available, a key
  that selects among engines would parse, do nothing, and read as supported.
  It is reserved for when there is a second. How a processor obtains a
  translator at all — a browser built-in, an OS service, a tool, a CLI it
  shells out to — is implementation-defined, and having none is conforming.
- **`except=`** — withdrawn. An earlier draft had a list of ids to leave alone
  inside a section embed; the document default removed the need, since a mosaic
  of one embed per unit costs almost nothing to write and an exception is then
  `translate-to=none` on the one embed that means it. A second spelling would
  also have needed a core diagnostic of its own: a typo inside such a list
  draws only `unknown attribute` and never an unresolved reference — silence,
  in a vocabulary whose whole purpose is to remove it.
- **`lang=`** — see §3. It is `code`'s key, and it says something else.

## 8. Diagnostics

This profile defines **none of its own**. Everything it can get wrong is
already reported by the core:

| Situation | What you get |
|---|---|
| `translate-to` without declaring the profile | `unknown-attribute` **warning** (§Appendix A) |
| a `src=` that names nothing | `unresolved-reference` / `unresolvable-document` **error** |
| a translated reference whose target no longer resolves | the same error, in the translation |

A processor that recognizes the key but cannot translate must not pretend it
did. The reference CLI's `--to md` and `--to html` carry no translator, so they
emit the source text and say so on stderr: `translate-to=… was not applied:
this export has no translator`.

## 9. Versioning and scope

`v1` is one key. If the GEP is accepted unchanged, this document becomes its
normative statement of the vocabulary; if the GEP changes the key's name or its
positions, the profile name gains a `v2` and this file keeps describing `v1`
for documents already written against it. Nothing here changes a document
model, so a `v2` can never make an existing document parse differently — only
translate differently.
