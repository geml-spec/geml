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

| Profile | Status | Admits | Document | CLI |
|---|---|---|---|---|
| `geml-codemap/v1` | stable | `anchor`, `name`, `entry-via` on `code` blocks | [geml-codemap-profile.md](geml-codemap/geml-codemap-profile.md) · [中文](geml-codemap/geml-codemap-profile_CN.md) | `geml codemap build\|verify\|render\|serve\|refresh\|find` |
| `geml-style/v1` | draft | types `style-rule`, `style-state`, `style-screen`, `style-frame` | [geml-style-profile.md](geml-style/geml-style-profile.md) · [中文](geml-style/geml-style-profile_CN.md) | `geml style check` |
| `geml-history/v1` | stable | types `history-revision`, `history-keyframe`, `history-blob` and their attribute keys | [geml-history-profile.md](geml-history/geml-history-profile.md) · [中文](geml-history/geml-history-profile_CN.md) | `geml history save\|get\|restore\|verify` |
| `geml-form/v1` | draft | `form`, `form-field`, `form-group`, `form-options`, `form-note` blocks (`form` and `form-group` nest); `pattern`, `min`, `max`, `step`, `maxlength`, `accept` on `form-field` — GEP-0008 | [geml-form-profile.md](geml-form/geml-form-profile.md) · [中文](geml-form/geml-form-profile_CN.md) | — |
| `geml-media/v1` | draft | types `media` (a timeline, or one playable source), `media-asset`, `media-clip`, `media-text` (`media` holds blocks, `media-text` is prose) and their attribute keys; `.gen-log` on a `data` block | [geml-media-profile.md](geml-media/geml-media-profile.md) · [中文](geml-media/geml-media-profile_CN.md) | — |
| `geml-translator/v1` | draft | `translate-to` on `embed` blocks, and on `=== meta` as the document default — GEP-0010 | [geml-translator-profile.md](geml-translator/geml-translator-profile.md) · [中文](geml-translator/geml-translator-profile_CN.md) | — |

The reference implementation's registry is
[`geml-parser/src/profiles.ts`](../../geml-parser/src/profiles.ts); this table
and that file are the same list stated twice, and a test pins the naming
convention (`^geml-[a-z-]+/vN$`).

A profile may carry its own CLI verbs, as three of these do (`geml style check`
is EXPERIMENTAL; the other two are settled). That is the shape of
this layer: a vocabulary, a document that defines what the names mean, and
whatever tooling reads and writes it. Core verbs — `check`, `list`, `get`,
`set`, `add`, `delete`, `rename`, `find`, `--to` — never carry a profile name.

## Naming

A vocabulary owns the prefix of its own name: `geml-media/v1` owns `media-`.
Three kinds of name MUST carry it — the **block types** it admits, the
**diagnostic codes** its tooling emits, and the **`=== meta` keys** it reads.
None of the three is scoped by anything else, and a collision in any of them is
silent: two vocabularies that both define `style-unknown-token`, or both read `fps`,
produce a document whose meaning depends on which tooling opens it.

**Attribute keys are deliberately exempt.** They are registered per block type
(`attrs: { code: ["anchor"] }`), so the type already scopes them: this layer's
`code.anchor` cannot collide with another vocabulary's `x.anchor`. A prefix
there would be a second scoping mechanism doing a job the first already does.

§8.5 asks an extension for a hyphen so that unhyphenated names stay reserved for
future versions of the specification. This convention is that rule taken one
step further, into the two namespaces §8.5 does not mention.

The registry declares all three (`types`, `diagnostics`, `metaKeys`), and a test
in `geml-parser/test/profiles.test.mjs` enforces the rule against a table of
**recorded exceptions** — each carrying why it is there and what clears it. A
second test fails when an exception goes stale, so the table cannot quietly
become permanent. The exceptions today are `form` and `media` (bare type names),
`geml-style`'s seven unprefixed codes, and `geml-media`'s six meta keys; all
predate this convention.

`metaKeys` is what makes a vocabulary's `=== meta` namespace checkable. Only
that namespace: `=== meta` carries the **document's own** metadata too — a
`title`, a `chapter`, whatever the author wants to record — and that is the
author's and open. So `unknown-meta-key` reports a key that begins with a
declared vocabulary's prefix and that the vocabulary does not define, and says
nothing about a key with no prefix at all. An earlier draft checked the whole
block and reported this repository's own tutorial pages for `chapter = "6 / 7"`,
which is the failure mode that rule exists to avoid.

