# GEML vs XML / JSON — a comparison, and a post-mortem

*English | [中文](GEML-vs-XML-and-JSON_CN.md)*

GEML is compared with XML here not because they resemble each other, but because
**the problem GEML sets out to solve is one XML already solved once — and then lost
two territories doing it.**

"Structured, verifiable documents a machine can address precisely" was XML's
promise in 1998, and it delivered: Office documents, DocBook, Android layouts,
Maven, RSS, SOAP. For two decades it was everywhere. Any format making that claim
today owes an answer to one question first: **why won't you repeat it?**

JSON is not a supporting character in this story. It won one of those two
territories, and how it won is worth taking apart on its own. More to the point,
**JSON is already the machine-side representation of documents** — MDAST,
ProseMirror, Slate and Lexical all store JSON ASTs. So the real question between
GEML and JSON is not which replaces which. It is **which one you store as the
source of truth.**

Three parts: a per-construct comparison (every cell measured, same method as
[GEML-vs-CommonMark.md](GEML-vs-CommonMark.md)), the post-mortem (where XML lost,
how JSON won, why XSLT died), and what GEML does about it — including where it is
still exposed.

---

## 1. Per-construct: GEML and XML

| Topic | XML | GEML | |
|---|---|---|---|
| Basic unit | element `<tag>…</tag>`, freely nested | typed block `=== type {attrs}` … `===`, nesting by fence length (§3) | 🔁 |
| Tag vocabulary | **fully open**, any name is valid | registered types; **an unknown type is a warning, body kept raw**, not an error | 🔁 |
| Attributes | `key="value"`, strings only | `{#id .class key=val}`, one attribute object across every block type (§4) | 🔁 |
| Element vs attribute | **no right answer** — the first argument of every schema design | the question does not arise: body is body, attributes are attributes | 🔁 |
| Unique identity | `xml:id`; **uniqueness is only enforced with a DTD/XSD** | `{#id}` is core syntax, and **a duplicate id is an error** (measured: exit 1), no schema needed | 🔁 |
| References | `IDREF` (needs a schema), XLink, XPointer | `[[#id]]`, `[t](#id)`, `other.geml#id` — **checked at build time, dangling is an error** (§5.2) | 🔁 |
| Namespaces | `xmlns:`, prefix bound to a URI | **none**, deliberately | ❌ |
| Schema validation | external: DTD / XSD / RELAX NG, two systems | built in: `geml check` + the stable diagnostic codes of Appendix A | 🔁 |
| Well-formed vs valid | two concepts, two toolchains | one: diagnostics carry a fixed severity, an error is a non-zero exit | 🔁 |
| Escaping | five predefined entities; `<` and `&` must be escaped | backslash-escapes ASCII punctuation; **no entity is decoded** — `&amp;` is five literal characters | ⚠️ |
| Verbatim payloads | `<![CDATA[…]]>`, cannot nest `]]>` | raw body; **a body containing a fence lengthens the outer fence** (`====`), nests without limit | 🔁 |
| Entity expansion | internal/external entities, **recursive** | only `{{key}}` from `meta`, **expanded once, never recursively** (measured: `a = "{{b}}"` yields the literal `{{b}}`) | 🔁 |
| External entities | `SYSTEM "file:///etc/passwd"` — the origin of XXE | **no entity mechanism.** Outside content arrives only through `src=`/`embed`, which is confined by `--root`, scheme-restricted, and never fetched by the parser (§9.4) | ❌ |
| Cross-document inclusion | XInclude — a separate spec, optional in most parsers; `xml:base` fixup keeps the target's base URI | **core syntax**: `=== embed {src=other.geml#id}`, inline `![[…]]`, and `other.geml#id` references — resolved at build time, cycle-detected (`transclusion-cycle`), scoped by `--root`. The named document is parsed **as a document in its own right**, so it resolves its own paths and metadata at every depth of the chain (§3) | 🔁 |
| Typed data payload | any element tree; a type only with a schema | `=== data {format=json\|jsonl}` — **JSON's value domain verbatim**, parsed and verified at build time, addressable by `#id` (§3.2) | 🔁 |
| Comments | `<!-- … -->`, cannot contain `--` | `%%` lines; plus `{hidden}` — **in the model, reference-checked, not rendered** | 🔁 |
| Mixed content | elements and text freely interleaved | the inline grammar inside a flow body (`*em*`, `[[#id]]`, `$math$`) | 🔁 |
| Whitespace | `xml:space`, intricate rules | raw bodies verbatim; flow bodies by paragraph rules | 🔁 |
| Encoding | declared in `<?xml encoding=?>`, many | **UTF-8, mandatory** (§0.1) | 🔁 |
| Readable unrendered | poor — angle brackets and closing tags drown the prose | **a design constraint** (§1) | 🔁 |
| Transformation | XSLT (a second language) | none. `--to md \| html \| geml`, fixed projections | ❌ |
| Query | XPath / XQuery | no query language. `geml get <file> '#id'` fetches by primary key | 🔁 |

