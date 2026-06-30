---
gep: 0000
title: <short descriptive title>
state: draft        # draft | accepted | final | withdrawn | rejected
author: <name / handle>
created: <YYYY-MM-DD>
issue: <link to the discussion issue>
---

## Summary

One paragraph: what changes, in plain terms.

## Motivation

What problem does this solve? Who feels it, and how often? Why is the status quo
inadequate? Concrete examples beat abstractions. If this is about documents
written or edited by AI agents / CI, say so — that's GEML's center of gravity.

## Design

The precise change. Show GEML before/after. State exactly how the body is parsed
and what the resulting document model looks like. If it touches inline grammar,
attributes, references, or conformance, spell out the rule unambiguously — the
spec is a contract two independent implementations must agree on.

```
=== example
before / after GEML here
===
```

## Conformance impact

**Required.** A spec change is not real until the conformance suite encodes it.
List the new/changed cases (in `geml-parser/test/conformance/`) and their
expected projection. If the projection grammar itself must change, justify it.

## Alternatives considered

What else was on the table, and why this option won. Include "do nothing".

## Compatibility & migration

Does this break existing valid documents? Can `geml fmt` / `geml convert` bridge
it? Does it change what was previously an error/warning?

## Drawbacks & open questions

The honest costs, and anything still unresolved.
