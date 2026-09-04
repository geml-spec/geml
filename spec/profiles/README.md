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

Admission licenses names only. It cannot change a block's body mode, so an
admitted type keeps the `raw` body an unknown type would have had, and the same
bytes parse to the same document model whether or not the vocabulary is
recognized (§8.6 rule 4). That is what keeps `geml get`, `geml set` and
`=== embed` behaving identically across two documents that declare different
profiles.

## Index

| Profile | Admits | Document | CLI |
|---|---|---|---|
| `geml-codemap/v1` | `anchor`, `name`, `entry-via` on `code` blocks | [geml-codemap-profile.md](geml-codemap/geml-codemap-profile.md) · [中文](geml-codemap/geml-codemap-profile_CN.md) | `geml codemap build\|verify\|render\|serve\|refresh\|find` |
| `geml-style/v1` | types `style-rule`, `style-state`, `style-screen` | [geml-style-profile.md](geml-style/geml-style-profile.md) · [中文](geml-style/geml-style-profile_CN.md) | `geml style check` |
| `geml-history/v1` | types `revision`, `keyframe`, `blob` and their attribute keys | [geml-history-profile.md](geml-history/geml-history-profile.md) · [中文](geml-history/geml-history-profile_CN.md) | `geml history save\|get\|restore\|verify` |
| `geml-form/v1` | `pattern`, `min`, `max`, `step`, `maxlength`, `accept` on `form-field` blocks — GEP-0008, **draft** | [geml-form-profile.md](geml-form/geml-form-profile.md) · [中文](geml-form/geml-form-profile_CN.md) | — |

The reference implementation's registry is
[`geml-parser/src/profiles.ts`](../../geml-parser/src/profiles.ts); this table
and that file are the same list stated twice, and a test pins the naming
convention (`^geml-[a-z-]+/vN$`).

A profile may carry its own CLI verbs, as all three do. That is the shape of
this layer: a vocabulary, a document that defines what the names mean, and
whatever tooling reads and writes it. Core verbs — `check`, `list`, `get`,
`set`, `add`, `delete`, `rename`, `find`, `--to` — never carry a profile name.

## Adding one

1. Decide it is a profile and not a specification change. The test is
   mechanical and written down in
   [`../proposals/README.md`](../proposals/README.md): **does GEML have to read
   inside the block's body?** If yes — flow content, child ids, references
   §8.2(5) requires to resolve — only §3's registry can assign a body mode, so
   it is a GEP.
2. Name it `geml-<thing>/v1`. §8.5 reserves unhyphenated type names for future
   versions of the specification, so the vocabulary's own type names carry a
   hyphen too; the version rides in the profile name, so a changed vocabulary
   is a different name.
3. Write `<name>/<name>-profile.md` (and `_CN`) in this directory: what it
   admits, what those names mean, and what the tooling does with them.
4. Register the names in `geml-parser/src/profiles.ts` and add a row above.
