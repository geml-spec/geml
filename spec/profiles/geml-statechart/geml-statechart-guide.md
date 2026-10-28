# geml-statechart guide

> **Status** draft · **Declare** `profile = "geml-statechart/v1"` in `=== meta` · **Limits** no nested states, no parallel regions, no events (reserved for v2)

## What it does

It writes a state machine as one `diagram` block: the states, the transitions between them with their guards and actions, and the variables the guards read.
`geml check` finds a transition to a state that does not exist, a state nothing reaches, and a state with no way out.
`--to html` draws it, and `--to md` turns it into a Mermaid diagram GitHub can show.

## Try it

You need the CLI: `npm i -g @geml/geml` (Node 22+). Save this as `review.geml`:

```geml
=== meta
profile = "geml-statechart/v1"
===

# Review flow

=== diagram {#review format=geml-statechart caption="Review"}
{
  "initial": "draft",
  "states": {
    "draft":     { "title": "Draft", "owner": "author" },
    "in-review": { "title": "In review", "owner": "reviewer" },
    "published": { "title": "Published", "final": true }
  },
  "vars": { "approvals": { "default": 0 } },
  "transitions": [
    { "from": "draft", "to": "in-review", "guard": "author submits" },
    { "from": "in-review", "to": "draft", "guard": "changes requested", "actions": [{ "reset": ["approvals"] }] },
    { "from": "in-review", "to": "published",
      "guard": { "properties": { "approvals": { "enum": [2, 3] } } } }
  ]
}
===
```

`owner` is this chart's own attribute: the format does not know it and shows it as it is.
A guard is a sentence for people, or a JSON Schema over `vars` that a program can evaluate.

Check it, then misspell `published` as `publised` in the last transition and check again:

```console
$ geml check review.geml
ok: no diagnostics
$ geml check review.geml
error: statechart-transition: transition 3: `to` names `publised`, which is not a state (review.geml#review)
1 error(s)
```

## Everyday use

Draw it. The page is self-contained SVG, with no diagram runtime:

```sh
geml review.geml --to html -o review.html
```

Show it on GitHub. `--to md` writes a Mermaid `stateDiagram-v2`:

```console
$ geml review.geml --to md
…
stateDiagram-v2
    state "Draft" as draft
    state "In review" as s1
    state "Published" as published
    [*] --> draft
    draft --> s1 : author submits
    s1 --> draft : changes requested
    s1 --> published : approvals
    published --> [*]
```

Mark where an item is now with `current=in-review` on the block; the drawing rings that state.

Find the states you forgot. A state nothing leads to, or one with no way out that is not marked `final`, is a warning. Add `"archived": { "title": "Archived" }` to `states` and check:

```console
$ geml check review.geml
warning: statechart-unreachable: state `archived` cannot be reached from `draft` (review.geml#review)
warning: statechart-dead-end: state `archived` has no transition out and is not marked final (review.geml#review)
2 warning(s)
```

Edit one value without rewriting the chart. Put the definition in a `data` block and point the diagram at it with `data=`; every value then has a coordinate:

```geml
=== data {#review-def format=json}
{ "initial": "draft",
  "states": { "draft": { "owner": "author" }, "published": { "final": true } },
  "transitions": [ { "from": "draft", "to": "published", "guard": "approved" } ] }
===

=== diagram {format=geml-statechart data=#review-def caption="Review"}
===
```

```sh
geml get review.geml '#review-def["states"]["draft"]["owner"]'   # author
echo '"editor"' | geml set review.geml '#review-def["states"]["draft"]["owner"]' --in -
```

What a guard in a sentence means, who takes a transition, and what your own attributes mean are left to the program that runs the chart (§5 of the reference).

**More:** [Reference](geml-statechart-profile.md)
