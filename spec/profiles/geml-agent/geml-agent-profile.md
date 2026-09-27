# geml-agent profile v1 — a statechart for an agent, and its ledger

*English | [中文](geml-agent-profile_CN.md)*

- Status: **experimental**, v1, 2026-09-14. Design rationale:
  [`docs/design/specs/2026-09-14-geml-agent-runtime-design.md`](../../../docs/design/specs/2026-09-14-geml-agent-runtime-design.md).
- Nature: **an application-layer profile, not part of the GEML standard.** Every
  block below has a `raw` or `flow` body §3 already defines; GEML never reads a
  new syntax inside one. The runtime that interprets them is
  `@geml/agent-runtime` (`integrations/geml-agent-runtime/`), a DeepSeek Harness
  plugin bundle with an offline CLI, `geml-agent`.

## 0. What it is in one paragraph

A document that declares `profile = "geml-agent/v1"` describes an **agent
statechart**: the states an agent can be in, the prose instructions it is given
in each, which tools it may see there, which variables it may set, and the
transitions between states with their guards. A second kind of document, the
**ledger**, records one run: an append-only sequence of `agent-snapshot` blocks
(revision, state, variables, hash chained to the previous block) and
`agent-refused` blocks (a transition or patch the guards rejected). Both are
ordinary GEML: `geml check` validates them, `geml get ledger.geml '#rev-7'`
reads one revision, `.gemlhistory` versions the statechart like any document.

What the vocabulary does **not** do: it constrains only what it models. A
rollback restores declared variables and the control state, never an external
side effect; tool gating decides which tools the model can call in a state, not
what an allowed tool does; resuming from a ledger restores the state, while the
conversation is the harness's own business.

## 1. Declaring the profile

```geml
=== meta
profile = "geml-agent/v1"
tools   = "read_file grep"
===
```

`tools` on `=== meta` is the document-wide default for states that carry no
`tools=` of their own. Without the declaration the same document parses to the
same model (§8.6 rule 4) and every `agent-*` block is an `unknown-block-type`
warning.

## 2. Blocks

| type | body | attributes | meaning |
|---|---|---|---|
| `agent-vars` | raw, JSON | — | The variables' JSON Schema. Object root, at most one per document, restricted to the subset in §4. `default` supplies the initial value. |
| `agent-state` | **flow** | `initial` `final` `pause` `tools` `vars` `rollback-on-error` | One state. The body is the instruction the model receives while in it, byte for byte. |
| `agent-transition` | **flow** | `from` `to` `requires` `approval` | One edge. The body is how the model is told about it. |
| `agent-snapshot` | raw, JSON | `rev` `state` `cause` `parent` `hash` `at` `call` `from` `restores` | One revision of a run (ledger only). The body is the variables, canonical JSON on one line. |
| `agent-refused` | raw, JSON | `rev` `at` `tool` `call` | One rejected attempt (ledger only). The body is `{"reason": …, "diagnostics": […]}`. |

### 2.1 `agent-state`

- `initial` — exactly one state per document carries it.
- `final` — a terminal state: it may have no outgoing transition, and entering it ends the agent's turn.
- `pause` — entering it ends the current turn; the run continues from here when the next input arrives (a human reply, a webhook).
- `tools="a b"` — space-separated names of **global** tools visible in this state. Absent: inherit `tools` from `=== meta`; both absent: unrestricted. The literal `none`: no external tool at all.
- `vars="x y"` — the variables the model may set in this state. Absent: all. `none`: read-only state. Every name must exist in `agent-vars`.
- `rollback-on-error` — when any external tool fails in this state, variables and state return to the revision at which this state was entered.

A state's body is delimited by GEML's ordinary fence rule, so a line inside it
that is a bare `=` run of the opening length ENDS the block there — an
instruction that quotes GEML must open the state with a longer fence
(`==== agent-state …`) or the text below that line is silently lost. `geml
check` reports nothing, because the truncated block is well formed.

### 2.2 `agent-transition`