It follows that the check is quiet today, and that is honest rather than
disappointing: the meta keys in this repository predate the naming convention
and carry no prefix, so they sit in the exception table. The day one is renamed,
the check starts working on it by itself — which makes that table not only a
list of things to fix but the switch this check runs on.

A vocabulary whose `=== meta` is genuinely open declares no `metaKeys` at all.
`geml-style/v1` is one: a stylesheet's meta is an author-defined **token table**
(`{{accent}}`), the same reason its attribute space is open — the core cannot
hold that dictionary, and a closed set would report every token as a typo.

`diagnostics` is a **code → default severity** table, not a list of names, and
the core reads it for two things beyond the naming rule: `--severity` and
`--only` work on any code in it, so an important diagnostic never needs a flag
of its own, and a second implementation has one table to reproduce instead of
forty strings to find in this one.

## Checking

A vocabulary's checks run from the core `geml check`, on any document whose
`=== meta` declares it and whose vocabulary this processor recognizes. Whether a
document should be read by a vocabulary's rules is something the document
already says; asking the caller for a second command name would be asking twice.

A profile's diagnostics are reported by **address** — `doc#id` — not by line.
They are cross-document by nature (a clip in one file whose source lives in
another), so there is no one line to name, and a fabricated line 0 would be
worse than two shapes. `ProfileDiagnostic` in the registry is that shape, and it
carries a third severity, `info`, that the core has no use for: a broken
structure is an error, a stale fact is a warning, and a choice is info.

A separate verb stays right when the **input** is different: `geml style check`
takes a stylesheet and a corpus — two files in different roles — so it is not a
question about "this document" and does not belong on `check`.

Such a verb is **declared** in the registry (`ProfileDef.verbs`) and
**implemented** host-side, the same split as the checker and for the same
reason. The dispatch used to name three of them — `media`, `style`, `codemap` —
in branches of its own, so the core command line knew three vocabularies by
name; it is a lookup now, and a word no vocabulary declares is still an unknown
command.

Verbs are deliberately outside the prefix convention. That convention covers the
three namespaces that collide **inside a document** — types, diagnostic codes,
meta keys. A command line is the CLI's namespace, `geml media` reads better than
`geml media-media`, and a clash there is refused at registration rather than
prevented by spelling.

Two flags apply to these codes, and to these only:

- `--severity <code>=<error|warning|info>` re-levels one code. `info` is the
  floor: a level that silences is what `--only` is for, and the difference
  matters because a downgraded diagnostic still appears in the output and in
  `--json` — it just stops deciding the exit code.
- `--only <pattern>` keeps the profile codes matching a `*` pattern.

Neither takes a core code. Appendix A fixes the severity of every code it
defines, and a processor that moved one would not conform.

## Status

Every profile declares one of three, in the registry and in the index above:

| State | What it promises |
|---|---|
| `draft` | Still moving inside its own `/vN`, body modes included. Do not build on it. |
| `stable` | Additive only inside `/vN`: names may be added, and no existing name may change meaning or be removed. A change that is neither goes to `/vN+1`. |
| `deprecated` | Nothing more will be added. It stays readable so documents already written still parse. |

This is a repository convention and not a rule of the specification — §8.6.2
rule 3 makes it implementation-defined which vocabularies a processor
recognizes, so the specification has no place to say a vocabulary must carry a
state. It became load-bearing with
[GEP 0013](../proposals/0013-prose-body-for-vocabularies.md): before it, a
vocabulary could only add names, and "what changed inside `/v1`" was a small
question. A vocabulary may now declare **body modes**, and changing one changes
how documents parse for every processor that recognizes the name.

## Rendering

A vocabulary that draws something supplies the renderer; the core does not know
it by name. §7 already said a `diagram`'s `format=` names a **renderer** and that
an unknown one degrades to a labelled source block — so the extension point was
the specification's all along. What was missing is that the table could be
extended, and `RenderOptions.diagrams` is that table: `format` → function,
supplied by the host.

The specification's own two (`geml-chart`, `mermaid`) are built in and are
looked up **first**, so a host may add formats and may not quietly redefine one
the specification defines — otherwise the same document draws two different
things on two conformant processors.

`geml-code-graph` is the worked example. It belongs to `geml-codemap/v1`
(GEP-0003) and used to sit in the same `if` chain as the two above, so the core
renderer knew one vocabulary by name. It is registered now — by `--to html`, by
codemap's own `serve` and `render-all`, and by the browser extension — and a
build that does not register it leaves such a block to §7's fallback, which is
the correct degradation rather than an error.

