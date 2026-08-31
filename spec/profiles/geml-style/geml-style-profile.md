# geml-style profile v1 — vocabulary & conventions

*English | [中文](geml-style-profile_CN.md)*

- Status: v1, landed 2026-08-30. Design rationale:
  [`docs/superpowers/specs/2026-08-29-geml-style-design.md`](../../../docs/superpowers/specs/2026-08-29-geml-style-design.md).
- Nature: **an application-layer profile, not part of the GEML standard.** The
  GEML standard stays untouched; this document defines the block types and
  attributes a stylesheet uses to map blocks onto host UI components — the way
  schema.org relates to HTML, exactly as [codemap](../geml-codemap/geml-codemap-profile.md)
  does. The checker ships with the `@geml/geml` package: `geml style check`
  (source: `geml-parser/src/style-*.ts`).

## 0. What it is in one paragraph

A **stylesheet** is an ordinary `.geml` document that declares
`profile = "geml-style/v1"` and contains three kinds of block. It never modifies
the content document — rules **select into** a document rather than a template
**wrapping** one, because the content is usually machine-generated and
unmodifiable (codemap output being the case in hand). It contains **no script**:
components and handlers are *named*, and the host supplies the implementations,
the same registry pattern `diagram {format=…}` already uses. Ambiguity is a
**build error**, not a silent fallback.

## 0.1 Stability scope — read this before building on it

**Exactly one subset of v1 carries a stability commitment**: what codemap's
display knobs actually use.

| held | free to move |
|---|---|
| `profile = "geml-style/v1"` | `style-state`, `style-screen` |
| `style-rule` | `show=` `filter=` `handler=` `screen=` |
| `match=` | `on=` `value-from=` `init-value=` `type=` `layout=` |
| attribute pass-through (§2.1) | every diagnostic not raised by the held subset |

The held column is held because it **escaped**: every codemap build seeds
`_index/style.geml` into a user's repository, and those files are real. The
right column is **specified, checked, and unexercised** — zero real stylesheets
use any of it. It will move with the first genuine use case rather than be
preserved for its own sake.

That split is deliberate, not an apology. The escaped surface was kept tiny *so
that* the rest stays free: one block type, one attribute, and a pass-through
that is the host's vocabulary rather than the profile's.

The version lives in the profile name for the same reason. `geml-style/v2` can
change anything; `v1` documents keep resolving, because the vocabulary registry
is a map keyed by that name (`geml-parser/src/profiles.ts`).

## 1. Declaring the profile

```
=== meta
profile = "geml-style/v1"
===
```

`profile` is a **space-separated list**, so one document can declare several
(`profile = "geml-codemap/v1 geml-style/v1"`). Multiple profiles **union** their
vocabularies; validation only asks "is this name allowed", never "what does it
mean", so two profiles allowing the same key is one answer said twice, not a
conflict. The registry is `geml-parser/src/profiles.ts`.

Without the declaration each `style-rule` raises an `unknown-block-type`
warning — 50 rules, 50 warnings — which is what trains people to ignore
warnings. With it, `geml check` passes a stylesheet clean.

## 2. The three block types

**Every block has an empty body.** All information lives in the attribute
object, because §3 keeps the body of an *unregistered* type "preserved as raw" —
the core parser does not parse it, so anything put there cannot be checked.
Attribute objects, by contrast, are parsed for **every** type. Use §4's `\`
continuation when an attribute object gets long.

### 2.1 `style-rule` — which blocks, drawn how

```
=== style-rule {#edges match="table#calls" component=edge-list selectable}
===
```

| attribute | required | meaning |
|---|---|---|
| `match=` | **yes** | selector picking the blocks this rule applies to (§3) |
| `component=` | no | name of the host component that renders them |
| `handler=` | no | name of the host handler this block's side effect calls |
| `show=` | no | render the block a `$state` currently points at |
| `filter=` | no | narrow a collection by a `$state` (`filter="confidence=$conf"`) |
| `screen=` | no | **space-separated** screen ids; absent = every screen |
| *any other key* | no | passed through **verbatim** as a component parameter |

