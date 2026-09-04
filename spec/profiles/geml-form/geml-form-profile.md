# geml-form profile v1 — constraint attributes for `form-field`

*English | [中文](geml-form-profile_CN.md)*

- Status: **draft**, tied to [GEP-0008](../../proposals/0008-form-block.md)
  (draft). It lands when the GEP is accepted; until `form-field` is a
  registered type, the keys below have nothing to attach to and this document
  is a description of intent.
- Nature: **an application-layer profile, not part of the GEML standard.**
  GEP-0008 puts the `form-*` family itself in the core, because a form's
  fields need a body mode and an id scope that only §3's registry can assign.
  The *constraints* on a field need neither: they are attribute keys whose
  values a processor stores and never evaluates, which is exactly what §8.6
  lets a profile admit. Keeping them here keeps the specification's own
  contribution to five type names, their body modes and one addressing rule.

## 0. What it is in one paragraph

A document that declares `profile = "geml-form/v1"` may put six attribute
keys on a `form-field` — `pattern`, `min`, `max`, `step`, `maxlength`,
`accept` — without `geml check` reporting them as `unknown-attribute`. Each is
a **declaration** of a format or range constraint the field's value should
satisfy. Nothing in GEML checks a value against them: a `form` is a
description of a form, rendered as a disabled preview (GEP-0008, §8.3(5)), and
the only party that ever holds a user's input is the host's registered
**handler**, which is where these declarations are enforced. A stylesheet may
show them as hints; it may not judge with them.

## 1. Declaring the profile

```geml
=== meta
profile = "geml-form/v1"
===
```

Without the declaration the same document parses to the same model — §8.6
rule 4 — and the six keys are `unknown-attribute` warnings. With it, and with a
processor that recognizes the name, they are admitted. A processor that does
not recognize the name treats the declaration as absent (§8.6 rule 3) and is
still conformant.

## 2. The six keys

All six apply to `form-field` only. Each value is a string; the table says how
a handler is expected to read it. A key on a `type=` it does not fit is not an
error — the document is data — but a handler MAY ignore it and a checker MAY
warn.

| key | fits `type=` | value | what the handler enforces |
|---|---|---|---|
| `pattern` | `text`, `textarea` | a regular expression, ECMAScript syntax, matched against the whole value | the value matches |
| `min` | `number`, `date` | a number, or an ISO-8601 date for `date` | value ≥ min |
| `max` | `number`, `date` | a number, or an ISO-8601 date for `date` | value ≤ max |
| `step` | `number` | a positive number | (value − min) is a multiple of step; min defaults to 0 |
| `maxlength` | `text`, `textarea` | a non-negative integer | the value's length in characters does not exceed it |
| `accept` | `file` | a comma-separated list of extensions (`.pdf`) or media types (`image/*`) | every file offered matches one entry |

On a `multiple` field the constraint applies to **each** value. On a
`form-group` none of these keys is defined; a group's own `required` means at
least one entry.

Why these six: they are the constraints that describe **one value in
isolation**. Anything relating two fields — an end date after a start date,
two options that exclude each other, a field required only when another is
ticked — is logic, not a constraint of a field, and GEP-0008 keeps it out of
documents (*Deliberately not defined*), as §9.1 requires.

## 3. Declared, never evaluated

Three parties touch a constraint, and only one acts on it:

| party | may | may not |
|---|---|---|
| the document | declare it, as a string attribute | say what happens when it fails |
| a renderer / stylesheet | show it — `0 to 99999` under a number field, `11 digits` under a phone | reject, disable or reorder anything because of it |
| the handler | enforce it, and every rule the document cannot carry | change the document |

This is the same division GEP-0008 draws for the whole `form` block, applied
to one attribute at a time. A processor that evaluated `pattern` against a
`value=` would be running a program over a document, which §9.1 forbids.

## 4. What this profile does not admit

- **No type names.** `form`, `form-field`, `form-group`, `form-options` and
  `form-note` are the specification's (GEP-0008); a profile cannot give a type
  a body mode or an id scope.
- **No `type=` values.** The seven value shapes are closed in the GEP; an
  unknown one is `unknown-field-type`, a warning, and renders as `text`.
- **No conditional or cross-field keys** — `requiredIf`, `showIf`, `excludes`.
  See §2, and GEP-0008 *Deliberately not defined*.
- **No presentation keys** beyond what the GEP defines (`placeholder=` is the
  GEP's, not this profile's). Layout, grouping into steps and control choice
  belong to `geml-style/v1`.

## 5. Diagnostics

This profile adds no diagnostics of its own. The ones a document using it
meets are the core's and GEP-0008's:

- `unknown-attribute` — a constraint key without the profile declared;
- `unknown-field-type` — a `type=` value outside the seven;
- `form-child-outside-form`, `form-field-has-body`,
  `options-not-form-options`, `note-not-form-note`, `unused-form-block`,
  `duplicate-id` — GEP-0008's family diagnostics, unaffected by this profile.

A checker MAY additionally warn when a value is unreadable in the key's own
terms — `min=abc` on a `number`, `pattern=` that is not a valid regular
expression — but MUST NOT treat that as an error: the document is still data.

## 6. Worked example

```geml
=== meta
profile = "geml-form/v1"
===

==== form {#vendor handler=onboarding}
=== form-field {#revenue label="Annual revenue (CNY, millions)" type=number
               min=0 max=99999 step=1 description="Whole millions."}
===
=== form-field {#phone label="Mobile" type=text required pattern="^[+0-9 ]+$"
               placeholder="+86 138 0000 0000"}
===
=== form-field {#licence label="Business licence" type=file required accept=".pdf,image/*"}
===
====
```

Read by the three parties: the document says a revenue is a whole number from
zero to 99999; a stylesheet may print *0 to 99999* under the box; the handler
rejects `-1` and `12.5`. Nothing in GEML does.

## 7. Versioning and scope

The version rides in the profile name. A changed key set is `geml-form/v2`,
declared explicitly; a document declaring `v1` keeps meaning what it means.
What v1 commits to is the six keys above, on `form-field`, with the readings
in §2. What it leaves open — and expects a later version to settle from
measured forms rather than from the list of what HTML happens to offer — is
everything else HTML's inputs carry: `minlength`, `size`, `autocomplete`, and
per-type steps for `time` and `datetime` once those types exist.