One residual is worth naming rather than leaving to be found: the core table
renderer still asks `isCodemapDoc` whether to fold a long table, which is one
vocabulary's `#modules` table known by name in the renderer's own layout
heuristic. The fix is content-level rather than another slot — a `{.no-fold}`
class the vocabulary emits — and it changes generated output, so it is its own
change.

The renderer declares what a page needs through `ctx.use(name)`; the page shell
reads the set — script **and** stylesheet. `geml-code-graph`'s CSS is 5615 bytes,
larger than the core stylesheet's 4540, and it used to be inlined into every page
this renderer produced whether or not one drew a graph; a page that draws none is
46% smaller now. That is how the code-graph's runtime script reaches the page
without the shell knowing which vocabulary asked for it.

## Registering one that this repository does not ship

`geml-parser/src/profiles.ts` is a compile-time list, so until now "which
vocabularies a processor recognizes is implementation-defined" (§8.6.2 rule 3)
meant, in practice, *fork the parser*. That is conformant and it caps the
ecosystem at whatever this repository ships.

There is a runtime route now, and it is **off by default**:

```js
import { enableProfileRegistration, registerProfile } from "@geml/geml";

enableProfileRegistration();
registerProfile("acme-plot/v1", { state: "draft", types: ["acme-plot-fig"] });
```

Off by default on purpose. A host that registers a vocabulary reports different
diagnostics from a host that does not — rule 1 permits exactly that, and it is
still the **host's** decision, not something an `import` should make on its
behalf.

Registration is not the inference rule 2 forbids. Rule 2 is about guessing a
vocabulary from a document's content, name or extension; a host saying "I ship
this one" is a statement about the host, not a reading of the document.

The naming convention above is **enforced at registration**, not merely tested:
a `registerProfile` whose types, diagnostic codes or meta keys do not carry the
vocabulary's own prefix is refused, as is one that tries to replace a built-in.
The six vocabularies this repository ships carry historical exceptions; a new
one gets none, which is the only place that convention can actually stop
something.

## Conformance

Each profile carries `geml-<thing>/conformance.json` beside its document: the
**observable contract** of the vocabulary, as data.

| Field | What it fixes |
|---|---|
| `codes` | every diagnostic code and its default severity — the part a second implementation copies |
| `cases[].addresses` | the addresses a document carries when the vocabulary is recognized, and when it is not |
| `cases[].admits` | which names stop being `unknown-*` on declaration |

The addresses are the point. §8.6.2 rule 4 lets a vocabulary's **declared body
mode** change the addressable set and lets nothing else do so, and these files
are where that is pinned per vocabulary. `geml-form/v1` is the one profile whose
two readings differ — its `form` holds id-bearing `form-field` blocks — and
`geml-media/v1` is the contrast: a prose body creates no ids, so both readings
see the same addresses. A case that drifts across that line fails
`geml-parser/test/profile-conformance.test.mjs`, in either direction, and so
does a file whose `codes` or `state` stops matching the registry.

One asymmetry is worth knowing before writing a case: a **nested** admitted name
does not produce `unknown-block-type` in the undeclared reading. Its container
falls back to a `raw` body, so the block inside it is never scanned as a block
at all — it is text. `form-field` behaves this way. The suite therefore asks
that a document produce *some* `unknown-*` without its declaration, not that
every admitted name produce one.

This is not §8.4. The specification's suite is stated over the document model
and deliberately says nothing about any vocabulary — its own cases all declare a
name nothing recognizes, so that no expected projection can depend on a
processor's vocabulary list. That is right for the core, and it leaves this
layer with nothing to reproduce. These files are that, one layer up.

## Adding one

1. Decide it is a profile and not a specification change. The test is written
   down in [`../proposals/README.md`](../proposals/README.md): **does it put an
   obligation on every conforming implementation?** If yes it is a GEP, because
   a profile cannot carry a MUST — a processor that recognizes no vocabulary is
   conformant. If no, the remaining question is judgment: is this the format's,
   or one application's?
2. Name it `geml-<thing>/v1`, and give every type, diagnostic code and `=== meta`
   key it owns the prefix `<thing>-` — see **Naming** above. The version rides in
   the profile name, so a changed vocabulary is a different name.
3. Write `<name>/<name>-profile.md` (and `_CN`) in this directory: what it
   admits, what those names mean, and what the tooling does with them.
4. Register the names in `geml-parser/src/profiles.ts` — including `state`,
   which is required, and `metaKeys` / `diagnostics` if it has any — and add a
   row above carrying the same state. A test pins the two lists as one.
5. Write `geml-<thing>/conformance.json` (see **Conformance**). A registered
   profile without one fails the suite: a vocabulary nobody can reproduce is a
   vocabulary only this implementation has.
