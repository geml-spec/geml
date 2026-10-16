# geml-statechart profile v1 — one `diagram` block holds a statechart

*English | [中文](geml-statechart-profile_CN.md)*

- Status: **draft**.
- Admits: the `diagram` `format` name `geml-statechart`, and the attribute key `current` on that block. It admits no block type, no other attribute key and no meta key.
- Implementation: `@geml/geml`'s `--to html` and the viewer register a renderer, and `--to md` projects it to Mermaid; `geml check` runs the checks of §3 when the document declares this vocabulary.

## 0. What it is in one paragraph

A statechart is written in one `diagram` block: `format=geml-statechart`, and the body is a JSON object that states the nodes (the states and their attributes), the transitions — from where to where, their guard and their actions — and the variables the guards read. The renderer draws it as a state diagram: open a state to see its attributes and its incoming and outgoing edges, open a transition to see its guard and its actions. The format defines only the skeleton — a few reserved keys, and where the guard and the actions go. Every other key on a node, a transition or a variable is an attribute: shown as it is, with a meaning the program that uses the chart defines for itself. So an order flow, a game's level machine and an agent's workflow are written the same way, each carrying its own attributes.

## 1. Declaring the profile

```geml
=== meta
profile = "geml-statechart/v1"
===
```

A program that runs charts needs no vocabulary of its own: every key the format does not reserve is an attribute (§2.2), so the program's words ride in the body, and the document declares this vocabulary alone. This vocabulary has no meta key.

## 2. Blocks

### 2.1 A whole chart (an order)

```geml
=== meta
profile = "geml-statechart/v1"
===

=== diagram {#order format=geml-statechart caption="订单"}
{
  "initial": "unpaid",
  "states": {
    "unpaid":    { "title": "待支付", "owner": "买家", "deadline": "30 分钟" },
    "paid":      { "title": "已支付", "owner": "仓库", "deadline": "48 小时" },
    "shipped":   { "title": "已发货", "owner": "快递", "final": true },
    "cancelled": { "title": "已取消", "final": true }
  },
  "transitions": [
    { "from": "unpaid", "to": "paid",      "guard": "支付成功",          "actions": ["通知仓库"] },
    { "from": "unpaid", "to": "cancelled", "guard": "超过 30 分钟未支付", "actions": ["释放库存"] },
    { "from": "paid",   "to": "shipped",   "guard": "仓库确认出库" },
    { "from": "paid",   "to": "cancelled", "guard": "买家申请退款",      "actions": ["退款"] }
  ]
}
===
```

`owner` and `deadline` are this chart's own attributes; the format does not know them and draws them all the same: open "待支付" and you see the owner, the deadline and the two ways out. The guards and actions here are each one sentence, for people to read; for the program to evaluate a guard, write the variables the guard reads (§2.3).

### 2.2 The definition

The body is a JSON object. At the top level:

| key | required | value |
|---|---|---|
| `initial` | yes | the start: an id in `states` |
| `states` | yes | an object: state id → state object |
| `transitions` | yes | an array, one item per transition; may be empty |
| `vars` | no | an object: variable name → variable object |

Any other top-level key is an attribute of the statechart as a whole.

**State object**: `title` is the display name, defaulting to the id; `description` is a paragraph of explanation; `final: true` marks a final state — one the chart ends in, which has no transition out — and a chart may have several; every other key is an attribute. A state id is a GEML NAME (Unicode letters, digits, `_`, `-`). v1 has no hierarchy and no parallelism: `states`, `regions` and `initial` inside a state object are errors (§5).

**Transition object**: `from` and `to` are required, both ids in `states`, and may be the same (a self-loop); `guard` is the transition's guard (§2.3); `actions` are the actions (§2.4); `event` is reserved for v2 (§5); every other key is an attribute. The same pair of states may have several transitions. A diagnostic writes a transition as `from→to`, with an index when the pair has several: `unpaid→cancelled[2]`.

**Variable object**: `default` is required, any JSON value, and its JSON type is the variable's type; every other key is an attribute. A variable name is a NAME. The variables are the memory the guards read and the actions write; where a value comes from and when it changes is for the program to define (§5).

### 2.3 The guard

Three forms, told apart by JSON type:

| form | meaning |
|---|---|
| an object | a JSON Schema over the variables (the subset of §4); the instance is the object "variable name → current value". The program can evaluate it |
| a string starting with `#`, or of the form `doc.geml#id` | a reference to a `data` block with `format=json` whose value is an object of the kind above; a long guard, or one several transitions share, is written this way |
| any other string | a sentence. The format does not evaluate it; who does is for the program to define |

A transition without `guard` is unguarded. Every variable name an object or reference guard reads — the keys of `properties`, the names in `required`, at every level and in every branch — must be in `vars`.

A guard the program can evaluate:

```geml
=== diagram {format=geml-statechart}
{
  "initial": "draft",
  "states": { "draft": {}, "published": { "final": true } },
  "vars": { "reviewed": { "default": false }, "approvals": { "default": 0 } },
  "transitions": [
    { "from": "draft", "to": "published",
      "guard": { "properties": { "reviewed": { "const": true }, "approvals": { "enum": [2, 3] } } } }
  ]
}
===
```

### 2.4 The actions `actions`

An array, executed when the transition is taken. The format knows one kind:

```json
{ "reset": ["reviewed"] }
```

When the transition is taken these variables return to their `default`; every name must be in `vars`. Any other item — a string, or another object — is the program's own action, which the format shows as it is. An object with a `set` key is reserved for v2 (§5).

### 2.5 References