The pass-through is the reason a rule has no `style-unknown-attribute` check:
`selectable`, `badge="leaf"`, `collapsed` are the component's own vocabulary,
and the profile has no business ruling on it. The reserved names above are the
complete list of keys the profile itself consumes.

### 2.2 `style-state` — one cell of view state, and what feeds it

```
=== style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
===
```

| attribute | required | meaning |
|---|---|---|
| `match=` | **yes** | selector for the **producer** blocks that write this state |
| `on=` | **yes** | which interaction writes it. **Closed vocabulary**: `select` |
| `type=` | no | `block-ref` (default) or `scalar` |
| `value-from=` | no | which part of the producer to take (a column name, for a table) |
| `init-value=` | no | the value before any interaction has happened |

`match=` is the same word as on `style-rule` because it is the same thing — a
selector — and it earns §4's checking for free. `value-from=` carries its
direction on purpose: `value=to` reads as "the value is `to`", which is the
opposite of what it means.

Unknown keys here **are** a warning (`style-unknown-attribute`): unlike a rule,
a state has nothing to pass through to.

`type=` is not validated. It is currently for the reader: the kind of the value
is already implied by how it is consumed (`show="$s"` must be a block ref,
`filter="x=$s"` must be a scalar). Naming the general kind with the block type
and the specific kind with `type=` follows §7.1's `diagram {type=bar}`.

**Multiple producers are allowed.** Two blocks writing one state is assignment
over time, not a static conflict, so it is not `ambiguous-rule`.

### 2.3 `style-screen` — what goes on one screen

```
=== style-screen {#overview layout=split slots="table#calls, $sel"}
===
```

| attribute | required | meaning |
|---|---|---|
| `slots=` | **yes** | **comma-separated**, ordered. Each slot is a selector or a `$state` |
| `layout=` | no | a name the host interprets (`single` / `split` / `grid` by convention) |

A `$state` slot renders the block that state currently points at — that is how
the detail half of a master/detail view is written.

`layout=` values are **not** validated: layout is the host's business, and a
closed list here would be the profile legislating over a registry it does not
own. Unknown *keys*, however, are a `style-unknown-attribute` warning.

**There is no `route=`.** Routing belongs to the host framework; a stylesheet
declaring it again is two routers fighting. The app writes
`<GemlScreen id="overview" doc={doc}/>`.

## 3. Selector grammar

```
<type>? (.class)* (#id)? ([key] | [key=value])*      one simple selector
#api table.kpi                                       descendant (the only combinator)
table.kpi, table.summary                             comma = branches (sugar for two rules)
```

The vocabulary is exactly §4's own — type, `.class`, `#id`, attribute presence,
attribute equality — plus one combinator. Sections are the containment relation:
headings are not containers in the block model, so the relation is rebuilt from
an open heading stack.

Unsupported CSS is **named, not silently unmatched**:

| refused | why it is refused rather than ignored |
|---|---|
| `>` `+` `~` | child/sibling combinators — the block model has containment, not order-adjacency |
| `:hover` `:nth-child(…)` | state/position pseudo-classes |
| `*` | universal selector |
| `^=` `$=` `*=` `\|=` | substring matching — §9.2 keeps document text out of pattern languages |

Each raises `selector-unsupported` (error) naming the construct. CSS similarity
is meant to be a ramp, not a trap.

The scan is **zoned** — pseudo-classes are looked for only *outside* brackets,
substring operators only *inside* — because attribute values legitimately
contain `:`; codemap anchors look like `ts:render.ts#esc(string)`. A single
one-pass regex misreads those as pseudo-classes.

## 4. Conflict arbitration

Merging is **per attribute**. When two rules set the *same* attribute on the
*same* block, the winner is decided by one relation: **strict superset of
conditions**. A selector's conditions are its type, classes, id, and attribute
tests; `screen=` adds `screen:<id>`. If one rule's condition set strictly
contains the other's, it wins. Otherwise → `ambiguous-rule`, an **error**.

There is no specificity arithmetic, no `!important`, and **no source-order
fallback**. Source order is excluded deliberately: a stylesheet that resolved by
order would be silently re-rendered by the very block-level agent edits
(`geml set`, `geml add --before`) this format exists to support.