**One inconsistency turned up while measuring.** An unknown **block type** warns;
an unknown **attribute key** says nothing at all (`{#n wibble=3}` produces zero
diagnostics); an unknown **`{{meta}}` reference** is an error. The same typo gets
three different treatments, and the attribute case is the loosest — misspell
`caption` and nobody tells you.

---

## 2. Three-way comparison

| Dimension | XML | JSON | GEML |
|---|---|---|---|
| Spec volume | a dozen interdependent specs | **~15 pages, and frozen** | one core spec + one optional extension |
| Built for | documents **and** data | data interchange | documents |
| Maps to a language's native types | poorly — every binding layer leaks | **1:1** | n/a: a body is text |
| Hand-written by people | hostile | fine when short, a disaster for prose | **a design constraint** |
| Mixed content (structure inside prose) | **native** | only as an array of typed nodes | **native** (flow bodies) |
| Holding a JSON value as-is | escaped text, or a lossy element mapping | it *is* the value | `=== data {format=json}` — the same value domain, **verified at build time**, carrying an id (§3.2) |
| Comments | `<!-- -->` | **none** (removed on purpose) | `%%` and `{hidden}` |
| Unique identity | `xml:id`, enforced only with a schema | none (key paths only) | core syntax; a duplicate is an error |
| Referential integrity | IDREF, needs a schema | none | **enforced at build time** |
| Schema | external, two systems, culturally mandatory | **optional, retrofitted** (JSON Schema) | built-in diagnostics, no external system |
| Line-oriented diff | fair | poor (ordering, indentation, trailing commas) | good |
| Canonical form | C14N exists, but as a separate spec built for signatures | JCS (RFC 8785) exists, rarely used | **built into the main tool**: `--to geml` |
| Round-trip with its own model | no such concept | trivial (JSON *is* the model) | both directions, and **the two paths converge byte-for-byte** (measured) |
| Version evolution | XML 1.1 is barely used, yet every parser must account for it | **never a v2** | 1.0; spec and implementation versioned separately |
| Unknown content | any tag is valid | extra keys are accepted | unknown type warns, body preserved |

---

## 3. First, a correction: XML did not die

A post-mortem starts by getting the facts right, or the lessons it yields are
fiction.

XML still holds several territories firmly: **Office / OpenDocument, the DocBook
and DITA publishing toolchains, XBRL (financial reporting), HL7 (healthcare), and
long-lifecycle technical documentation in aerospace and semiconductors.** What
those share is mixed content plus strong schema validation plus a decades-long
archival requirement. Nothing has displaced it there.

What it lost was **two specific territories**, to **two different opponents, for
entirely different reasons**:

| Territory | Lost to | Roughly |
|---|---|---|
| Data interchange | **JSON** | 2005–2012 |
| Hand-written documents | **Markdown** | from 2004, accelerating after CommonMark in 2014 |

Collapsing those into "XML was too verbose, so it died" is the standard mistake,
and it yields the one lesson that helps least: *don't be verbose.*

---

## 4. How JSON won

"It maps to native types" is the answer usually given. It is correct and
incomplete. JSON won on four things:

**One — it corresponds one-to-one with what programs already had.** Object,
array, string, number, boolean, null: that *is* the native type set of every
dynamic language. What `JSON.parse()` returns is immediately usable.

