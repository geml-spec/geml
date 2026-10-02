# geml-form guide

> **Status** draft · **Declare** `profile = "geml-form/v1"` · **Limits** no tool checks input against the constraints; `geml check` does not validate form attribute values yet

## What it does

A `form` block describes a form inside a document: its fields, their labels and
types, and constraints such as `pattern` or `min`. It only describes. Nothing in
GEML submits the form or checks what people type; the application behind
`handler=` does that.

## Try it

Install the CLI with `npm i -g @geml/geml` (Node 22+). Save this as `signup.geml`:

```geml
=== meta
profile = "geml-form/v1"
===

==== form {#signup handler=subscribe}
=== form-field {#email name=email label="Work email" type=text required pattern=".+@.+"}
===
=== form-field {#seats name=seats label="Seats" type=number min=1 max=50}
===
====
```

The form's fence is one `=` longer than its fields', so the fields sit inside it.
Every field has a `name=`: the key the handler gets the value under, unique
within the form. It is also how you point at a field — `[[#signup["email"]]]`
links to it and shows its label, and `geml get signup.geml '#signup["email"]'`
prints it — so a field needs no `#id`.

```
geml check signup.geml
```

It prints `ok: no diagnostics`. Without the `meta` block, it warns that `form` is
an unknown block type.

To see it, paste the document into the [Playground](https://geml-spec.github.io/playground/).
Or install the [GEML Viewer](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie)
in Chrome, turn on **Allow access to file URLs** in its details, and open
`signup.geml`. You get a text box marked required and a number box.
`geml signup.geml --to html` does not draw forms yet.

## Everyday use

**Add a dropdown.** Put the choices in a `form-options` table inside the form,
and point a `select` field at it:

```geml
=== form-options {#plans format=csv}
value, label
basic, Basic
pro,   Pro
===
=== form-field {#plan name=plan label="Plan" type=select options=#plans}
===
```

**Catch a misspelled attribute.** `geml check` warns about any key the profile
does not know. With `minlength=5` on `#email` it prints:

```
warning: unknown attribute `minlength` for block type `form-field` (line 6)
```

It does not look at values: `type=email` and `min=abc` both pass. The six
constraint keys and how to read them are in reference §2.

**Edit one field, or let an agent do it.** Each field is a block with an id, so
you can read or replace one without touching the rest. Put the new `#seats`
block in `seats.geml`, then:

```
geml get signup.geml "#email"
geml set signup.geml "#seats" --in seats.geml
```

**More:** [Reference](geml-form-profile.md) · [Illustrated](https://geml-spec.github.io/illustrated/06-form.html)