Conflicts are judged **against the corpus**: two incomparable rules are only an
error if they actually co-occur on some real block.

The diagnostic distinguishes two cases, because the remedies differ — for
*identical* selectors, "write the union of both" is impossible advice (the union
of a set with itself is itself), so that case says to delete one or add a
distinguishing condition instead.

## 5. The binding pipeline

```
interaction  →  state  →  view
```

One direction, three stages, and **state never reads state**. That is not a
cycle check that happens to pass — there is no graph, so there is no cycle to
form. The catalogue therefore has **no `binding-cycle` code**.

It also makes the pipeline **order-independent**, which §6's computed columns
are not: `style-state` blocks are top level and an agent may reorder them.

Three consumer operators:

| operator | written | meaning |
|---|---|---|
| select | `show="$sel"` | render the block `$sel` names |
| filter | `filter="confidence=$conf"` | narrow a collection by the state |
| project | `title="$sel.caption"` | take a field off the block the state points at |

No conditionals, no lookups, no cross-document references, no arithmetic — the
same restraint as §6. If you need arithmetic, use §6's computed columns.

**The operators are executed by the runtime, not by components.** A component
receives *already resolved* data: filtered rows, the selected block. Letting each
component interpret them would fork the semantics per component author and would
demote checks like `unknown-value-source` from a guarantee to a suggestion.

At *check* time the operators are validated only for **reference existence** —
every `$name` must be declared by some `style-state`. Their evaluation is the
runtime's job.

## 6. Separator conventions

One rule, and it is not arbitrary:

- **Name lists use spaces** — `profile`, `screen=`, `palette`, codemap's `entry`.
- **Selector lists use commas** — `match=`, `slots=`.

Because **space is the descendant combinator**. Splitting `slots=` on whitespace
turns `#api table.kpi` into two slots, neither of which matches anything, and
hands you an `unmatched-rule` that explains nothing about why. (Measured, not
theorised — it is how the convention was found.)

## 7. Closed vocabularies vs open registries

| kind | example | unknown member |
|---|---|---|
| **closed** — the runtime interprets these names itself | `on=` | **error** (`unknown-interaction`) |
| **open** — the host registers names the profile never sees | `component=`, `handler=` | **warning** + inert fallback |

Core GEML already draws this line the same way: `chart-unknown-type` is an
error, `unknown-diagram-format` is a warning. The open side must degrade rather
than reject, or §8.5's forward-compatibility mechanism stops working.

`unknown-component` / `unknown-handler` fire **only when the caller declares its
registry** (`--components=`, `--handlers=`). Without the flags the check does not
run — a diagnostic that can never fire is worse than no diagnostic, and
pretending to have checked is worse still.

## 8. Diagnostics catalogue

These codes belong to **this profile's catalogue**. They are deliberately *not*
in GEML's Appendix A — a profile is not the standard.

Severity philosophy: **structural error = error; unknown name = warning + inert
fallback**, which is what preserves §8.5.

| code | severity | catches |
|---|---|---|
| `selector-unsupported` | error | an unsupported CSS construct, named |
| `ambiguous-rule` | error | identical or incomparable rules setting one attribute |
| `unknown-state` | error | a rule or slot references a `$foo` nobody declares |
| `unknown-screen` | error | `screen=` names no `style-screen` block |
| `unknown-value-source` | error | `value-from=` is not a column of the target table |
| `unknown-interaction` | error | `on=` is not in the closed interaction vocabulary |
| `style-missing-attribute` | error | a required attribute is absent |
| `unmatched-rule` | warning | a rule (or screen slot) matched no block in the corpus |
| `unmatched-producer` | warning | a state's `match=` matched no block |
| `unknown-component` | warning | not in the declared registry → renders inert |
| `unknown-handler` | warning | not in the declared registry → renders inert |
| `style-unknown-attribute` | warning | an unknown key on `style-state` / `style-screen` |

`unknown-value-source` is checkable because §6 gives tables a real schema. When
the producer is not a table the check is **skipped**, not guessed at.