XML maps onto a tree of elements plus attributes plus text nodes plus mixed
content plus namespaces plus significant ordering. **No language has a native
type shaped like that**, so every binding layer (JAXB, XmlSerializer, …) was
lossy and every one of them leaked.

**Two — the spec is small enough to read in one sitting, and it is frozen.**
ECMA-404 / RFC 8259 run about fifteen pages; the railroad diagrams on json.org
*are* the grammar. More importantly it no longer evolves — there is no JSON v2
and there will not be one.

> A format that never changes is a format whose toolchain never breaks.

That is XML's mirror image: XML 1.1 is barely used, yet every parser still has to
account for it. **"The spec doesn't move" is itself a feature delivered to the
ecosystem**, and most format authors mistake it for stagnation.

**Three — the schema is optional and came later.** JSON Schema arrived more than
a decade after JSON, and it was never an entry requirement; JSON works fine
without it. In the XML world DTD/XSD were culturally mandatory — "XML without a
schema" read as unprofessional. **Making validation optional drops the cost of
entry to zero.**

**Four — "element or attribute?" simply disappeared.** In XML that question has
no right answer, so it became the first argument in every schema design and was
never settled. JSON offers one way to write things.

On top of that, XML carried two bills of its own:

- **Namespaces.** They solve a real problem — composing independently authored
  vocabularies — at a cost **everyone paid and few collected**. The vast majority
  of documents never compose vocabularies, yet everyone had to understand prefix
  binding.
- **A metastasising spec stack.** XSD, XPath, XSLT, XLink, XPointer, XQuery,
  XInclude, XMLDSig, SOAP, WSDL, WS-\*. Being "an XML developer" meant knowing a
  dozen specifications.

**Those bills are really one bill: the cost of the complexity was charged to
everyone who touched any part of it.**

That, not the angle brackets, is why XML lost data interchange. There was **no
path that said "you don't have to know about this part."**

---

## 5. What JSON is bad at is where GEML stands

JSON won data interchange. It has **never won documents**, and not for want of
people trying.

- **No comments.** Removed deliberately, because people were using them to smuggle
  parsing directives. The reasoning holds; the price is that JSON5, JSONC and YAML
  all exist to undo that one decision.
- **Numbers are underspecified.** No integer/float distinction; an int64 arriving
  in JavaScript becomes a float64 and loses precision.
- **No date type.** Everyone reinvents ISO-8601-in-a-string.
- **Prose is a disaster.** Everything is an escaped string with `\n` for newlines.
  Unreadable, undiffable, ungreppable.
- **No mixed content.** A paragraph interleaving emphasis, links and references can
  only be encoded as a nested array of typed nodes. Perfectly usable by a machine,
  entirely unreadable by a person.

That last point is decisive, and **the road has already been walked to its end**:
MDAST, ProseMirror, Slate, Lexical, Tiptap, Notion, Contentful — the storage
format of nearly every modern rich-text tool is a JSON AST.

Its failure mode is documented: **you cannot diff it, you cannot grep it, and you
cannot edit it away from the app.** A code review shows several hundred lines of
reordered node arrays; asking "who changed this sentence?" is a question git
cannot help with.

This is the state-box problem — except the example is not Word. It is **the most
modern tools we have.**

So GEML's position is not "a competitor to JSON". It is: **when you need a
document that will exist for a long time, that people read, that machines edit,
and that lives in git, "store the JSON AST" is the option that has already been
tried and whose failure mode is known.**

### 5.1 And the converse: GEML hosts JSON rather than arguing with it

The `data` block (§3.2) takes JSON's value domain — scalars, sequences, maps —
unchanged, as a typed block the build **parses**, and rejects with an error
naming the offending line when the body is malformed. That closes the gap from
the other side:

```
=== data {#limits format=json}
{ "retries": 3, "timeout_ms": 500 }
===
```

- The value carries an **id**, so it is referenceable, block-editable
  (`geml get`/`set`) and versioned by the same machinery as prose — the thing a
  bare `.json` file next to the document cannot be.
