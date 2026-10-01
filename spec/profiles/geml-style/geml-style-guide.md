# geml-style guide

> **Status** draft · **Declare** `profile = "geml-style/v1"` · **Limits** experimental: `geml style check` calls only `style-rule`, `match=` and attribute pass-through stable

## What it does

A stylesheet is a separate `.geml` file that says how a document is laid out and
drawn. The document itself is never changed. The stylesheet holds no script: it
names components, and the host draws them.

## Try it

Install the CLI with `npm i -g @geml/geml` (Node 22+). Make a folder with two
files. The document, `page.geml`:

```geml
# Hello

=== note {#tip}
How this note looks is decided in another file.
===
```

The stylesheet, `_index/index.geml`. A viewer looks for this exact path next to
the document (reference §1.1):

```geml
=== meta
profile = "geml-style/v1"
===

=== style-screen {#page slots="*" max-width=720px padding=24px}
===

=== style-rule {#tip-look match="note#tip" border-left="4px solid #0969da" background="#f6f8fa"}
===
```

The screen is the page, and `slots="*"` places everything in the document, in
order. The rule picks the note and gives it a border and a background.

Check the stylesheet against the document:

```
geml style check _index/index.geml page.geml
```

It prints `0 error(s), 0 warning(s)`.

To see the page, install the [GEML Viewer](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie)
in Chrome, turn on **Allow access to file URLs** in its details, and open
`page.geml`. Without a `style-screen` the viewer draws the document plain and
says why (reference §2.3). `geml page.geml --to html` ignores the stylesheet.

## Everyday use

**Catch drift after the document changes.** Run the same check again. After
`geml rename page.geml '#tip' '#hint'` it says:

```
warning: style-unmatched-rule: rule `#tip-look` matched no block in the corpus (#tip-look)
```

Warnings exit 0 and errors exit 1. Reference §8 lists every code.

**See what the host receives.** Add `--json`:
`geml style check _index/index.geml page.geml --json` prints the view model —
for each block, the rules that hit it and the values they set (reference §10).

**Edit with an agent.** Each rule is a block with an id, so an agent reads one
with `geml get _index/index.geml '#tip-look'`, replaces it with `geml set`, and
runs the check again.

**More:** [Reference](geml-style-profile.md) · [Illustrated](https://geml-spec.github.io/illustrated/10-profile-style.html) · [Demo](https://geml-spec.github.io/demos/style)
