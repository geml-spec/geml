# geml-style profile v1 — vocabulary & conventions

*English | [中文](geml-style-profile_CN.md)*

- Status: v1, landed 2026-08-30. Design rationale:
  [`docs/design/specs/2026-08-29-geml-style-design.md`](../../../docs/design/specs/2026-08-29-geml-style-design.md).
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

**See one.** [`playground/style-demo/`](../../../playground/style-demo) is a
whole page built this way — a 1:1 replica of a GitHub blob page, where
`page.geml` holds every string and `github.style.geml` holds every colour,
length and state. It needs `geml-viewer` installed and a local server;
[the playground's README](../../../playground/README.md#the-page-layout-demo-style-demo)
says why and gives the two commands.

## 0.1 Stability scope — read this before building on it

**Exactly one subset of v1 carries a stability commitment**: what codemap's
display knobs actually use.

| held | free to move |
|---|---|
| `profile = "geml-style/v1"` | `style-state` with `filter=` / `show=` consumers |
| `style-rule` · `match=` · `when=` | `handler=` (no real host yet) |
| `style-screen` · `style-frame` · `slots=` · `axis=` · `component=` on containers | `value-from=` / `init-value=` beyond the two real states |
| the built-in words of §2.1 | the `#sitemap` column (the table exists, but no real map uses it yet) |
| attribute pass-through (§2.1) | every diagnostic not raised by the held subset |
| the style entry: its path + `default-style` (§1.1) | |
| `on=select` · `on=toggle` | |

The held column is held because it **escaped** — twice. Every codemap build seeds
`_index/style.geml` **and its entry `_index/index.geml`** into a user's repository,
and those files are on the rendering path — the renderer finds a stylesheet only
through that entry; and since 2026-09-09 the document-layout use case (a page
rendered by the viewer) exercises screens, frames, the built-in words and `when=`.
The right column is **specified, checked, and unexercised** — it will move with its
first genuine use case rather than be preserved for its own sake.

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

## 1.1 The style entry — how a root says how it renders

A single stylesheet can be handed to a tool directly (`geml style check <sheet>
<document>`). But for a **directory** to say "here is how my documents render",
there has to be an agreed location:

```
<root>/_index/index.geml
```

Any GEML root has exactly this one path, and hosts probe only it. The name is how
you find it; `meta.profile` is how you **recognise** it — anything else sitting at
that path is treated as "no style entry" rather than parsed as one.

The entry uses two keys to say which stylesheets load:

| key | what it is |
|---|---|
| `default-style` (a meta key) | this root's **default stylesheet**. Loads whether or not anything else matches |
| `#sitemap` (a table) | columns `document` / `template` — document name → an **additional** stylesheet |

```
  === meta
  profile = "geml-style/v1"
  default-style = "style.geml"
  ===

  === table {#sitemap}
  | document | template |
  |---|---|
  | index.geml | home.geml |
  ===
```

`#sitemap` is an **exact match**: no globs, no cascade, and a document not listed
simply gets the default layer only. That is the same stance §4 takes against
specificity arithmetic — a lookup should be readable at a glance. Keys are
root-relative document names.

Both keys are **one implicit `embed`** each: declaring them is the same as writing
the corresponding `=== embed {src=…}` at the top of the entry. They are therefore
not a new loading mechanism — cycle detection, the nesting cap, and the
diagnostics all come from `embed` unchanged, so a `default-style` pointing at its
own entry reports a cycle like anything else.

So "which sheet is this root's default" has exactly one answer, shared by three
callers: a host hands the entry to the loader as-is, `geml style check <entry>
<document>` works directly, and a template writing `embed {src=index.geml}` means
"give me this root's default, whatever it is called" — renaming the default
stylesheet leaves such templates untouched.

`embed` itself is GEML's include, not this profile's vocabulary; stylesheets use it
to compose (one shared default layer plus local exceptions). The loader expands it
through the **same** `selectEmbed` the renderer uses: a second matcher would
eventually diverge from build-time semantics. Expansion happens at **load time**,
so afterwards every rule lives in one table.

An explicit `embed` does **not** open a new layer (§4.1): the rules it pulls in sit
in the same layer as the file referencing it. Layers come only from the style
entry, so "how many layers does this document have" is answered by reading one
fixed path, regardless of how deeply `embed` nests.

## 2. The four block types

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
| `when=` | no | `$state=value` terms and the built-in `@hover` / `@focus`, comma-separated, all must hold; equality only (§4) |
| *any other key* | no | passed through **verbatim** as a component parameter — except the built-in words below. A parameter that the *merged* binding (§4) has no `component=` or `handler=` to receive is `style-unknown-attribute` (warning) |

**Built-in words.** A small closed set of attributes is the profile's own, not the
component's: they mean the same thing on a paragraph, a table or a diagram, so every
host renders them the same way (the CSS-property side of the CSS/Web-Components split).
They are consumed here and land in the view model's `box`; a component never sees them
in its `params`, so it cannot give `width` a private meaning.

| word | domain | on |
|---|---|---|
| `width` `max-width` `padding` `margin` | open (a CSS length) | blocks and containers |
| `sticky` | a number: offset from the top in px | blocks and containers |
| `scroll` | `own` \| `page` | blocks and containers |
| `hide-below` | a number: viewport px below which it is hidden | blocks and containers |
| `font-size` `line-height` `font-family` `color` `background` `border` `border-radius` | open | blocks and containers |
| `text-align` | `left` \| `center` \| `right` \| `justify` | blocks and containers |
| `gap` | open (a CSS length): space between slots, or between a block's items when it has `axis` | containers and blocks with `axis` |
| `axis` | `row` \| `column` (default `column`) | `style-screen` / `style-frame`; and a block — its items (a list's entries, a form's fields) run along that axis, and a list laid out in a row draws no markers |
| `layer` | `page` \| `overlay` \| `screen` (default `page`) | blocks and containers: in the flow; floated under the nearest container, taking no space (a dropdown); or covering the viewport with its content centred (a splash, a modal, a toast) |
| `visible` | `yes` \| `no` (default `yes`) | blocks and containers: shown *right now*. `hide-below` is the viewport half of "not shown"; this is the state half |
| `grow` | `yes` \| `no` (default `no`) | blocks and containers: whether this cell takes the space left over along its row or column |
| `fade-out` | a number of seconds, 0–60 (default 0, no fade) | blocks and containers: painted, then it fades away and stops taking clicks. The one thing on the time axis; a host that honours "reduce motion" jumps to the end |
| `view` | `rendered` \| `source` (default `rendered`) | blocks: show the block, or its source text |
| `editable` | `yes` \| `no` (default `no`) | blocks under `view=source`: the source may be edited in place; inert otherwise. It says nothing about where an edit goes — a host with no write path shows a scratch textarea |

A container takes the same words with the same meaning: a block's box says what
**that block** looks like, a container's says what **that region** looks like. Some
things only a container can say — the page's own background (a `style-screen` *is*
the page, so its `background` is the page's), the space between slots, a region's
padding. Hanging them on some block that happens to sit there is how a layout ends
up depending on which block came first.

A container may also name a `component=`, and then keys that are neither reserved
nor built-in words pass through to it as parameters — exactly as they do on a rule.
This is where page chrome lives: a top bar, a breadcrumb, an icon are not the
document, and putting them in the document as blocks to give a stylesheet something
to point at is how a page ends up with content that is not content. A container with
no `component=` has nothing to receive parameters, so an unrecognized key there is
still `style-unknown-attribute` — that one is a typo.

Closed domains are checked (`style-invalid-value`); open ones are handed to the host
verbatim — and the host must treat them as the untrusted text they are. A host that
emits CSS may splice in only values shaped like a length, a colour or a keyword; a
`width` of `0} body{display:none}` is a rule breakout, not a width, and is dropped
with a warning. The list was pinned to the first real page and grows one measured need at a
time; the second page (a document viewer's chrome, 2026-09-10) grew it by `axis` on
blocks, `view` and `editable`. The test for a candidate: *does it mean the same thing on
any block?* — `fold`, `collapsible`, `indent` do not, and stay component parameters.

**Parameters need a receiver.** `selectable`, `badge="leaf"`, `collapsed` are the
component's own vocabulary, and the profile has no business ruling on it — so a rule
carries no `style-unknown-attribute` check of its own. But §4 merges rules by attribute,
and after the merge a block either has a `component=` (or `handler=`) or it does not. A
binding whose merged parameters have nothing to receive them gets one
`style-unknown-attribute` (warning) naming the keys and the rules that set them: those keys
will never be read, which is what a typo looks like. The check is on the binding, not the
rule, because one rule may name the component and a more specific one add its parameters.
The reserved names above plus the built-in words are the complete list of keys the profile
itself consumes.

**Inline parts.** A rule whose selector ends in a part step (§3) dresses one kind of inline
inside the matched blocks — `text#nav link` is every link in `#nav`. Only words that mean
something on a run of text are taken there: `color` `background` `padding` `margin`
`border` (and its sides) `border-radius` `font-size` `line-height` `font-family` `width`
`max-width` `visible`. Any other built-in word on a part rule is `style-unknown-attribute`
(warning) and is dropped — `sticky` on a link is not a thing.

### 2.2 `style-state` — one cell of view state, and what feeds it

```
  === style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
  ===
```

| attribute | required | meaning |
|---|---|---|
| `match=` | **yes** | selector for the **producer** blocks that write this state |
| `on=` | **yes** | which interaction writes it. **Closed vocabulary**: `select` (the value is what was picked), `toggle` (the value flips between two) |
| `type=` | no | `block-ref` (default) or `scalar` |
| `value-from=` | no | which part of the producer to take (a column name, for a table) |
| `init-value=` | no | the value before any interaction has happened |

A `form-field` (geml-form/v1) can be a producer: under `on=select` the state is the
control's own value — pick an option, the state is that option. With no `init-value=`
the state starts at the field's `value=`. A one-of-N choice is a form field already;
the profile adds no word for tabs.

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

### 2.3 `style-screen` — a page

```
  === style-screen {#page axis=column slots="text#global-header, text#repo-tabs, #body"}
  ===
```

| attribute | required | meaning |
|---|---|---|
| `slots=` | **yes** | **comma-separated**, ordered. Each slot is a corpus selector, a `$state`, or a bare `#id` naming a `style-frame` of this stylesheet |
| `axis=` | no | `row` or `column` (default): how the slots are laid along the container |
| `component=` | no | a host-named arrangement (`grid`, …); optional, unvalidated — layout is the host's business |

A `$state` slot renders the block that state currently points at — that is how
the detail half of a master/detail view is written.

A screen is a **root**: a whole page. How many roots a stylesheet may have is the
host's rule, not the profile's — codemap's master/detail is several; a viewer rendering
"this page" wants exactly one, falls back to its plain rendering on none, and refuses
two.

**Slot grammar.** A bare `#x` is a frame reference; anything with a type, class or
attribute (`text#x`, `table.kpi`, `#x[attr]`) is a corpus selector. The split is
syntactic, so it needs no lookup and no disambiguation error, and a mistyped `#bdoy`
is an error (`unknown-frame`), not a warning. This follows GEML's own convention: a
bare `#id` addresses this document; another document takes a path.

**There is no `route=`.** Routing belongs to the host framework; a stylesheet
declaring it again is two routers fighting.

### 2.4 `style-frame` — a region inside a page

```
  === style-frame {#body axis=row slots="table#file-tree, #main"}
  ===
```

Same attributes as `style-screen`. A frame can only appear where a slot names it, and
its own slots may name further frames — a page is a tree of frames. Unlike an
`<iframe>` it is not a separate document and isolates nothing; it is a box.

| check | code | severity |
|---|---|---|
| a bare `#x` in `slots=` names no frame | `unknown-frame` | error |
| a bare `#x` names a `style-screen` — a page cannot be placed inside another | `screen-nested` | error |
| frames nest in a cycle (`#a → #b → #a`; the message carries the chain) | `frame-cycle` | error |
| frames nest deeper than 16 along some placement path | `frame-too-deep` | error |
| a frame no slot references | `unused-frame` | warning |

A frame **may** be placed by more than one slot: each placement renders it again,
which is the same blocks appearing twice — exactly what naming those blocks in two
slots would do, so there is nothing to forbid. The nesting is therefore a DAG rooted
at the screens, not strictly a tree, and depth is the longest placement path.

The depth cap is a security boundary as much as a shape rule. A stylesheet is
untrusted input like any document (§9): a chain of ten thousand frames — no cycle
anywhere — would otherwise have to be rendered ten thousand boxes deep. The cap is
16: the GitHub blob page is four levels, and `embed` has had the same kind of cap (8)
for the same reason. The checker visits each frame once and computes depth in one
topological pass, so a hostile sheet — a diamond chain forty levels deep included —
costs it linear time.

Linear for the checker is not linear for the host. A frame may be placed in more
than one slot, so nesting and reuse multiply: two slots per level naming the same
child frame, sixteen levels deep, is 65 536 leaf placements — a shape the checker
visits once and passes. A host therefore caps the number of blocks and frames it
places on one page (the browser viewer: 2 000) and renders without the stylesheet
past it, the way it does past the `embed` total.

## 3. Selector grammar

```
<type>? (.class)* (#id)? ([key] | [key=value])*      one simple selector
*                                                    any node (whole step only)
#api table.kpi                                       descendant (the only combinator)
table.kpi, table.summary                             comma = branches (sugar for two rules)
text#nav link                                        inline part: last step only, after a block step
```

A selector may end in an **inline part** — `link`, `image`, `code-span`, `strong`,
`emphasis` — naming one kind of inline inside the matched blocks (`text#nav link` is
every link in `#nav`, nested lists included). The names are §5.1's own: `code` is a
block type already, so the span is `code-span`. A part step must be the last step, must
follow a block step, takes no `#id` / `.class` / `[attr]`, and a `match=` may not mix
part branches with block branches — each is `selector-unsupported`. `*` and block
selectors never match parts, and a slot never places one: a part goes wherever its block
goes.

`*` matches any node. It is only legal as a **whole step** — `*.kpi` and `table.a*`
are still refused — and it exists because a slot that has to lay out a whole document
in document order cannot name what it wants any other way: a paragraph between two
blocks carries no class to select on.

The nodes a selector can match are typed blocks, **headings** (`heading`, with the
level as an attribute: `heading[level=1]`), and the **prose** between blocks
(`prose`). Headings and prose are addressable in the core (`geml list` names them),
so a layer that lays out documents has no business being unable to place them. A
paragraph *inside* a block is that block's content, not a section of the document,
and is not a candidate.

The vocabulary is exactly §4's own — type, `.class`, `#id`, attribute presence,
attribute equality — plus one combinator. Sections are the containment relation:
headings are not containers in the block model, so the relation is rebuilt from
an open heading stack.

Unsupported CSS is **named, not silently unmatched**:

| refused | why it is refused rather than ignored |
|---|---|
| `>` `+` `~` | child/sibling combinators — the block model has containment, not order-adjacency |
| `:hover` `:nth-child(…)` | state/position pseudo-classes — a selector picks content; the pointer's state is `when="@hover"` (§2.1) |
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
tests; `screen=` adds `screen:<id>`; each `when=` term adds `when:<state>=<value>`.
If one rule's condition set strictly contains the other's, it wins. Otherwise →
`ambiguous-rule`, an **error**.

With `when=` in the condition set the arbitration applies unchanged: a conditional
rule with the same selector is a strict superset of the unconditional one and wins —
at runtime, when its state holds. Two conditional rules whose `when=` sets are
**exclusive** (the same state, different values) can never both apply and are not a
conflict; two that can both hold, are incomparable, and set one attribute are
`ambiguous-rule`, exactly as before.

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

### 4.1 Layers — the one place origin decides

The style entry of §1.1 orders stylesheets into **layers**. A layer number is
declared, never computed from a selector:

| layer | source |
|---|---|
| 0 | `default-style` |
| 1 | the `#sitemap` match |
| 2 | rules written in the entry itself |

**Across layers the higher layer wins; within a layer nothing above changes.** So
`match="#hero"` beats the default layer's `match="note"` because it sits in a
higher layer — not because an id selector is "worth more". This is CSS `@layer`,
not specificity: the layer number comes from the entry's two keys and the selector
contributes nothing to it.

Without this rule the section above is not enough. A default layer keyed on
**types** plus an override layer keyed on **specific blocks** is this profile's
most common shape, and those two selector kinds have condition sets that do not
contain one another — every one of them would hit `ambiguous-rule`. Measured: the
five homepage documents all errored before layers existed.

**The reason for excluding source order still holds**, and this is worth stating:
a layer is not line order in a file. Within a layer there is no order; `#sitemap`
is an exact match, so reordering its rows changes nothing; the number of layers is
fixed by the entry's two keys. Block-level agent edits (`geml set`, `geml add
--before`) therefore still cannot silently re-render a document — which is what
excluding source order was protecting.

The cost is honest: §4's opening claim that arbitration is independent of which
file a rule came from now holds **within a layer** only. What it buys is that
"default layer plus exceptions" works at all; without it, every override rule
would have to repeat the default layer's condition (`match="note#hero"`) just to
avoid an error.

## 5. The binding pipeline

```
interaction  →  state  →  view
```

One direction, three stages, and **state never reads state**. That is not a
cycle check that happens to pass — there is no graph, so there is no cycle to
form. The catalogue therefore has **no `binding-cycle` code**.

That sentence is about **state**. Frames (§2.4) are a second graph — regions holding
regions — and that one can cycle, so it has `frame-cycle`. The two graphs do not touch:
state never reads state, and a frame holds no state.

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
| `selector-unsupported` | error | an unsupported CSS construct, named; also an inline part step that is not last, has no block step before it, carries a filter, or is mixed with block branches — and a slot that names a part |
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
| `style-unknown-attribute` | warning | an unknown key on `style-state` / `style-screen` / `style-frame`; a parameter the merged binding has no `component=` / `handler=` to receive (§2.1); a block-only built-in word on a part rule |
| `style-embed-not-expanded` | warning | an `embed` — including §1.1's two implicit ones — contributed no rules |
| `unknown-frame` | error | a bare `#x` in `slots=` names no `style-frame` |
| `screen-nested` | error | a bare `#x` in `slots=` names a `style-screen` |
| `frame-cycle` | error | frames nest in a cycle; the message carries the chain |
| `frame-too-deep` | error | frames nest deeper than 16 along some placement path |
| `unused-frame` | warning | a `style-frame` no slot references |
| `style-invalid-value` | error | a closed-domain built-in word (`axis` / `scroll` / `sticky` / `hide-below` / `layer` / `visible` / `grow` / `view` / `editable` / `fade-out`) took a value outside its domain, or a `when=` term is neither `$state=value` nor `@hover` / `@focus` |

`unknown-value-source` is checkable because §6 gives tables a real schema. When
the producer is not a table the check is **skipped**, not guessed at.

`unmatched-rule` is the style layer's `bad-source-range`: the stylesheet is
internally consistent but has drifted from the corpus it styles.

`style-embed-not-expanded` is a warning rather than an error for the same reason
`style-unknown-attribute` is: **we ignored something the author wrote, and should
say so.** The message carries the cause — unreadable, anchor absent, cycle, or the
caller supplied no document resolver. Silence is the worst outcome here: a
stylesheet that looks composed while only its own handful of rules apply, a page
missing a large piece of itself, and nobody saying anything.

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
| `states` | `{id, type, on, valueFrom?, initValue?}[]` — `on` is `select` or `toggle` |
| `screens` | `{id, axis, component?, slots, bindings}[]` — the roots |
| `frames` | `{id, axis, component?, slots}[]` — flat, referenced by id; no bindings of their own |
| `bindings` | the screen-unqualified table |
| `diagnostics` | `{severity, code, message, rule?}[]` |

A **binding** is `{doc, block, part?, rules, params, box, variants}`. `part` is present on
a binding a part rule made (§3) and names the inline kind — `link` `image` `code-span`
`strong` `emphasis`; such a binding shares its block's address and is a separate target
for §4's arbitration. In `variants[].when`, the built-in `@hover` / `@focus` appear as
keys with the value `"true"`. `params` are the
component's words (including `component` / `handler` / `show` / `filter`); `box` the
built-in words of §2.1, kept apart so a host applies them uniformly and a component
never sees them. `variants` is `{when, box, params}[]` — the parts that apply only
while every `when` entry (`{state: value}`) holds — ordered by number of conditions
ascending, then stylesheet order, so a runtime overlays the matching ones in sequence
and never re-arbitrates. `doc` is **not redundant**: §4
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
{"kind": "frame",  "frame": "body"}
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

The renderer reaches this file **only through the style entry of §1.1**; it never
reads `_index/style.geml` directly. So a build seeds **two** files: the stylesheet,
and the `_index/index.geml` that points at it. Seeding only the first leaves that
stylesheet with no entry to reach it. A missing entry falls back to the built-in
defaults just the same, and the fix is to rebuild — there is deliberately no "if
no entry, read style.geml anyway" fallback, because that would keep a second
discovery path, and two semantics, forever.

Layering here is **key by key**: the sheet a `#sitemap` row assigns overrides only
the knobs it actually writes, and the rest fall back to the `default-style` layer.
Each layer is therefore read for the keys that document really wrote — a layer that
spells out a default value would otherwise be indistinguishable from one that never
mentioned the knob, and a lower layer's default would overwrite a higher layer's
explicit value.

## 12. Versioning and scope

`geml-style/v1`. A new vocabulary member is a new version; the profile name is
the compatibility unit, and unknown members degrade per §7.

**2026-09-10 — the second real page** (a document viewer's chrome, laid out from
lists and form fields): inline part steps in selectors (§3); `axis` on blocks, `view`
and `editable` (§2.1); `@hover` / `@focus` in `when=` (§2.1); parameters must have a
receiver on the merged binding (§2.1). Nothing was removed.

**2026-09-11 — the same page's menus and opening note**: `layer` gains `screen`, and
`fade-out` joins the built-in words (§2.1). `layer` / `visible` / `grow` themselves
landed with the first page and had been missing from §2.1's table; they are listed
now.

**v1 deliberately does not have**: script of any kind, URLs (dev/staging/prod
differ — a written-in address binds the stylesheet to an environment), routing,
theming beyond design tokens (reuse the `data` block, GEP-0005), or any body
content in its three block types.

**Named but not yet exercised by a real stylesheet**: everything in §0.1's right
column. `filter=` in particular has never run against real noise (mustapi's edges
are all `kind=call` with empty confidence — nothing to filter), and `handler=` has no
real host. They are specified and checked, not battle-tested, and §0.1 says what
that buys you.

`geml style check` is marked EXPERIMENTAL in `geml --help` for this reason. It
works, it is tested, and its vocabulary is not yet settled — a command you can
rely on to be correct today, not to be spelled the same next year.