- `format=jsonl` is the record-stream form. Because a document is a flat
  sequence of blocks, a complete `data` block appended at end-of-file is a valid
  continuation of *any* document: jsonl's blind-append ergonomics, with
  verification.
- `src=events.jsonl` keeps the records in a plain file every existing tool can
  append to and tail. The GEML document becomes its verified, addressable,
  chartable **view** — not a second copy. A body *and* `src=` is an error: one
  source, always.
- A `data` block whose value is a record array feeds `geml-chart` directly
  (§7.1), so the same bytes a service writes are the bytes the chart draws.
- `csv`/`tsv` are deliberately **not** `data` formats. Admission to the registry
  requires the syntax to be self-describing — the bytes alone determine the
  value. Delimited text fails that (delimiter, header presence and quoting are
  parameters, and only meaningful against a column model), so it stays a `table`
  format (§6). `yaml` and `toml` are reserved names, and a processor without an
  engine for them must keep the body raw and warn rather than guess.

The resulting position is narrower and more defensible than competing with JSON:
**for data interchange, use JSON — and when that data belongs to a document,
GEML holds the same bytes and checks them.**

---

## 6. Why XSLT failed

This deserves its own section, because "attach a capability alongside the
document" is something GEML has already done once — [`.gemlhistory`](../../spec/profiles/geml-history/geml-history-profile.md) —
and XSLT is the most famous failure of exactly that idea.

XSLT was not killed by verbosity. There are five causes, in order of lethality:

**One — it cut at a seam authors don't work at.**

This is the deepest one and the easiest to learn wrongly. CSS does nominally the
same job — separate presentation from content — and CSS succeeded. Why?

- CSS **never required the content to change for it** (classes are optional,
  selectors can work off structure), whereas XSLT required you to author in a
  vocabulary designed for the transform;
- CSS's feedback is **immediate** (edit a line, the browser repaints), whereas
  XSLT inserted a compile step and a second language between the keystroke and
  the result.

**The seam was not wrong; the feedback loop was severed.** The unit an author
iterates on is never "content" or "presentation" — it is the pair.

**Two — it demanded three unfamiliar things at once.** Functional programming
(template recursion, no mutable state), tree pattern matching (XPath), and
reading all of it through angle brackets. Any one is learnable; the three
together exceeded the budget. `<xsl:for-each>` is an expensive way to write a
loop.

**Three — debuggability was near zero.** Template match conflicts resolved by
priority rules that few people ever mastered. When the output was wrong there was
no stack to inspect, only bisection by deletion.

**Four — templating languages ate it from below.** ERB, JSP, Smarty, then Jinja,
Handlebars, JSX — **90% of the value for 10% of the learning cost, in the language
you already knew.** A solution requiring a dedicated language, against an opponent
of "you already know this", cannot win.

**Five — the best implementation was commercial.** XSLT 2.0 (2007) and 3.0 (2017)
are genuinely good — streaming, packages, higher-order functions. By then the
audience had left, and the good parts largely lived in Saxon-EE.

> **A standard whose best implementation costs money has already lost the default
> position.**

For GEML the lesson is not "don't charge" (GEML is MIT + CC-BY). It is the mirror
form: **GEML currently has one implementation.** A single implementation and a
single commercial implementation pose the same class of risk to the question *can
this format exist independently of one supplier?* — which is why
[`GOVERNANCE.md`](../../GOVERNANCE.md) treats a second independent implementation as
an acceptance criterion rather than a nice-to-have.

---

## 7. What GEML has already avoided

Mapping the causes above back, one by one. None of this is luck; it is written
into the constraints (core spec §1):

