---
gep: 0008
title: Register a `form` typed block — addressable fields, an inert destination
state: draft
author: GEML (maintainer)
created: 2026-08-30
issue: (pending)
---

## Summary

Register `form` as a typed block whose **fields are addressable sub-units**:
each field carries an id that is unique **within the block**, referenced as
`[[#signup#email]]` — the same `#` narrowing operator GEML already uses at two
levels (`other.geml#id`, `path#L14-24`), applied at a third.

A `form` block **describes** a form; it never **is** one. §9.1 says a `code`
block's body "MUST NOT be run"; §8.3 gains the symmetric clause: a conforming
renderer **MUST NOT submit** a `form` block. It renders as a disabled preview.
A destination is never named by the document — the application layer supplies
one by name, exactly as `diagram {format=…}` names a renderer it does not
contain.

## Motivation

### The capability gap is structural, not a missing feature

Forms can be expressed today with no new block type. Both of these check clean
and bind through a `geml-style/v1` stylesheet
(`component=form handler=subscribe`):

```
=== table {#signup-fields .form format=csv}
field, kind,   label, required, options
email, text,   Email, true,
plan,  select, Plan,  true,     basic pro team
===
```

```
=== data {#intake .form format=json}
{"sections": [{"title": "Account", "fields": [{"name": "email", "kind": "text"}]}]}
===
```

What neither can do is let a field be **addressed**. Measured:

| Attempt | Result |
|---|---|
| `[[#signup-fields]]` | resolves — the whole block |
| `[[#signup-fields.email]]` | `unresolved reference` **error** |
| `[[#email]]` | `unresolved reference` **error** |
| `[[#intake.fields.0.name]]` | `unresolved reference` **error** |
| `geml get form.geml 'L7'` (the line holding `email`) | returns the **whole table** |
| `geml list` | lists `#signup-fields` only |

The block is the smallest addressable unit. That is a direct consequence of §4
("Ids MUST be unique per document") plus the block model — not an
implementation shortfall, and not something a richer table or data schema can
work around.

### Why that matters here specifically

This project's three claims are build-time reference checking, block-level
addressability, and agent-editability by block. A form is one of the few
structures where the **field itself** is what a reader references, an agent
edits, and a history reverts:

1. `[[#signup#email]]` in prose becomes a checked reference — rename the field
   and the build fails instead of the prose quietly lying.
2. `geml get '#signup#email'` / `geml set` edits one field, rather than
   rewriting the whole table around it.
3. `.gemlhistory` versions the field; `geml revert '#signup#email'` rolls back
   one field.

None of the three is available when the fields live inside a table's cells.

### Why the destination must never be in the document

§9 states the threat model outright: a document "may arrive from a model, a
pipeline, or a pull request". §9.4 already warns that a passive media fetch
"discloses the reader's address, and the fact and time of reading, to whoever
controls it". A form carrying `action=` is a category worse: it makes the
reader's browser POST typed data to an origin the *document* chose. Registering
a block with a document-named destination would put a phishing primitive in the
core specification.

The destination therefore stays with the host, named rather than written —
which is the pattern §9.1 already blesses for `diagram`.

## Design

### The block

```
==== form {#signup}
=== field {#email type=text required}
Email address
===
=== field {#plan type=select options="basic pro team"}
Plan
===
====
```

Note the fence lengths: §3 admits nesting only through fence-length discipline,
so a `form` holding `field` blocks MUST open with a longer run than they do.
Writing `=== form` around `=== field` closes the form at the first inner `===`.
This is a real cost of the nested shape and is revisited under *Drawbacks*.

- `form` is a **flow** container whose direct `field` children are its fields.
- `field` is registered only **inside** `form`; elsewhere it is an unknown type
  and degrades per §8.2(6).

### The field vocabulary, as the three trial forms decided it

| | where | why |
|---|---|---|
| `label=` | attribute, short plain text | measured: **9/9** fields in the next.js form have a label and every one is a single short line |
| the **body** | flow content — the description | measured: the long part is the description, carrying 15 links and 4 bold runs across up to 5 paragraphs. Flow is the only carrier here that keeps them |
| `type=` | attribute | `text` `textarea` `select` `number` `date` `url` `boolean` `file` |
| `required` | flag | |
| `value=` | attribute | a prefilled value — genuinely *the value*, unlike `style-state`'s `value-from=` which says where a value is TAKEN from. The two no longer collide |
| `multiple` | flag | one field, several values |
| options | a nested **`table`** | see below |

**Options are a nested table, not an attribute.** The next.js dropdown has 44
options and **23 of them contain spaces**, so a space-separated attribute is
dead on arrival, and §4 has no arrays. A nested table costs no new block type,
survives spaces and commas, and — because table cells parse inline — an option
label may carry markdown, which is exactly what GitHub's `checkboxes` options
support and a plain string list cannot.

```
===== form {#report handler=submit}
Prose between fields lives here, as ordinary flow content.

==== field {#area label="Which area(s) are affected?" type=select multiple required}
Select all that apply. See the [area guide](https://example.invalid/areas).

=== table {#area-options format=csv delim=;}
option        ; required
Draft Mode    ; false
create-next-app; false
===
====
=====
```