`unmatched-rule` is the style layer's `bad-source-range`: the stylesheet is
internally consistent but has drifted from the corpus it styles.

## 9. Checking

```
geml style check <stylesheet.geml> <corpus…> [--json] [--components=a,b] [--handlers=x,y]
```

Exit 0 clean or warnings-only, 1 on errors, 2 on usage errors. `--json` prints
the view model.

## 10. The view model — the conformance surface

`--json` is what a second implementation must agree on (§8.4's shape), and it is
what a host consumes. It has four fields:

| field | shape |
|---|---|
| `states` | `{id, type, on, valueFrom?, initValue?}[]` |
| `screens` | `{id, layout?, slots, bindings}[]` |
| `bindings` | the screen-unqualified table |
| `diagnostics` | `{severity, code, message, rule?}[]` |

A **binding** is `{doc, block, rules, params}`. `doc` is **not redundant**: §4
guarantees id uniqueness only *within a document*, and one stylesheet over a
whole directory is the normal case, so two documents may each hold a `#budget`.
Without `doc` a consumer cannot join a binding back to the right block.

**Bindings are per screen.** `screen=` gives one block different presentations on
different screens, so a single global table cannot exist; the top-level
`bindings` is the screen-unqualified one, and every `screens[].bindings` is that
screen's. A consumer must look up bindings *with* a screen context.

**Slots arrive resolved**, never as selector strings:

```json
{"kind": "blocks", "selector": "table#calls", "blocks": [{"doc": "…", "block": "#calls"}]}
{"kind": "state",  "state": "sel"}
```

A consumer handed raw selectors would have to redo the build-time solve at
runtime, and a bootleg runtime matcher inevitably forks from build-time
semantics. This one was caught by the consumer spike, which was forced to write
a `slotMatches()` that only understood `type#id`.

## 11. Worked example: codemap's display knobs

The first real stylesheet is the one codemap seeds at
`<codemap>/_index/style.geml`:

```
=== meta
profile = "geml-style/v1"
title = "codemap graph style"
===

=== style-rule {#graph match="diagram[format=geml-code-graph]" \
                fold=1 depth=6 hide-accessors=true \
                palette="#e3f2fd #e8f5e9 …"}
===
```

Every knob there is a **component parameter** (§2.1's pass-through), not profile
vocabulary — `fold`, `depth`, `hide-accessors`, `palette` are the code-graph
renderer's own words. `palette` is a *name* list, so it is space-separated (§6).

It sits beside `foldings.geml`, and the pair is the point: `foldings.geml` tunes
**build-time** module naming, `style.geml` tunes **display**. Both are seeded on
first build and never rewritten by a later one. Before this, the display half was
hardcoded in the renderer, so "I want to adjust how it looks" meant editing a
renderer that serves everyone — every change forced to be universal.

The renderer is **not** replaced. Only where its numbers come from changed, so
its defaults must equal today's behaviour knob for knob, and the existing codemap
tests pass unchanged. A missing or unreadable stylesheet falls back to the
built-in defaults — exactly the behaviour that predates the file.

## 12. Versioning and scope

`geml-style/v1`. A new vocabulary member is a new version; the profile name is
the compatibility unit, and unknown members degrade per §7.

**v1 deliberately does not have**: script of any kind, URLs (dev/staging/prod
differ — a written-in address binds the stylesheet to an environment), routing,
theming beyond design tokens (reuse the `data` block, GEP-0005), or any body
content in its three block types.

**Named but not yet exercised by a real stylesheet**: everything in §0.1's right
column. `filter=` in particular has never run against real noise (mustapi's edges
are all `kind=call` with empty confidence — nothing to filter), `handler=` has no
real host, and the closed `on=` vocabulary has exactly one member because exactly
one interaction is actually wired. They are specified and checked, not
battle-tested, and §0.1 says what that buys you.

`geml style check` is marked EXPERIMENTAL in `geml --help` for this reason. It
works, it is tested, and its vocabulary is not yet settled — a command you can
rely on to be correct today, not to be spelled the same next year.
