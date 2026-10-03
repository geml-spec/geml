# geml-style profile v1 — vocabulary & conventions

*English | [中文](geml-style-profile_CN.md)*

- Status: v1, landed 2026-08-30 — but **EXPERIMENTAL**, and `geml style check`
  says so. Stable today: the subset codemap's display knobs use — `style-rule`,
  `match=`, and attribute pass-through. Everything else in this vocabulary moves
  with the first real use case outside this repository. Design rationale:
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

**See one.** [The style demo](https://geml-spec.github.io/demos/style) is a
whole page built this way — a 1:1 replica of a GitHub blob page, where
`page.geml` holds every string and `github.style.geml` holds every colour,
length and state. It opens in any browser, drawn by the viewer's own code, with
the documents that make it below.

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
through that entry; and the document-layout use case (a page rendered by the
viewer) exercises screens, frames, the built-in words and `when=`.
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
root-relative document names, and the row looked up is the document being
rendered's; `geml style check` looks up its corpus's one document when it is
handed exactly one, and no row when it is handed several.

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
at **load time**, so afterwards every rule lives in one table, and it selects
exactly what the core's `embed` selects (GEML §9.3) — a second matcher would
eventually diverge from build-time semantics: a whole file, or the block, heading
section or stretch of prose its `#id` names, narrowed by `part=`. A bare `#id` names
a target in the file the `embed` is written in, and a relative path resolves as
GEML §3.3 resolves any path a document names: against that file's directory, then
the root. A file is read in document order, and its style blocks and `embed`s
count wherever they stand, inside another block's body included. A file an
`embed` brings in counts as written, its own `default-style` included — one more
implicit `embed` at its top, in the same layer — and its `#sitemap` not.

An explicit `embed` does **not** open a new layer (§4.1): the rules it pulls in sit
in the same layer as the file referencing it. Layers come only from the style
entry, so "how many layers does this document have" is answered by reading one
fixed path, regardless of how deeply `embed` nests.

## 1.2 Tokens — one place for the values

Every key of the stylesheet's own `=== meta` is a **token**. In any attribute of a
`style-rule` / `style-state` / `style-screen` / `style-frame`, `{{key}}` is replaced
by that key's value when the stylesheet is loaded.

```
=== meta
profile = "geml-style/v1"
line = "#d1d9e0"
col  = 1012
===
=== style-rule {#file-box match="table#files" border="1px solid {{line}}"}
===
=== style-rule {#side match="#sidebar" hide-below="{{col}}" max-width="{{col}}px"}
===
```

Why it exists, measured: in the replica stylesheet that ships as this profile's page
demo, `#d1d9e0` appeared 21 times, `#59636e` 14, `#1f2328` 12. Changing one border
colour meant editing 21 blocks. CSS custom properties have answered this for a decade;
without an answer a stylesheet stops being maintainable at page scale.

The spelling is core GEML's own `{{key}}` (standard §4). The core substitutes it in
**flow text** only — attributes are this profile extending the same reference to the
one place its documents keep their content. Same syntax, same failure mode, nothing
new to learn.

Four boundaries, each deliberate:

| rule | why |
|---|---|
| one pass, no recursion | a `{{…}}` inside a token's own value stays literal, so no cycle can form and there is no resolution order to argue about |
| per file | rules pulled in by `embed` expand against **their own** file's `meta`, never the host's — the rule the core already applies to borrowed content |
| a dangling `{{key}}` is an **error** (`style-unknown-token`) | silently substituting an empty string drains the colour out of a page and says nothing |
| a value that is *exactly* one token keeps the token's **type** | `hide-below="{{col}}"` with `col = 1012` yields the number 1012, so the numeric built-in words can be fed from tokens at all; anywhere else the value is spliced in as text |

Tokens are values, not rules: they carry no conditions, take no part in §4, and a token
is not a fallback for anything. `profile` is a key like any other, so `{{profile}}`
expands to `geml-style/v1` — harmless, and not a special case worth carving out.


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
| `when=` | no | `$state=value` terms and the built-in `@hover` / `@focus` / `@invalid` / `@disabled` / `@checked`, comma-separated, all must hold; equality only (§4) |
| `caption=` `hidden` | no | the core's own (GEML §4), here and on every style block: neither a parameter, nor a built-in word, nor an unknown key, and no part of §4's merge |
| *any other key* | no | passed through **verbatim** as a component parameter — except the built-in words below. A parameter that the *merged* binding (§4) has no `component=` or `handler=` to receive is `style-unknown-attribute` (warning) |

**Built-in words.** A small closed set of attributes is the profile's own, not the
component's: they mean the same thing on a paragraph, a table or a diagram, so every
host renders them the same way (the CSS-property side of the CSS/Web-Components split).
They are consumed here and land in the view model's `box`; a component never sees them
in its `params`, so it cannot give `width` a private meaning.

| word | domain | on |
|---|---|---|
| `width` `max-width` `min-width` `padding` `margin` | open (a CSS length) | blocks and containers |
| `height` `max-height` `min-height` | open (a CSS length) | blocks and containers. The width axis carried three words and the height axis none; that was an asymmetry, not restraint — an `axis=row` container with a fixed-height header had no way to say so |
| `sticky` | `top` \| `right` \| `bottom` \| `left` | blocks and containers: which edge it sticks to while its scroll container moves. A box sticks to one edge at a time — unlike `border`, whose four sides are written together — so the side is the value, not four key names |
| `scroll` | `own` \| `page` | blocks and containers |
| `hide-below` | a number: viewport px below which it is hidden | blocks and containers |
| `font-size` `line-height` `font-family` `font-weight` `color` `background` `border` `border-top` `border-right` `border-bottom` `border-left` `border-radius` | open | blocks and containers |
| `text-align` | `left` \| `center` \| `right` \| `justify` | blocks and containers |
| `gap` | open (a CSS length): space between slots; on a block with `axis`, the space between its items **and** inside one, between an icon and its label | containers and blocks with `axis` |
| `item-align` | `start` \| `center` \| `end` \| `stretch` (default `stretch`) | containers, and blocks carrying `axis`: how the slots line up **across** the axis. `axis` opens an axis and `gap` spaces along it; across it there was no word |
| `item-justify` | `start` \| `center` \| `end` \| `between` (default `start`) | containers, and blocks carrying `axis`: how the slots distribute **along** the axis. The other face of the same axis as `item-align` |
| `wrap` | `yes` \| `no` (default `no`) | containers, and blocks carrying `axis`: whether items that do not fit start a new line. With `width` on the items, this is how a form lays its fields two to a row |
| `axis` | `row` \| `column` (default `column`) | `style-screen` / `style-frame`; and a block — its items (a list's entries, a form's fields) run along that axis, and a list laid out in a row draws no markers |
| `anchor` | `flow` \| `parent` \| `viewport` (default `flow`) | blocks and containers: **what the box is anchored to**. `flow` follows the document flow and takes space; `parent` hangs off the nearest container and takes none (a dropdown); `viewport` covers the viewport and centres its content (a splash, a modal, a toast) — `place` moves it off centre |
| `place` | `center` (default) \| `top` \| `bottom` \| `left` \| `right` \| `top-left` \| `top-right` \| `bottom-left` \| `bottom-right` | blocks and containers under `anchor=parent` / `anchor=viewport`: **where** the box sits against what it is anchored to. `anchor` says what it hangs off, `place` says where — the other face of the same axis, as `item-justify` is to `item-align`. A drawer is `viewport` + `left`; a toast is `viewport` + `top-right`. Consumed only under those two; inert otherwise, exactly as `editable` is outside `view=source` |
| `visible` | `yes` \| `no` (default `yes`) | blocks and containers: shown *right now*. `hide-below` is the viewport half of "not shown"; this is the state half |
| `grow` | `yes` \| `no` (default `no`) | blocks and containers: whether this cell takes the space left over along its row or column |
| `fade-out` `fade-in` | a number of seconds, 0–60 (default 0, no fade) | blocks and containers: `fade-out` is painted, then fades away and stops taking clicks; `fade-in` is the same axis in the other direction. The one thing on the time axis; a host that honours "reduce motion" jumps to the end |
| `underline` | `yes` \| `no` | blocks and inline parts: whether this run of text is underlined. A host does **not** strip a link's default underline on a laid-out page — removing it is a look, and the stylesheet says so |
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

**A rule may dress a container.** A rule whose `match=` is one bare `#id` naming a
`style-screen` or `style-frame` of this stylesheet applies to that container as well —
a region changes with `when=` exactly as a block does, which is how a menu panel
opens or a sidebar narrows. The rules naming one container are merged by §4 as a
binding's are, `screen=` taking no part, and what the merge sets replaces the
container's own words: base words join its `box` and `params`, conditional ones form
its `variants`. A corpus block holding the same id is bound by the rule all the same.

Closed domains are checked: a value outside its domain is `style-invalid-value`, and
the word is dropped — the rule does not set it, so it takes no part in §4. Open ones are handed to the host
verbatim — and the host must treat them as the untrusted text they are. A host that
emits CSS may splice in only values shaped like a length, a colour or a keyword; a
`width` of `0} body{display:none}` is a rule breakout, not a width, and is dropped
with a warning. The list is pinned to the real pages that asked for each word, and
grows one measured need at a time. The test for a candidate: *does it mean the same thing on
any block?* — `fold`, `collapsible`, `indent` do not, and stay component parameters.

**Control states.** Besides `$state=value`, `when=` knows five conditions the host
supplies and no stylesheet declares: `@hover`, `@focus`, `@invalid`, `@disabled`,
`@checked`. The last three are the control's own state, and the profile does **not**
define when a control is in one — validity is the handler's verdict, and the document
declares its constraints without evaluating them (§7's open side). A stylesheet says
only what each state *looks like*. Without them the three-layer split leaks at its
seam: the document can declare a constraint and the handler can judge it, but nothing
could say what a field that failed judgement looks like.

**Parameters need a receiver.** `selectable`, `badge="leaf"`, `collapsed` are the
component's own vocabulary, and the profile has no business ruling on it — so a rule
carries no `style-unknown-attribute` check of its own. But §4 merges rules by attribute,
and after the merge a binding — its base and its variants together — either has a
`component=` (or `handler=`) or it does not. A
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
`max-width` `visible` `underline`. Any other built-in word on a part rule is `style-unknown-attribute`
(warning), reported once on the rule, and is dropped — `sticky` on a link is not a thing.

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
over time, not a static conflict, so it is not `style-ambiguous-rule`.

**A container can be the producer.** A `match=` that is one bare `#id` naming a
`style-screen` or `style-frame` of this stylesheet makes that region the producer —
clicking a menu button's frame opens its panel — and such a state is not
`style-unmatched-producer` for matching no corpus block.

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
is an error (`style-unknown-frame`), not a warning. This follows GEML's own convention: a
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
| a bare `#x` in `slots=` names no frame | `style-unknown-frame` | error |
| a bare `#x` names a `style-screen` — a page cannot be placed inside another | `style-screen-nested` | error |
| frames nest in a cycle (`#a → #b → #a`; the message carries the chain) | `style-frame-cycle` | error |
| frames nest deeper than 16 along some placement path | `style-frame-too-deep` | error |
| a frame no slot references | `style-unused-frame` | warning |

A frame **may** be placed by more than one slot: each placement renders it again,
which is the same blocks appearing twice — exactly what naming those blocks in two
slots would do, so there is nothing to forbid. The nesting is therefore a DAG rooted
at the screens, not strictly a tree, and depth is the longest placement path.

The depth cap is a security boundary as much as a shape rule. A stylesheet is
untrusted input like any document (§9): a chain of ten thousand frames — no cycle
anywhere — would otherwise have to be rendered ten thousand boxes deep. The cap is
16: the GitHub blob page is four levels, and the core's transclusion chain has the
same bound, 16, for the same reason (GEML §9.3). The checker visits each frame once and computes depth in one
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
<type>? (#id)? (.class)* ([key] | [key=value])*      one simple selector — order does not matter
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
part branches with block branches — each is `style-selector-unsupported`. `*` and block
selectors never match parts, and a slot never places one: a part goes wherever its block
goes. The step before the part matches the node whose part it is, not an ancestor of it:
`note link` is the links a `note` holds, and binds on the note alone. A node has a part
only when it holds at least one inline of that kind — in its own text, its lists, or the
body of a typed block nested in it; a node without one gives a part step nothing to match.

A part name in the **first** step is read as a block type — a part needs a block
step before it, so there is nothing else it could be there — and the processor
says so with `style-reserved-name` (warning): a block type that happens to be
called `link` stays selectable by its type, and an author who meant the inline
part is told what is missing (`text#nav link`).

`*` matches any node. It is only legal as a **whole step** — `*.kpi` and `table.a*`
are still refused — and it exists because a slot that has to lay out a whole document
in document order cannot name what it wants any other way: a paragraph between two
blocks carries no class to select on.

The nodes a selector can match are typed blocks, **headings** (`heading`, with the
level as an attribute — the line's own, which an author's `level=` does not override:
`heading[level=1]`), and the **prose** between blocks
(`prose`): a stretch of prose as GEML §4 defines it — its paragraphs and lists, a
`%%` line not breaking it — one node however much it holds, whose id, for an `#id`
step and for its address, is its §4 prose address when it has one that no declared
id shadows. Headings and prose are addressable in the core (`geml list` names them),
so a layer that lays out documents has no business being unable to place them.
The prose *inside* a typed block's body is that block's content, not a section of
the document, and is not a candidate; the typed blocks and headings inside the body
are. A stylesheet's own screens and frames are not nodes of the corpus; a rule reaches
one only by naming it (§2.1).

**The corpus** is the documents a stylesheet is solved against, in the order given,
followed by each GEML document an `embed` in the corpus names, read whole whatever
block or section the `embed` selects — a binding names a node of a document, not a
piece of a page — and each document once: they join in the order their `embed`s are
met reading the corpus in order, a joined document's own `embed`s included. A
same-document `embed` adds nothing, and a document the host cannot read joins
nothing.

The vocabulary is exactly §4's own — type, `#id`, `.class`, attribute presence,
attribute equality — plus one combinator. The parts of a simple selector are
**unordered**, as the standard says attributes are (`#id`, then `.class`, then
`key=val` is the recommended writing order, not a rule): `text#a.x`, `text.x#a`
and `text[k=v].x#a` are the same selector. `.class` and `[key]` are two
namespaces that never meet — a class is not an attribute of the same name, so
`.x` matches `{#a .x}` and `[x]` matches the flag `{#a x}`, and neither matches
the other. Sections are the containment relation:
headings are not containers in the block model, so the relation is rebuilt from
an open heading stack. A heading an ancestor step matches is the same node as when it
is matched itself — type `heading`, its level an attribute — so `heading[level=1] table`
is every table in a level-1 section.

Unsupported CSS is **named, not silently unmatched**:

| refused | why it is refused rather than ignored |
|---|---|
| `>` `+` `~` | child/sibling combinators — the block model has containment, not order-adjacency |
| `:hover` `:nth-child(…)` | state/position pseudo-classes — a selector picks content; the pointer's state is `when="@hover"` (§2.1) |
| `*` | universal selector |
| `^=` `$=` `*=` `\|=` | substring matching — §9.2 keeps document text out of pattern languages |

Each raises `style-selector-unsupported` (error) naming the construct. CSS similarity
is meant to be a ramp, not a trap.

The scan is **zoned** — pseudo-classes are looked for only *outside* brackets,
substring operators only *inside* — because attribute values legitimately
contain `:`; codemap anchors look like `ts:render.ts#esc(string)`. A single
one-pass regex misreads those as pseudo-classes.

## 4. Conflict arbitration

Merging is **per attribute**, and decided by one relation: **strict superset of
conditions**. A selector's conditions are its type, classes, id, and attribute
tests; `screen=` adds `screen:<id>`; each `when=` term adds `when:<state>=<value>`.
"Written first" means first in stylesheet order. For one attribute on one block,
the rules that set it are arbitrated in three steps:

1. **Layers** (§4.1). Within one `when=` set, only the rules of the highest layer
   that sets the attribute take part.
2. **One `when=` set.** A rule whose condition set another's strictly contains
   loses. The rules left — the *maximal* ones — decide: one holds the attribute;
   of several, identical or incomparable, the one written **first** holds it, and
   each of the others is `style-ambiguous-rule`, a **warning** — one report per
   rule that lost to order alone. The holder's value enters the binding; the
   others' enter nothing (§10).
3. **Across `when=` sets.** Two sets that can hold together — not **exclusive**,
   which is the same state with different values — are compared through the rules
   holding the attribute in each after step 2. A higher layer keeps it; in one
   layer, a conditional rule whose condition set strictly contains the other's
   overlays it at runtime, when its state holds, and when neither contains the
   other the set whose holder was written later loses the attribute — one
   `style-ambiguous-rule` for that set. Every pair is compared through the
   holders of step 2 and the losses apply together, so the outcome does not
   depend on which pair is looked at first.

The maximal set is what makes the outcome independent of the order the rules are
considered in: with `A ⊂ C` and `B` incomparable to both, `A` loses to `C` and
the contest is between `B` and `C`, the earlier of which holds the attribute. The
contest is reported so that order never decides silently; it is not an error,
because a stylesheet with one open contest still renders, and renders the way
its author can read off the file.

There is no specificity arithmetic and no `!important`. Source order decides
nothing **except a reported contest**: a stylesheet that resolved by order
silently would be re-rendered by the very block-level agent edits (`geml set`,
`geml add --before`) this format exists to support, so wherever order does
decide, `geml style check` names the pair on every build.

Conflicts are judged **against the corpus**: two incomparable rules are only
reported if they actually co-occur on some real block.

**Shorthands and their sides.** Merging is per attribute *name*, and `border` and
`border-left` are two names — so they never meet in the arbitration above, both
survive, and which one takes effect is decided by whichever declaration the host
emits last. A layer has no order, so that would make the rendered result depend on
where the two rules happen to sit in the file, silently — precisely what `geml add
--before` would change without a word. So two **different** rules in the same layer
may not set `border` and one of `border-top` / `border-right` / `border-bottom` /
`border-left` on the same block. Within one `when=` set, when the rule holding
`border` (step 2) and the rule holding a side are different rules of one layer,
the word of the one written later enters no binding — decided for every side at
once, one `style-ambiguous-rule` per word dropped. Writing both
words in **one** rule is fine: there the order is one the author wrote, and
`geml set` replaces whole blocks. Across layers is fine too —
a layer is a declared order. Sides never conflict with one another, and
`border-radius` is not part of the family.

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
contain one another — every one of them would hit `style-ambiguous-rule`. Measured: the
five homepage documents all errored before layers existed.

**A layer is not line order in a file**, and this is worth stating. Within a
layer, order decides only a contest that `style-ambiguous-rule` reports; `#sitemap`
is an exact match, so reordering its rows changes nothing; the number of layers is
fixed by the entry's two keys. Block-level agent edits (`geml set`, `geml add
--before`) therefore still cannot re-render a document without `geml style check`
saying so.

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
regions — and that one can cycle, so it has `style-frame-cycle`. The two graphs do not touch:
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
demote checks like `style-unknown-value-source` from a guarantee to a suggestion.

At *check* time the operators are validated only for **reference existence** —
every `$name` must be declared by some `style-state`. Their evaluation is the
runtime's job.

## 6. Separator conventions

One rule, and it is not arbitrary:

- **Name lists use spaces** — `profile`, `screen=`, `palette`, codemap's `entry`.
- **Selector lists use commas** — `match=`, `slots=`.

Because **space is the descendant combinator**. Splitting `slots=` on whitespace
turns `#api table.kpi` into two slots, neither of which matches anything, and
hands you an `style-unmatched-rule` that explains nothing about why. (Measured, not
theorised — it is how the convention was found.)

## 7. Closed vocabularies vs open registries

| kind | example | unknown member |
|---|---|---|
| **closed** — the runtime interprets these names itself | `on=` | **error** (`style-unknown-interaction`) |
| **open** — the host registers names the profile never sees | `component=`, `handler=` | **warning** + inert fallback |

Core GEML already draws this line the same way: `chart-unknown-type` is an
error, `unknown-diagram-format` is a warning. The open side must degrade rather
than reject, or §8.5's forward-compatibility mechanism stops working.

`style-unknown-component` / `style-unknown-handler` fire **only when the caller declares its
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
| `style-selector-unsupported` | error | an unsupported CSS construct, named; also an inline part step that is not last, has no block step before it, carries a filter, or is mixed with block branches — and a slot that names a part |
| `style-ambiguous-rule` | warning | identical or incomparable rules setting one attribute; the first-written rule's value is kept |
| `style-unknown-state` | error | a rule or slot references a `$foo` nobody declares |
| `style-unknown-screen` | error | `screen=` names no `style-screen` block |
| `style-unknown-value-source` | error | `value-from=` is not a column of the target table |
| `style-unknown-interaction` | error | `on=` is not in the closed interaction vocabulary |
| `style-unknown-token` | error | `{{key}}` in an attribute names no key of that stylesheet's `meta` (§1.2) |
| `style-missing-attribute` | error | a required attribute is absent |
| `style-unmatched-rule` | warning | a rule (or screen slot) matched no block in the corpus |
| `style-unmatched-producer` | warning | a state's `match=` matched no block |
| `style-unknown-component` | warning | not in the declared registry → renders inert |
| `style-unknown-handler` | warning | not in the declared registry → renders inert |
| `style-unknown-attribute` | warning | an unknown key on `style-state` / `style-screen` / `style-frame`; a parameter the merged binding has no `component=` / `handler=` to receive (§2.1); a block-only built-in word on a part rule |
| `style-embed-not-expanded` | warning | an `embed` — including §1.1's two implicit ones — contributed no rules |
| `style-unknown-frame` | error | a bare `#x` in `slots=` names no `style-frame` |
| `style-screen-nested` | error | a bare `#x` in `slots=` names a `style-screen` |
| `style-frame-cycle` | error | frames nest in a cycle; the message carries the chain |
| `style-frame-too-deep` | error | frames nest deeper than 16 along some placement path |
| `style-unused-frame` | warning | a `style-frame` no slot references |
| `style-reserved-name` | warning | a selector's **first** step names an inline part (`link`, `image`, `code-span`, `strong`, `emphasis`); it is read as a block type, since a part needs a block step before it, and the message says what a part would need (§3) |
| `style-invalid-value` | error | a closed-domain built-in word (`axis` / `anchor` / `place` / `scroll` / `sticky` / `hide-below` / `visible` / `grow` / `wrap` / `view` / `editable` / `fade-out` / `underline`) took a value outside its domain, or a `when=` term is neither `$state=value` nor one of `@hover` / `@focus` / `@invalid` / `@disabled` / `@checked` |

`style-unknown-value-source` is checkable because §6 gives tables a real schema. When
the producer is not a table the check is **skipped**, not guessed at.

`style-unmatched-rule` is the style layer's `bad-source-range`: the stylesheet is
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
| `states` | `{id, type, on, valueFrom?, initValue?}[]` — `on` is `select` or `toggle`; `valueFrom` and `initValue` are the attributes' text |
| `screens` | `{id, axis, component?, params, box, variants, slots, bindings}[]` — the roots |
| `frames` | `{id, axis, component?, params, box, variants, slots}[]` — flat, referenced by id; no bindings of their own |
| `bindings` | the screen-unqualified table |
| `diagnostics` | `{severity, code, message, rule?}[]` |

A **binding** is `{doc, block, part?, rules, params, box, variants}`. `part` is present on
a binding a part rule made (§3) and names the inline kind — `link` `image` `code-span`
`strong` `emphasis`; such a binding shares its block's address and is a separate target
for §4's arbitration. `rules` names the rules that matched the node, in stylesheet order:
`#id`, or `[n]` for a rule with no id, `n` its position among the stylesheet's
`style-rule` blocks as loaded, counted from 0. `block` is the node's address: `#id` when it has one — a stretch of
prose's §4 address included (§3) — otherwise `[n]`, `n` being its position in that
document, counted from 0 in document order among the nodes a selector can match (§3):
headings, stretches of prose and typed blocks, nested ones included, a stretch counted
once where it begins. So an id-less node is still named, and a host joins it to the
corpus by position. An attribute under `style-ambiguous-rule` (§4) carries the
value of the rule §4 lets hold it, base and variants alike; a rule that lost to order
contributes nothing to the binding. In `variants[].when`, the built-in `@hover` / `@focus` / `@invalid` / `@disabled` / `@checked` appear as
keys with the value `"true"`. `params` are the
component's words (including `component` / `handler` / `show` / `filter`); `box` the
built-in words of §2.1, kept apart so a host applies them uniformly and a component
never sees them. `variants` is `{when, box, params}[]` — the parts that apply only
while every `when` entry (`{state: value}`) holds — ordered by the number of `when`
entries ascending, then by where the set's first-written rule stands in the stylesheet, so a runtime overlays the matching ones in sequence
and never re-arbitrates; a `when=` set §4 leaves with no word is no variant. The
bindings come in corpus order, each document's in the order of its nodes (§3), and
a node gets a binding only when some rule matches it, a part's right after its
node's. `doc` is **not redundant**: §4
guarantees id uniqueness only *within a document*, and one stylesheet over a
whole directory is the normal case, so two documents may each hold a `#budget`.
Without `doc` a consumer cannot join a binding back to the right block.

A screen's or a frame's `params` and `box` are its own words with what the rules
dressing it set (§2.1) laid over them, and its `variants` are theirs, shaped and
ordered as a binding's.

**Inheritance is host-defined, and this profile does not describe it.** A `box` is
flat: each binding carries exactly the words §4 arbitrated onto it, and nothing in the
view model says a child inherits its parent's `color`. What happens is whatever the
host's medium does — a host that emits CSS gets CSS's inheritance for free (`color`
inherits, `border` does not); a host that paints to a canvas or lays out a PDF gets
whatever it implements. **Two conforming hosts may therefore render one stylesheet
differently**, and the surface above cannot catch it. This is stated rather than fixed:
pinning inheritance down would mean re-deciding CSS's inherited / non-inherited split
for all 28 words, and no consumer has needed it yet. A stylesheet that must render the
same everywhere should set the word on the block it means.

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

**v1 deliberately does not have**: script of any kind, URLs (dev/staging/prod
differ — a written-in address binds the stylesheet to an environment), routing,
theming beyond §1.2's tokens, or any body
content in its three block types.

**Not in v1, with its slot named**: an `override` attribute on a `style-rule`, for
the author who means a contested attribute to be that rule's without widening its
selector. §4's warning-and-first-wins is the rule until a real stylesheet shows the
warning is not enough; if that day comes, the answer is that attribute, not another
layer.

**Named but not yet exercised by a real stylesheet**: everything in §0.1's right
column. `filter=` in particular has never run against real noise (mustapi's edges
are all `kind=call` with empty confidence — nothing to filter), and `handler=` has no
real host. They are specified and checked, not battle-tested, and §0.1 says what
that buys you.

`geml style check` is marked EXPERIMENTAL in `geml --help` for this reason. It
works, it is tested, and its vocabulary is not yet settled — a command you can
rely on to be correct today, not to be spelled the same next year.