| Cause of death | GEML's corresponding design |
|---|---|
| XML: metastasising spec stack, cost charged to all | **one primitive**: `=== type {attrs}` covers code, tables, math, diagrams, callouts, metadata |
| XML: namespaces | **not done.** The type vocabulary is flat and extensible; an unknown type degrades to raw rather than erroring |
| XML: the eternal element-vs-attribute argument | body and attributes have distinct jobs; there is nothing to argue about |
| XML: hostile to hand-writing | **readable without rendering** is a hard constraint (§1) — the lesson taken from Markdown |
| XML: external entities / XXE | **no entity mechanism.** `{{key}}` reads only this document's `meta`. Transclusion (`embed`, `src=`) does reach outside, and is fenced rather than forbidden: confined by `--root` (§9.4), URL schemes outside the allowlist refused, and `http(s)` deferred to the renderer — the parser never fetches |
| XML: recursive entities / billion laughs | **expanded once.** `a = "{{b}}"` yields the literal `{{b}}` (measured). Transclusion *is* recursive, so it is cycle-checked instead: a document already being expanded in the chain is a `transclusion-cycle` error |
| XML: id uniqueness needs a schema | core syntax enforces it; a duplicate id is an error |
| XML: validation needs two external systems | `geml check` is built in, with stable diagnostic codes |
| XSLT: a second language | **no transformation language**, only three fixed projections |
| JSON: no comments | `%%` lines plus `{hidden}` (in the model, checked, not rendered) |
| JSON: prose stuffed into escaped strings | raw bodies kept verbatim, plus fence escalation — no escaping needed |
| JSON: no mixed content | flow bodies support inline structure natively |