- `from=#id`, `to=#id` — states, written with the `#` GEML uses for a block reference in an attribute (`data=#id`).
- `requires=#id` — a `data {format=json}` block holding a JSON Schema (§4). The transition is allowed only when the current variables, taken as one object, satisfy it.
- `approval` — the harness must grant a one-shot approval before the transition commits; no approval service, or a refusal, means the transition is refused.

### 2.3 The ledger

```geml
=== meta
title           = "geml-agent ledger"
profile         = "geml-agent/v1"
session         = "session-…"
statechart      = "…/agent.geml"
statechart-hash = "sha256:…"
created         = "2026-09-14T12:00:00Z"
===

=== agent-snapshot {#rev-0 rev=0 state=#intake cause=enter hash="sha256:…" at="2026-09-14T12:00:00Z"}
{"amount":0,"approved":false}
===

=== agent-snapshot {#rev-1 rev=1 state=#intake cause=patch parent="sha256:…" hash="sha256:…" at="…" call="call_01"}
{"amount":120,"approved":false,"order":"A-17"}
===

=== agent-refused {#refused-1 rev=1 at="…" tool=agent_transition call="call_02"}
{"reason":"transition #to-pay: requires #is-approved failed","diagnostics":["$.approved: expected const true, got false"]}
===
```

- `rev` starts at 0 and is contiguous. `cause` is one of `enter`, `transition`, `patch`, `rollback`, `error-rollback`.
- `hash` = `"sha256:" + sha256(canonical({v: 1, rev, parent: parent ?? null, state, vars}))`, where `canonical` sorts keys by code point and emits no whitespace. `parent` is the previous block's `hash`; revision 0 has none. Because `rev` and `parent` are hashed, the blocks form a chain: reordering, deleting or editing any one breaks verification. Deleting a **trailing** run of blocks is the one edit the chain cannot detect — every remaining block still verifies — so a ledger's tail is only as trustworthy as the storage under it.
- `from` is present on `transition`, `rollback` and `error-rollback` (the state left); `restores` on the two rollbacks (the revision restored, `< rev`); `call` is the harness call id that caused the change when there was one.
- A ledger is written by **blind append**: each block is complete on its own, so the writer never reads the file (GEP-0005). The `#rev-N` / `#refused-N` ids make every revision addressable.

## 3. Static checks

`geml-agent check` runs `geml check` first (an error there refuses the document) and then reports:

| code | severity | when |
|---|---|---|
| `agent-no-initial` / `agent-many-initial` | error | not exactly one `initial` |
| `agent-bad-ref` | error | `from` / `to` / `requires` is not `#id`, or names a block of the wrong type |
| `agent-final-outgoing` | error | a `final` state has an outgoing transition |
| `agent-dup-edge` | error | two transitions share the same `from` and `to` |
| `agent-vars-schema` | error | more than one `agent-vars`, or its body is not an object schema in the §4 subset |
| `agent-requires-schema` | error | a `requires` target is not a schema in the subset |
| `agent-unknown-var` | error | `vars=` names a variable not in the schema |
| `agent-unreachable` | warning | a state the initial state cannot reach |
| `agent-dead-end` | warning | a non-final state with no outgoing transition |
| `agent-unknown-tool` | warning | `tools=` names a tool the runtime does not know (only when the tool list is known) |

`geml-agent verify` checks a ledger: contiguous `rev`, every `parent` equal to the previous `hash`, every `hash` recomputed, `cause` consistent with `from` / `restores`, and — given the statechart — every `state` exists and every transition matches a declared edge.

## 4. The JSON Schema subset

Exactly the subset the DeepSeek Harness tool registry enforces: any JSON root; a single scalar `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`); `properties`, `required`, boolean `additionalProperties`; `items`; scalar `enum` / `const` matching the type; `oneOf` with at least two branches of which exactly one must match; the annotations `title`, `description`, `default`, `examples`. **Any other keyword is an error**, not an ignored hint — `minimum` silently doing nothing would be worse than refusing it.

## 5. Conformance (informative)

A GEML processor that does not recognize `geml-agent/v1` is unaffected: it reports the five types as `unknown-block-type` warnings and keeps every body raw (§8.6 rule 3). Only the runtime reads the JSON bodies, and only `geml-agent verify` checks the chain.