Note the fence lengths again: `form` > `field` > `table` is three levels, so
the runs must decrease outward-in. This is the sharpest form of the
fence-discipline cost recorded under *Drawbacks*.

**The shape is verified, not assumed.** `form` and `field` are unregistered, so
a processor gives them raw bodies and no nesting happens yet — `geml list` on
the block above sees only `#report`. Substituting a registered flow type
(`note`) for both, the same three-level document checks clean and delivers
everything this design depends on:

```
#report        note   L5-17      ← every level is addressable
#area          note   L8-16
#area-options  table  L11-15
```

with the field's prose keeping its inline structure (`text,link,text`) and the
option cell holding `Draft Mode` intact — a space that would have destroyed an
attribute-carried list. The only untested part of the design is the two type
names.

### Prose between fields needs no vocabulary at all

GitHub's schema has a `markdown` element because its form is a **flat array**
with nowhere else to put a paragraph. A `form` with a flow body simply holds
paragraphs between its `field` children. An earlier revision of this proposal
counted this as a fourth undefined gap; that was a bookkeeping error — the
design already closes it.

### Deliberately not defined

**Mutually exclusive groups** (`--db` XOR `--adapter`+`--raw`). §9.1 admits "no
expression language beyond the closed arithmetic of §6", and XOR is the first
step of one: after it come AND, `requiredIf`, and cross-field comparison, which
ends at logic running inside a document. GitHub, facing the same question,
declined conditional logic outright. A constraint of this kind belongs to the
host's handler, which is where it can actually be enforced.

**Repeatable fields as a concept distinct from multi-valued ones.** `--exclude`
may be given many times, which is not the same as one field taking several
values — but the distinction rests on a single instance. Both fold into
`multiple` for now; they get separated when a second instance shows the two
behaving differently, and not before.

### Field ids are scoped to their block

This is the substantive change to §4. Today the id space is flat and document
-wide. A `form`'s field ids are unique **within that form**, and the document
-level id space contains only the form's own id.

- **Address**: `#<form-id>#<field-id>` — `[[#signup#email]]`.
- **Cross-document**: `other.geml#signup#email`, composing with §5.2 unchanged.
- **Duplicate detection**: two fields with the same id inside one form is a
  `duplicate-id` error, exactly as at document level; the same field id in two
  different forms is fine, which is the whole point.
- **A bare `[[#email]]` does not resolve to a field.** Fields are reachable
  only through their form. This keeps the flat document space flat.

`#` is the separator because GEML already uses it as *the* narrowing operator
at two levels — `other.geml#id` narrows a document to a block, `path#L14-24`
narrows a file to a line range. A field is the same operation one level in.

**The separator is unambiguous by the existing NAME rule.** §4 constrains a
conforming id to letters, digits, `-`, `_`; the reference implementation warns
on anything else (`id 'a#email' is not a NAME`). A conforming id therefore
cannot contain `#`, so `#a#b` has exactly one reading. No existing conforming
document changes meaning.

### The destination

```
==== form {#subscribe-form handler=subscribe}
=== field {#email type=text required}
Email address
===
====
```

`handler` names something the **host** registers. A host that does not know
the name renders the form inert and warns — the §8.5 degradation rule, not an
error. `action`, `method`, and any URL-valued attribute are **not defined** by
this proposal and a document carrying one gets `unknown-attribute`.

### Conformance

§8.3 gains one clause, symmetric with the `code` rule it mirrors:

> 5. NOT submit a `form` block, and NOT interpret a `handler` name other
>    than by handing it to the registered external handler (§9.1).

Default rendering is a **disabled preview**: the fields are visible and
labelled, nothing is editable, nothing can be sent. Activation is the
application layer's act.

## Conformance impact

- **Parsers** gain a nested id scope for `form`. Reference resolution gains one
  production (`#a#b`); §9.3's termination argument is unaffected — a field
  address is still a lookup, not a traversal.
- **Renderers** gain the MUST NOT of §8.3(5). A renderer that ignores `form`
  entirely still conforms, since the block degrades like any unknown type for a
  processor that has not implemented it.
- **The conformance suite** gains cases for: field id scoping, `#a#b`
  resolution, duplicate field ids within one form, the same field id across two
  forms, and a bare `[[#field]]` failing to resolve.

## Alternatives considered

**Document-global field ids.** Zero specification change: authors write
`#signup-email` and live with it. Rejected because a 30-field form injects 30
names into the document space, and two forms that both have an `email` field
collide — `duplicate-id`, for a name collision that is not one. The burden
lands on every author, forever, to avoid a problem the format created.

**`.` as the separator** (`[[#signup.email]]`). Rejected: `.` already means a
class in attribute position (`{.warning}`), and reusing it for narrowing reads
as a different concept in a different place.

**Keep using `table` / `data` with a stylesheet.** This is what works today and
this proposal does not remove it. But the gate this GEP set for itself — build
two real forms first — has now been run, and it changes the claim above.

Both forms check clean. What they measured:

