---
gep: 0008
title: Register a `form` typed block — addressable fields, an inert destination
state: draft
author: GEML (maintainer)
created: 2026-08-30
issue: (pending)
---

## Summary

Register `form` as a typed block, and with it a family of four child types
that are meaningful only inside one — `form-field`, `form-group`,
`form-options`, `form-note` — whose **ids live in the form's own scope**. A
field is referenced as `[[#signup#email]]`, a field in a group as
`[[#vendor#contacts#email]]`: the same `#` narrowing operator GEML already
uses at two levels (`other.geml#id`, `path#L14-24`), applied once or twice
more. Groups do not nest, so three segments is the maximum. A `form` is
self-contained: everything a renderer or a handler needs is inside its fences.

A `form` block **describes** a form; it never **is** one. §9.1 says a `code`
block's body "MUST NOT be run"; §8.3 gains the symmetric clause: a conforming
renderer **MUST NOT submit** a `form` block. It renders as a disabled preview.
A destination is never named by the document — the application layer supplies
one by name, exactly as `diagram {format=…}` names a renderer it does not
contain. A field's format and range constraints (`pattern`, `min`, `max`, …)
are **declared, never evaluated**, and come from the `geml-form/v1` profile
rather than from this specification.

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
==== form {#signup handler=subscribe}
=== form-field {#email label="Email address" type=text required}
===
=== form-options {#plans format=csv delim=;}
value ; label
basic ; Basic
pro   ; Pro
team  ; Team
===
=== form-field {#plan label="Plan" type=select options=#plans}
===
====
```

A `form` is a **flow** container. Its body holds its `form-*` children,
ordinary headings and ordinary paragraphs. A field's text lives in attributes
— `label=`, `description=`, `placeholder=` — all plain; a `form-field` body is
**empty**, and a non-empty one is a warning (`form-field-has-body`). One rule,
no exceptions.

Note the fence lengths: §3 admits nesting only through fence-length discipline,
so a `form` MUST open with a longer run than its children. Writing `=== form`
around `=== form-field` closes the form at the first child. Because a field
holds nothing and an options list sits beside its field rather than inside it,
the family never needs more than three levels: `form` at five `=`, a
`form-group` at four, everything else at three.

### The `form-*` family, and why the children carry the parent's name

The children are named `form-field`, `form-group`, `form-options` and
`form-note` rather than `field`, `group`, `table` and `text`, for three
reasons a first draft with bare names ran into.

- **One type, one meaning.** With a bare `table` as the option list, `table`
  had two logics — a data table outside a form, an option list inside a field
  — and a `geml-chart` could bind to an option list. `form-options` is its own
  type: `options=` may name only a `form-options`, and a `table` is always a
  table.
- **Bound text.** Guidance that needs a link or a second paragraph could only
  be a paragraph *near* its field. `form-note` is a block of flow content a
  field **points at** — `description=#coc-note` — by a checked reference, the
  same way it points at its options; a renderer hangs it on the control as
  `aria-describedby`, several fields may share one, and the field's own body
  stays empty.
- **Self-describing structure.** `geml list` shows which blocks belong to a
  form without reading them, and a `form-*` block outside a form is an
  unambiguous **error** (`form-child-outside-form`) rather than an unknown
  type with a raw body.

**Every `form-*` block is meaningful only inside a `form`, and every `form-*`
id lives in the form's scope** (§ *Field ids*). `form-field` may sit in a
form or in a group; `form-group`, `form-options` and `form-note` sit directly
in the form, and a group holds only fields. A heading or a paragraph inside a form is not a `form-*` block
and keeps its ordinary, document-level behaviour. The consequence is that a
form is **self-contained**: `geml get '#vendor'` returns everything a renderer
or a handler needs, and nothing inside a form reaches into another.

**§8.5 gains one sentence.** It reserves unhyphenated names for this
specification and asks extensions to hyphenate; it does not forbid this
specification a hyphen, and a child type named after its parent is the
natural use of one. What it must now also say is the converse: an extension
type name SHOULD NOT begin with a registered type name followed by `-`,
because `form-` is now this specification's. Published profile names
(`style-rule`, `revision`, `keyframe`) are unaffected; none starts with a
registered type.

### The field vocabulary, as the trial forms and one review decided it

The forms are [`0008-form-block-example/`](0008-form-block-example/README.md) —
two built on today's carriers plus the stylesheet that binds them, checked in
and re-measurable, and a third written against a deliberately complex form
(`complex-form.geml`). Every "measured:" figure below is read off them.

| | where | why |
|---|---|---|
| `label=` | attribute: plain text, or `#id` of a `form-note` | measured: **9/9** fields in the next.js form have a label and every one is a single short line, so plain text is the common case. Absent, a renderer shows the field id. A label that wants a link points at a `form-note` (§ *Prose, headings and form-note*) |
| `description=` | attribute: plain text, or `#id` of a `form-note` | the help text shown with the control. Plain for one line; a `form-note` for links, bold or several paragraphs |
| `placeholder=` | attribute: plain text, or `#id` of a `form-note` | the grey text an empty control shows. It vanishes on input, where `description` stays. Same rule as the other two for uniformity; a renderer flattens a `form-note` here to plain text, since a placeholder cannot carry markup |
| `type=` | attribute, one of **seven** values | `text` `textarea` `number` `date` `boolean` `select` `file`. Chosen by the shape of the **value**, not of the control: `url`, `email`, `tel` and `path` are all strings and fold into `text`, with `pattern=` where the format matters. Measured across the three forms: text 11, textarea 7, select 4, number 1, date 1, boolean 1, file 0. `file` stays because its value is unlike any other; `time` and `datetime` wait for an instance. Any other value is `unknown-field-type`, a **warning**, and the field renders as `text` |
| `required` | flag | |
| `multiple` | flag | on a `form-field`: one field, several values. Not an attribute of `form-group`, which repeats by definition (§ *Groups*) |
| `value=` | attribute | a prefilled value — genuinely *the value*, unlike `style-state`'s `value-from=` which says where a value is TAKEN from. On a `multiple` field it names the **single** preselected option: §4 has no arrays, so a document cannot preselect two, and does not try to |
| `options=#id` | attribute, a checked reference | the option list of a `select`: a `form-options` in the same form (below) |
| the body | **empty** | a field carries no prose and no blocks of its own; a non-empty body is `form-field-has-body`, a **warning**, and is not rendered |

**A `#` at the start of a `form-field` attribute value is a reference**, to a
`form-*` block of the enclosing form; anything else is text. GEML already
reads `src=` this way — `#id` names a block, anything else is a path — so no
new rule is added, only applied to four more attributes: `options=` must land
on a `form-options`, and `label=`, `description=`, `placeholder=` on a
`form-note`; landing on anything else is an error. A label that must *begin*
with a literal `#` goes in a `form-note`.

**Options are a `form-options` block the field points at.** The next.js
dropdown has 44 options and **23 of them contain spaces**, so a
space-separated attribute is dead on arrival, and §4 has no arrays.
`form-options` has a table body — `format=csv`/`tsv`, `delim=`, and `src=` to
bring a long list in from a file, all as §3 defines them for `table` — and is
its own type so that a table is never two things. `options=` names one by the
id it has in the enclosing form (`options=#plans` inside `#signup` means
`#signup#plans`); naming a `table`, or nothing, is an **error**. The
contract: the **first column** is the value submitted; a column headed
`label` is the text shown, and because cells parse inline it may carry a link
or bold — what GitHub's `checkboxes` options support and a plain string list
cannot; further columns pass through to the handler unread. A `form-options`
no field points at is a warning (`unused-form-block`). Two forms wanting the
same list point their `src=` at the same file; a form does not reach into
another.

```
=== meta
profile = "geml-form/v1"
===

==== form {#report handler=submit}
Select every area that applies. See the [area guide](https://example.invalid/areas)
first; when unsure, pick the closest and say so below.

=== form-options {#areas format=csv delim=;}
value           ; label
draft-mode      ; Draft Mode
create-next-app ; create-next-app
turbopack       ; [Turbopack](https://example.invalid/turbopack)
===
=== form-field {#area label="Which area(s) are affected?" type=select multiple required
               options=#areas}
===
=== form-field {#version label="Next.js version" type=text required
               pattern="^\d+\.\d+\.\d+" placeholder="15.0.3"}
===
====
```

The `pattern=` on `#version` is admitted by the declared profile (§
*Constraints live in a profile*); without the `profile` line it is an
`unknown-attribute` warning, and the document means the same thing.

**The shape is verified, not assumed.** The `form-*` types are unregistered,
so a processor gives them raw bodies and no nesting happens yet — `geml list`
on the block above sees only `#report`. Substituting a registered flow type
(`note`) for the containers, the same documents check clean of errors and
deliver everything this design depends on: every level addressable, the
form's prose keeping its inline structure, an option cell holding `Draft Mode`
intact — a space that would have destroyed an attribute-carried list — and a
three-deep nesting (`form › form-group › form-field`) with option lists
beside their fields parsing with no diagnostics. Hyphenated type names parse
today; the `geml-style/v1` profile's `style-rule` is one. The only untested
part of the design is the type names themselves.

### Groups, and fields that repeat

A real form has two things that look alike and are not. A **multi-valued
field** — tags, several files — is one field with several values, and
`multiple` on a `form-field` says so. A **repeating group** — "add another
contact", each contact a name, an email and a role — is a set of fields that
recurs as a unit. Ant Design calls the second `Form.List`. An earlier revision
of this proposal folded it into `multiple` on the strength of one instance and
recorded that as provisional; the complex trial form supplied the second
instance, and the two behave differently: a repeated group has *structure* per
repetition, a multi-valued field has none.

```
==== form-group {#contacts label="Contacts" required
                description="At least one; add as many as needed."}
=== form-field {#name label="Name" type=text required}
===
=== form-field {#email label="Email" type=text pattern="^[^@]+@[^@]+$" required}
===
=== form-field {#role label="Role" type=select options=#roles}
===
====
```

- `form-group` is a container of `form-field`s, and it **repeats by
  definition**: its value is a sequence of entries, each entry the ordered set
  of its children's values. `required` means at least one entry. `multiple` is
  not one of its attributes — there is nothing for it to add.
- A group sits directly in a form and holds only fields: **groups do not
  nest**. No trial form had a repeating group inside a repeating group, and
  not nesting fixes the scope depth at two (form, then group), the address at
  three segments, and the fence at five `=` — no downstream tool has to walk a
  recursive scope. A `form-group` inside a `form-group` is an error
  (`form-child-outside-form`, the same one that catches a stray field). It
  waits for an instance, as `multiple`'s split did.
- A group is a shape of structure, not a shape of value, which is why it is a
  type of its own and not a `type=` value.
- A group's fields are addressed **through** it: `#vendor#contacts#email`.
  Address depth follows nesting depth (§ *Field ids*).
- A group is **not** the way to put a heading over a run of fields — a heading
  does that (§ *Prose, headings and form-note*). A non-repeating composite is
  not defined (*Deliberately not defined*).
- `options=#roles` above resolves in the enclosing **form**, not the group:
  `form-options` sit directly in the form, so one list can serve a field in any
  group.

### Prose, headings and `form-note` between fields

GitHub's schema has a `markdown` element because its form is a **flat array**
with nowhere else to put a paragraph. A `form` with a flow body simply holds
paragraphs between its children; they are ordinary paragraphs, bound to
nothing, and that is the right carrier for an introduction or a note between
two sections.

Text that belongs to **a field** and needs more than a plain line — a link,
bold, a second paragraph — is a `form-note`, and the field points at it:

```
=== form-note {#coc-note}
Read the [code of conduct](https://example.invalid/coc) first. Ticking the box
accepts its **anti-bribery** and **data protection** clauses.
===
=== form-field {#agree label="I have read and accept the code of conduct" type=boolean required
               description=#coc-note}
===
```

A `form-note` is a passive resource, like a `form-options`: it has no
attribute of its own pointing back, several fields may name the same one, and
one no field names is a warning (`unused-form-block`). `label=`,
`description=` and `placeholder=` may each name one; a renderer shows the text
in that role and links it to the control (`aria-describedby`), flattening it
to plain text only where the role cannot carry markup (a placeholder). The
next.js form's five-paragraph, fifteen-link descriptions are `form-note`
blocks, one per field, and lose nothing.

**Headings are allowed inside a `form`**, and they are ordinary headings: a
heading's id lives in the document-level id space — it is not a `form-*` block
— and a heading is never a field. Its section ends at the enclosing `form` or
`form-group` fence, or at the next heading of the same or higher level,
whichever comes first. This is how a long form is divided into visible parts;
`form-group` is not needed for that.

### Constraints live in a profile

A field's **format and range constraints** — `pattern`, `min`, `max`, `step`,
`maxlength`, `accept` — are attribute keys on `form-field` admitted by the
`geml-form/v1` profile (§8.6), not by this specification. A document that
uses them declares the profile in `=== meta`; one that does not gets
`unknown-attribute` warnings and means the same thing, which is §8.6's rule 4
doing its job.

Two properties hold either way:

- They are **declarations**, never evaluated. A processor stores the string;
  §9.1 forbids it doing anything else with it. Whether a renderer shows
  `min=0 max=99999` as a hint is the stylesheet's choice; enforcing it is the
  handler's.
- They are the only kind of constraint a document carries. Cross-field rules,
  conditional requirement and mutual exclusion are not constraints *of a
  field*; they are logic, and stay out (*Deliberately not defined*).

Keeping them in a profile keeps this specification's contribution to exactly
what needs the core: five type names, their body modes, and one addressing
rule. The profile document, `spec/profiles/geml-form/geml-form-profile.md`,
is written alongside this GEP's acceptance and added to the reference
implementation's profile registry.

### Deliberately not defined

**Mutually exclusive groups** (`--db` XOR `--adapter`+`--raw`). §9.1 admits "no
expression language beyond the closed arithmetic of §6", and XOR is the first
step of one: after it come AND, `requiredIf`, and cross-field comparison, which
ends at logic running inside a document. GitHub, facing the same question,
declined conditional logic outright. A constraint of this kind belongs to the
host's handler, which is where it can actually be enforced.

**Inline markup inside an attribute.** GitHub's `description` is markdown and
its checkbox labels are too; here an attribute value is a plain line, as §4
has always said, and a field's body is always empty. What needs a link is a
`form-note` the attribute points at, which is the stronger carrier anyway: a
block, addressable, multi-paragraph, shareable.

**Repeatable fields as a concept distinct from multi-valued ones** used to be
listed here, pending a second instance. It arrived, and the distinction is now
defined (*Groups, and fields that repeat*).

**A non-repeating composite** — an "address" made of street, city and code,
addressed as one unit but occurring once. `form-group` always repeats; a
heading covers the visual case; and no trial form had a composite value that
was not also a list. It waits for an instance, as `multiple`'s split did.

**Nested groups** — a repeating group inside a repeating group. No trial form
had one, and not admitting it bounds the id scope at two levels for every
downstream tool (*Drawbacks* 1). It waits for an instance too.

### Field ids are scoped to their form

This is the substantive change to §4. Today the id space is flat and document
-wide. A `form` opens a nested scope; every `form-*` block inside it — field,
group, options list, note — takes its id **in that scope**, and a `form-group`
opens one further scope for its fields. Groups do not nest, so there are at
most two nested scopes. The document-level id space contains only the form's
own id, plus the ids of any headings inside the form, which are not `form-*`
blocks and stay document-level.

- **Address**: one `#` per level — `[[#signup#email]]`,
  `[[#vendor#contacts#email]]`, `[[#report#areas]]` for an options list.
  Three segments is the maximum.
- **Cross-document**: `other.geml#vendor#contacts#email`, composing with §5.2
  unchanged.
- **Duplicate detection**: two `form-*` blocks with the same id in one scope,
  whatever their types, is a `duplicate-id` error, exactly as at document
  level; the same id in two different scopes — two forms, or two groups — is
  fine, which is the whole point.
- **A bare `[[#email]]` does not resolve to a field**, and neither does a
  partial path — `[[#vendor#email]]` for a field that lives in `#contacts`.
  From outside a form, its contents are reachable only through the full path.
  This keeps the flat document space flat.
- **Inside a form, a `form-field`'s `#` attributes resolve relative to it.**
  `options=`, `label=`, `description=` and `placeholder=` name a `form-*`
  block *of the enclosing form* — `options=#plans`, `description=#coc-note` —
  because that is the only place their target can be, and writing
  `#signup#plans` there would name a path that does not exist inside
  `#signup`. These are the only relative references in GEML, confined to the
  attributes of one type that cannot point anywhere else; every other `#` in a
  document is absolute, and a `form-note` or `form-options` has no attribute
  pointing back.

`#` is the separator because GEML already uses it as *the* narrowing operator
at two levels — `other.geml#id` narrows a document to a block, `path#L14-24`
narrows a file to a line range. A field is the same operation one level in,
and a field in a group is the same operation once more.

**The separator is unambiguous by the existing NAME rule.** §4 constrains a
conforming id to letters, digits, `-`, `_`; the reference implementation warns
on anything else (`id 'a#email' is not a NAME`). A conforming id therefore
cannot contain `#`, so `#a#b#c` has exactly one reading. No existing conforming
document changes meaning.

Unnamed inner units — a table's cells, a `data` block's value tree — take
coordinates rather than ids; that is
[GEP 0011](0011-inner-unit-coordinates.md)'s. This rule stays here, scoped to
the `form-*` family, because it has exactly one consumer: §3's registry holds
no other container-mode type to generalize it from.

### The destination

```
==== form {#subscribe-form handler=subscribe}
=== form-field {#email label="Email address" type=text required}
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

- **Parsers** gain five registered types — `form` (flow), `form-field` (empty
  body), `form-group` (flow, `form-field` children only), `form-options` (a
  table body), `form-note` (flow) — and a nested id scope for `form` and, one
  level down, `form-group`; groups do not nest, so the depth is bounded at
  two. Reference resolution gains one production (`#a#b`), applied at most
  twice; §9.3's termination argument is unaffected — a field address is still
  a lookup per level, not a traversal. A `form-field`'s `#` attributes resolve
  within the enclosing form.
- **Diagnostics** gain: `form-child-outside-form` (**error**; a `form-*`
  block outside a `form`, or a `form-group` / `form-options` / `form-note`
  anywhere but directly in one — the usual cause is a `form` fence one `=`
  too short), `form-field-has-body` (warning), `unknown-field-type` (warning; the
  field renders as `text`), `options-not-form-options` (**error**; `options=`
  names something other than a `form-options` in this form),
  `note-not-form-note` (**error**; a `#` in `label=`, `description=` or
  `placeholder=` names something other than a `form-note` in this form),
  `unused-form-block` (warning; a `form-options` or `form-note` no field
  points at), and `duplicate-id` applied per scope.
- **§8.5** gains the converse sentence: an extension type name SHOULD NOT
  begin with a registered type name followed by `-`.
- **Renderers** gain the MUST NOT of §8.3(5). A renderer that ignores `form`
  entirely still conforms, since the block degrades like any unknown type for a
  processor that has not implemented it.
- **A profile**, `geml-form/v1`, admitting the six constraint keys on
  `form-field`. It is added to `spec/profiles/README.md` and to the reference
  implementation's profile registry, and needs nothing from §3.
- **The conformance suite** gains cases for: id scoping at two and three
  levels; `#a#b#c` resolution; a `form-group` inside a `form-group` (error); a
  partial path failing to resolve; duplicate
  ids within one scope across `form-*` types; the same id across two scopes; a
  bare `[[#field]]` failing to resolve; `options=` naming a `table` (error)
  and a missing block (error); `description=#id` naming a `form-note`, a
  `form-options` (error) and nothing (error); a `label=` whose plain text
  happens to contain a `#` after its first character; an unknown `type=` value
  (warning); a `form-*` block outside a `form` (error); a non-empty
  `form-field` body (warning); a heading inside a `form` keeping its
  document-level id; and a constraint key with and without the profile
  declared.

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
two real forms first — has now been run
([`0008-form-block-example/`](0008-form-block-example/README.md)), and it changes the claim
above.

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

Additive. The `form-*` names are unknown types today, so existing processors
degrade per §8.2(6) with the body preserved. No existing conforming document
changes meaning, because no conforming id can contain `#`, and no published
profile name begins with a registered type. The constraint keys arrive through
a profile, so a document that omits the declaration is warned, not broken. The
one document written to this proposal's earlier drafts —
`0008-form-block-example/complex-form.geml`, with `field` blocks carrying help
text in their bodies and option tables inside them — is rewritten to the
family when this GEP is accepted; `form-field-has-body` is the diagnostic that
would have caught it.

## Drawbacks & open questions

1. **It makes the id space non-flat**, which every downstream tool must
   learn: `geml list`, `geml get/set`, `geml rename`, `.gemlhistory`, the MCP
   server, the viewer. That is the real cost of this proposal, and it is not
   small. The earlier open question — whether one nested scope stays one — is
   answered by bounding it: a form opens one scope and a group one more, and
   groups do not nest, so no tool walks a recursive scope. If nested groups
   are ever admitted, this item reopens.
2. **`geml rename` semantics** across the levels are unspecified here: does
   renaming a form rewrite every `#form#…` reference to it, and every
   `options=` / `description=` inside it when a child is renamed? (It should.)
3. **The field vocabulary is settled by measurement and one review.** `label=`
   and `description=` are single plain lines, and a `form-field` body is
   always empty, because the review wanted a field's text in attributes and
   one rule for the body. What the measurement asked for — link-carrying,
   multi-paragraph guidance bound to a field — is carried by `form-note`
   instead, and nothing measured is lost. The provisional item about
   `multiple` absorbing repetition is closed. What is new and unmeasured is
   the family itself: five type names where the first draft had two, and the
   first hyphenated names in §3's registry. The cost is vocabulary, and it is
   the price of a `table` meaning one thing.
4. **Nesting costs fence discipline.** §3 admits nesting only through fence
   length, so every `form` must open with a longer run than its children
   (`==== form` around `=== form-field`), and a `form-group` adds a level;
   because fields are empty and option lists sit beside them, three levels is
   the maximum. Getting it wrong closes the form at the first child and
   orphans the rest — which now fail `geml check` outright as
   `form-child-outside-form`, naming the usual cause. Drafting this proposal
   hit it on the first example. A flat alternative (fields as `key=val` lines
   in a data-mode body, as `meta` does) would avoid it entirely but gives up
   per-field attributes, bound `form-note`, and — the point of this proposal —
   a field as an addressable block. Worth weighing before this is accepted.
5. **Whether a `form-field` should be addressable outside a form** — for a
   shared field definition reused by several forms — is unexplored, and would
   reopen the flat/nested question. Shared *option lists* have an answer
   (`src=` to one file); shared fields do not.
6. **Relative references, on one type.** A `form-field`'s `options=`,
   `label=`, `description=` and `placeholder=` resolve within the enclosing
   form, the first relative resolution in GEML. It is confined to the
   attributes of one type that can point nowhere else, and it is what makes a
   form self-contained — but it is a second way to read a `#`, and is recorded
   here as such. The leading-`#` test that tells a reference from text is the
   one `src=` already uses, so it adds no second convention.