**Three things taken from JSON:** a spec surface small enough to read in one
sitting; a schema that is not an entry requirement (an unknown type only warns —
JSON's "extra keys are accepted"); and, most importantly, **mapping onto the
operations the consumer already performs** — see the next section.

---

## 8. How far the GEML–JSON round trip goes

Both directions work:

```console
$ geml doc.geml --to json -o doc.json          # the document model
$ geml doc.json --from json --to geml          # back to GEML
```

So how faithful is the round trip? **The decisive experiment is to collide the two
paths**: canonicalise directly (`--to geml`), versus detour through JSON (`--to
json`, then `--from json --to geml`).

On a document written to be adversarial — quoted `meta` values, a `%%` comment,
one auto-derived heading id and one explicit, a five-`=` fence whose body contains
a bare `===` line, attributes out of order, mixed quoting, trailing whitespace, a
cross-block reference:

```console
$ diff direct.geml viajson.geml
$                                    # no output — byte-identical
```

**Both paths land on the same canonical bytes.** Round-tripping again is
idempotent; `check` reports zero diagnostics; the `%%` comment, the trailing
whitespace and the cross-block reference all survive.

So: **the semantics round-trip completely, the bytes do not** — and "do not"
applies only to the *original authorial formatting*, never to content.

| Source-level feature | In the model | After canonical round trip | Verdict |
|---|---|---|---|
| raw body verbatim (incl. trailing spaces) | ✅ | unchanged | not lost |
| `%%` comment | ✅ `kind:"hidden"` | preserved | not lost |
| `meta` key order | ✅ insertion order | preserved | not lost |
| `.class` order | ✅ array | preserved | not lost |
| fence length | ❌ | **recomputed to the minimum viable value** | **derivable**, not lost |
| whether a heading id was written or derived | ❌ | always written out explicitly | **decidable**: compute the derivation and compare |
| labeled close `=== #id` | ❌ | normalised to `===` | lost; authorial style |
| attribute source order | ❌ | canonical `#id .class key=` | lost; authorial style |
| attribute value quoting | ❌ | always quoted | lost; authorial style |
| `meta` value quoting | ❌ | always unquoted | lost; authorial style |
| blank-line counts | ❌ | normalised | lost; typography |

Three conclusions:

**One — the model is semantically complete, and that is now measured rather than
argued.** "Via JSON" and "not via JSON" land on the same byte, which means nothing
affecting the document's meaning is lost. `--from json` is therefore not a
separate capability; it is the same canonical serializer with a different front
door.

**Two — what gets normalised is authorial style, and two of those are not even
losses.** Fence length is determined by the body: measured on a document whose
body contains a bare `===`, an original five-`=` fence is correctly reduced to
four — the minimum viable value — with the body untouched. A heading's derived id
is a function of its text, so computing it tells you whether to write it out.

**Three — so the isomorphism claim has to be stated differently.** Claiming "no
formatting information and no semantics is ever lost" is half right: formatting is
always normalised. What holds up is:

> **The model is semantically complete; serialization is canonical, not
> byte-preserving.**

And canonicalisation is a capability, not a concession: it means **two
semantically identical documents necessarily converge on the same bytes**, so
what remains in a diff is a real change and not formatting noise.

To be precise, canonical form is not unique to GEML — XML has C14N (built for
digital signatures) and JSON has JCS (RFC 8785). The difference is that **both of
those are separate specifications needing separate implementations, and both are
rarely used**, whereas GEML's canonical form is an output target of the main tool
(`--to geml`) and has been **verified to agree byte-for-byte with the detour
through JSON**. CommonMark has no such concept at all.

**This is a stronger claim than "byte-for-byte isomorphic", because it is
verifiable — the `diff` above is the verification.**

> **One inconsistency worth noting**: canonicalisation *adds* quotes to block
> attributes (`lang=py` → `lang="py"`) but *removes* them from `meta` values
> (`zebra = "last key"` → `zebra = last key`). Two opposite conventions in one
> serializer.

Even with the round trip in place, **an agent's write path still should not go
through a whole-AST round trip** — that is precisely "read the entire document,
emit the entire document", the action GEML exists to eliminate. The division of
labour is:

- **Read**: a structured view is JSON (`--to json`); a single block comes by block
  (`geml get '#id'`).
- **Write**: block operations (`geml set / add / delete / rename / revert`).

This is where JSON's positive lesson lands. JSON won by **mapping onto what its
consumers already had** — the native types of a language. GEML's version of that
question is: does it map onto what an agent already does?

- An agent's native action is a tool call, not a file overwrite → the commands
  above correspond one to one.
- An agent's runtime is MCP → one `claude mcp add` line, eleven tools.
- What an agent most fears is breaking something without knowing → a write is
  parsed before it lands, and a bad one comes back refused with diagnostics.

**This is where GEML is most like JSON and least like XML**: it does not ask the
agent to learn a new paradigm; it shapes itself to the actions the agent already
has.

---

## 9. Where GEML is still exposed

Listed honestly, because they are real.

**One — the sidecar pattern is WS-\* in embryo.**

`.gemlhistory` is the only sidecar today, but it is a **pattern**, not a one-off
design — and "a family of companion specifications distinguished by file
extension" is structurally indistinguishable from XML's spec table. Each addition
is a step in that direction.

Only one rule holds it back, and that rule is one the history extension wrote for
itself (§1):

> "The history layer is **optional**. Its presence is signalled only by the
> existence of a sibling `.gemlhistory` file." A processor that does not implement
> the extension is **unaffected** — the `.geml` file remains a complete, valid,
> renderable document.

XML's namespaces **have no such property**: you cannot "ignore" a namespace; once
encountered it must be handled. That is the entire difference. Any companion-spec
proposal that makes tools which don't know about it change anyway is turning GEML
into XML — **this should be an admission gate for any new sidecar, not a style
suggestion.**

**Two — any presentational sidecar is XSLT's seam.**

Attaching style to block ids is the most tempting and most dangerous direction:
it cuts exactly where §6 says XSLT cut wrongly. A proposal of that kind has to
answer "why won't this repeat?" in its first paragraph, not park the question at
the end as a risk item.

**Three — build-time validation is a tax, and XSLT died of a tax.**

`geml check` inserts a step between the keystroke and the assurance that nothing
broke — structurally the same shape as XSLT's compile step. GEML is on the safe
side of this line today, because a file **reads and renders without being
validated**; validation is only mandatory on the write path. That property has to
be defended: **the day "you can't read the document without running check"
arrives, XSLT's death reproduces itself.**

**Four — migration is a switch, not a slide.**

An underrated reason Markdown spread is that it **let you embed HTML**: you could
use 10% of Markdown and keep writing HTML for the rest, at zero risk. JSON is the
same story — it never asked you to give anything up; `JSON.parse()` and you have
started.

GEML deliberately closed the raw-HTML escape hatch (§1.5), buying semantics
independent of any rendering backend, at the cost of **having no incremental
path**: `geml notes.md` converts in as a one-time switch, and converting back is
lossy.

**This is GEML's hardest adoption barrier — harder than the ecosystem, harder
than the tooling.** Knowing precisely what it is beats pretending it isn't there.