| | `table` | `data` |
|---|---|---|
| inline structure in a label or help text | **yes** — `` `--root` `` parses to `code`, `**repeatable**` to `strong` | **no** — a JSON string, backticks stay literal |
| nesting, groups, conditional (`showIf`) | no — rectangular | **yes** |
| an enum as a real list | no — a space-separated string | **yes** — a true array |
| help text containing the delimiter | **breaks**: `` `--lang JAVASRC\|NEWC|…` `` lost everything past the first `\|` | fine — JSON escapes |
| addressing one field | no | no |

**Neither carrier gives inline content AND structure**, and a real form wants
both: a field whose label carries a code span, inside a conditional group. That
is a stronger argument for a registered `form` than addressability alone was —
`field` bodies in **flow** mode give inline content, block nesting gives
structure, and the delimiter problem does not arise.

The delimiter collision is worth singling out because it was hit by accident
while writing the first form, not predicted: help text is exactly where prose
punctuation lives, and a CSV table's separator is the one character it cannot
contain.

### A third form, from outside this project

The two trial forms above were both written by the same hand that wrote this
proposal, which is a weak test. A real one was transcribed instead:
**vercel/next.js's "Report an issue" template** (156 lines of GitHub form
schema, 9 elements). Its shape, measured:

- a dropdown with **44 options, 23 of which contain spaces**
- **15 markdown links and 4 bold runs** across the descriptions
- descriptions up to **5 paragraphs**
- one textarea with `render: bash`

Transcribed into both carriers, the split is exact and complementary:

| what this real form needs | `table` | `data` |
|---|---|---|
| links / bold / code in a description | **yes** — a complete `[text](url)` in a cell parses to a real `link` inline | no — a literal string |
| 44 options, 23 with spaces | no — they must move to a SECOND table joined by an unchecked `field` foreign key (51 rows) | **yes** — a true array |
| a 5-paragraph description | no — newlines must be encoded (`⏎`) | **yes** |
| a comma inside a description | no — collides with the delimiter | **yes** |

**The form needs both halves at once**: a 44-option multi-select whose
description carries 15 links across 5 paragraphs. Neither carrier can hold it,
and the table workaround introduces a foreign key that nothing in GEML checks —
precisely the kind of unchecked pointer this format exists to prevent.

Worth recording as a near-miss: an earlier reading of this transcription
concluded that links do NOT survive in a table cell. That was an artefact of
truncating the cell to 60 characters mid-link, not a property of the format.
A complete link parses.

### What GitHub's own schema chose

GitHub had to make the same decisions, and its schema is instructive on two
points. It supports `markdown` elements that render prose *between* fields —
non-submitted instructional content, which neither `table` nor a flat field
list can express at all. And it **explicitly does not support conditional
logic or field dependencies**: a vocabulary designed for exactly this job, by
people who ship it at scale, declined the feature that `data` gave the trial
form for free. That is an argument for keeping `showIf` out of a registered
`form` until something demands it, not for adding it because it is expressible.

**`app-form` in a profile instead of the core.** The prototyping route, and the
right one until the shape settles: §8.5 reserves unhyphenated names for the
specification, so `form` is already unavailable to third parties and costs
nothing to leave unregistered. **This GEP should not be accepted before at
least two real forms have been built on `table`/`data`**, so that what those
strain against — and not a guess — determines the field vocabulary. That gate
has now been run (see the table above and *Drawbacks* 3); its result is that
the case for registering `form` got stronger while the proposed field
vocabulary got exposed as incomplete.

## Compatibility & migration

Additive. `form` and `field` are unknown types today, so existing processors
degrade per §8.2(6) with the body preserved. No existing conforming document
changes meaning, because no conforming id can contain `#`.

## Drawbacks & open questions

1. **It makes the id space non-flat**, which every downstream tool must learn:
   `geml list`, `geml get/set`, `geml rename`, `.gemlhistory`, the MCP server,
   the viewer. That is the real cost of this proposal, and it is not small.
   Whether one nested scope stays one, or becomes the thin end of arbitrary
   nesting, is the question to settle before accepting.
2. **`geml rename` semantics** across the two levels are unspecified here: does
   renaming a form rewrite every `#form#field` reference to it? (It should.)
3. **The field vocabulary is now settled by measurement, but on thin evidence
   in one place.** Three forms decided `label`/body/`kind`/`options` (see
   *Design*). `multiple` absorbing repeatable fields rests on **n=1** and is
   the item most likely to be wrong; it is recorded as provisional rather than
   presented as designed.

4. **Nesting costs fence discipline.** §3 admits nesting only through fence
   length, so every `form` must open with a longer run than its `field`s
   (`==== form` around `=== field`). Getting it wrong closes the form at the
   first field and truncates the rest — silently, as far as the author's intent
   goes, though `geml check` does report the unterminated block. Drafting this
   proposal hit it on the first example. A flat alternative (fields as
   `key=val` lines in a data-mode body, as `meta` does) would avoid it entirely
   but gives up flow-content labels and per-field attributes — worth weighing
   before this is accepted.
5. **Whether `field` should be addressable outside a form** — for a shared
   field definition reused by several forms — is unexplored, and would reopen
   the flat/nested question.