In the body, a string value starting with `#`, or of the form `doc.geml#id`, is a reference to a block, its path relative to this document. The format resolves only the references in `guard`; a reference in an attribute is resolved by the program, and the renderer draws it as a link.

### 2.6 Rendering

- A node is a state and shows its `title`; `initial` marks the start; a state marked `final` is marked final.
- An edge is labelled with: the variable names an object guard reads (sorted by name, comma-separated); the id of a reference guard; the text of a sentence guard; nothing when there is no guard.
- `current=<state id>` highlights one state, for the program to draw "where it is now".
- Opening a state shows `title`, `description`, all attributes (key → value; a reference drawn as a link; an object or an array expanded as JSON), and its outgoing and incoming edges.
- Opening a transition shows its guard (an object one read out in words per §4: `reviewed is true, and approvals is 2 or 3`), its actions and its attributes.
- The renderer is registered by the host (`--to html`, the viewer); a processor with none registered shows the body as a source block per GEML §7, which is not an error.
- The picture is inline SVG the renderer draws itself, with no diagram runtime: left to right, a state's column being the longest path from the start; an edge back or over a column runs in a lane below; each guard sits on a pill over its edge (a sentence guard marked as prose, with no judge named — §5 leaves that to the program), a transition's true flags and numbers as pills after it; the `current=` state is filled and ringed, the start has its dot, a final state a double border. The figure offers the same SVG as a file.

### 2.7 The Markdown projection

`--to md` projects it to a Mermaid `stateDiagram-v2`, which GitHub draws directly: a state is written by its id, and an id Mermaid cannot take (one with a `-`) by `state "title" as alias`; `[*] -->` points at the start, and a final state `--> [*]`; edge labels are as in §2.6. Attributes do not enter the projection.

### 2.8 The definition in a `data` block

The definition may also sit in a `data` block with `format=json`; the diagram block then writes `data=#id` and leaves its body empty:

```geml
=== data {#order-def format=json}
{ "initial": "unpaid", "states": { "unpaid": {}, "paid": { "final": true } }, "transitions": [ { "from": "unpaid", "to": "paid" } ] }
===

=== diagram {format=geml-statechart data=#order-def caption="订单"}
===
```

A coordinate then addresses every value in the definition (`geml get doc.geml '#order-def["states"]["unpaid"]'`), and `geml set` changes one value alone. `data=` points at `#id` in this document or at `doc.geml#id`, and the target is a `data` block whose value is an object; a body and `data=` may not both be present.

## 3. Checks

| code | severity | when |
|---|---|---|
| `statechart-body` | error | the body is not a JSON object; a body and `data=` are both present; `data=` points at something that is not a `data` block whose value is an object |
| `statechart-initial` | error | there is no `initial`, or it is not an id in `states` |
| `statechart-state` | error | `states` is not an object; an id is not a NAME; a state is not an object; a state holds `states`, `regions` or `initial`; `title` or `description` is not a string; `final` is not a boolean |
| `statechart-transition` | error | `transitions` is not an array; a transition is not an object; `from` or `to` is missing or not an id in `states`; there is an `event` |
| `statechart-guard` | error | it is neither an object nor a string; an object is outside the subset of §4; a reference does not resolve, or points at something that is not a `data` block whose value is an object; it reads a variable `vars` does not have |
| `statechart-actions` | error | it is not an array; `reset` is not an array of strings, or a name is not in `vars`; an object holds `set` |
| `statechart-vars` | error | `vars` is not an object; a name is not a NAME; a variable is not an object, or has no `default` |
| `statechart-current` | error | `current=` is not an id in `states` |
| `statechart-final` | error | a state marked `final` has a transition out |
| `statechart-unreachable` | warning | a state cannot be reached from `initial` |
| `statechart-dead-end` | warning | a state not marked `final` has no transition out: a forgotten transition, or a final state that should say so |

A diagnostic writes a transition as `from→to` (§2.2). A program that checks its own attributes reports these first, then its own.

## 4. The JSON Schema subset

A guard is written in this subset: any JSON root; a single scalar `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`); `properties`, `required`, boolean `additionalProperties`; `items`; scalar `enum` / `const` matching the type; `oneOf` with at least two branches of which exactly one must match; `anyOf` with at least two branches of which at least one must match, so a guard can say "this, or that"; the annotations `title`, `description`, `default`, `examples`. `anyOf` applies together with the schema's other keywords (`type`, `properties`, …). **Any other keyword is an error**, not an ignored hint — `minimum` silently doing nothing would be worse than refusing it.

## 5. What the program decides, and what is reserved for v2

What the format does not define and leaves to the program that uses the chart:

- Who evaluates a sentence guard; whether an object guard that holds is taken at once or waits for a person; who takes a transition.
- Where a variable's value comes from, when it changes and when it expires.
- What the attributes mean: `owner`, `prompt`, `approval`, … are all the program's words.
- What happens once a final state is entered.

The places reserved for v2. v1 marks these keys as errors, so when v2 defines them no v1 document changes meaning:

| place | key | reserved for |
|---|---|---|
| hierarchy | `states` and `initial` inside a state object | compound states: a statechart nested in a state |
| parallelism | `regions` inside a state object | orthogonal regions: several statecharts running at once |
| events | `event` on a transition | a transition triggered by an external event rather than by a change of a variable |
| assignment | an object with `set` in `actions` | assigning a variable a value when the transition is taken |

## 6. Conformance (informative)

`conformance.json`: each case gives the diagnostics with this vocabulary declared and without it (without it, `unknown-diagram-format:warning`, and the body stays raw), and the results of the checks of §3 when it is declared. The renderer's output is outside conformance.
