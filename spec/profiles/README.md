# Application-layer profiles

A **profile** is a named vocabulary that a document declares in `=== meta`:

```geml
=== meta
profile = "geml-codemap/v1 geml-style/v1"
===
```

Declaring it admits block `type` names, attribute keys and `diagram` `format`
names that [`GEML-spec.md`](../GEML-spec.md) does not define, so `geml check`
stops reporting them as `unknown-block-type`, `unknown-attribute` or
`unknown-diagram-format`. A `table`'s or a `data` block's `format` is not
admissible — that one selects how the body is parsed, and a declaration may not
change the document model. The **mechanism**
is normative — see §8.6, *How this specification is extended* — but the **list below
is not**: §8.6 makes it implementation-defined which vocabularies a processor
recognizes, and a processor that recognizes none is still conformant. This page
records the ones this project publishes and its reference implementation knows.

Admission licenses names, and — for the types a vocabulary admits — how their
bodies are read. A processor that does **not** recognize the vocabulary reads
every one of those bodies as `raw`, the body an unknown type would have had, and
reports `unrecognized-vocabulary` saying so (§8.6 rule 3). So the two readings
can differ, and the one that sees less announces it rather than presenting a
partial document as a whole one (§8.6 rule 4, [GEP 0013](../proposals/0013-prose-body-for-vocabularies.md)).
Addresses outside those bodies are untouched either way, which is what keeps
`geml get`, `geml set` and `=== embed` behaving identically across two documents
that declare different profiles.

## Index

| Profile | Admits | Document | CLI |
|---|---|---|---|
| `geml-codemap/v1` | `anchor`, `name`, `entry-via` on `code` blocks | [geml-codemap-profile.md](geml-codemap/geml-codemap-profile.md) · [中文](geml-codemap/geml-codemap-profile_CN.md) | `geml codemap build\|verify\|render\|serve\|refresh\|find` |
| `geml-style/v1` | types `style-rule`, `style-state`, `style-screen`, `style-frame` | [geml-style-profile.md](geml-style/geml-style-profile.md) · [中文](geml-style/geml-style-profile_CN.md) | `geml style check` |
| `geml-history/v1` | types `history-revision`, `history-keyframe`, `history-blob` and their attribute keys | [geml-history-profile.md](geml-history/geml-history-profile.md) · [中文](geml-history/geml-history-profile_CN.md) | `geml history save\|get\|restore\|verify` |
| `geml-form/v1` | `form`, `form-field`, `form-group`, `form-options`, `form-note` blocks (`form` and `form-group` nest); `pattern`, `min`, `max`, `step`, `maxlength`, `accept` on `form-field` — GEP-0008, **draft** | [geml-form-profile.md](geml-form/geml-form-profile.md) · [中文](geml-form/geml-form-profile_CN.md) | — |
| `geml-media/v1` | types `media` (a timeline, or one playable source), `media-asset`, `media-clip`, `media-text` (`media` holds blocks, `media-text` is prose) and their attribute keys; `.gen-log` on a `data` block | [geml-media-profile.md](geml-media/geml-media-profile.md) · [中文](geml-media/geml-media-profile_CN.md) | — |
| `geml-translator/v1` | `translate-to` on `embed` blocks, and on `=== meta` as the document default — GEP-0010, **draft** | [geml-translator-profile.md](geml-translator/geml-translator-profile.md) · [中文](geml-translator/geml-translator-profile_CN.md) | — |

The reference implementation's registry is
[`geml-parser/src/profiles.ts`](../../geml-parser/src/profiles.ts); this table
and that file are the same list stated twice, and a test pins the naming
convention (`^geml-[a-z-]+/vN$`).

A profile may carry its own CLI verbs, as three of these do (`geml style check`
is EXPERIMENTAL; the other two are settled). That is the shape of
this layer: a vocabulary, a document that defines what the names mean, and
whatever tooling reads and writes it. Core verbs — `check`, `list`, `get`,
`set`, `add`, `delete`, `rename`, `find`, `--to` — never carry a profile name.

## Adding one

1. Decide it is a profile and not a specification change. The test is written
   down in [`../proposals/README.md`](../proposals/README.md): **does it put an
   obligation on every conforming implementation?** If yes it is a GEP, because
   a profile cannot carry a MUST — a processor that recognizes no vocabulary is
   conformant. If no, the remaining question is judgment: is this the format's,
   or one application's?
2. Name it `geml-<thing>/v1`. §8.5 reserves unhyphenated type names for future
   versions of the specification, so the vocabulary's own type names carry a
   hyphen too; the version rides in the profile name, so a changed vocabulary
   is a different name.
3. Write `<name>/<name>-profile.md` (and `_CN`) in this directory: what it
   admits, what those names mean, and what the tooling does with them.
4. Register the names in `geml-parser/src/profiles.ts` and add a row above.
