# P0 #3 — GEML generation fluency

Can current Claude models emit GEML that the reference parser accepts, zero-shot vs. with the one-page [`SKILL.md`](SKILL.md)? Each cell is one generation per [fixture](fixtures.mjs); outputs are parsed unmodified.

- **parse-clean** — zero *error* diagnostics (refs resolve, fences close, formulas valid, ids unique).
- **feature-correct** — the requested construct was actually emitted (not avoided).
- **both** — feature-correct *and* parse-clean: did the task, in valid GEML.

| model | condition | parse-clean | feature-correct | both | warnings |
|---|---|---|---|---|---|
| haiku | skill | 67% (4/6) | 83% (5/6) | 67% (4/6) | 0 |
| haiku | zeroshot | 67% (4/6) | 17% (1/6) | 0% (0/6) | 3 |
| sonnet | skill | 83% (5/6) | 100% (6/6) | 83% (5/6) | 0 |
| sonnet | zeroshot | 83% (5/6) | 67% (4/6) | 50% (3/6) | 2 |

## Error breakdown (all error diagnostics across all runs)

| category | count |
|---|---|
| table formula (compute/summary) | 4 |
| unterminated fence (nesting) | 3 |
| chart binding | 2 |

## Findings (after the footgun fixes)

This round re-measures after two parser fixes — **footnote definitions** (`[^id]: text` now resolves) and **labeled close fences** (`=== #id` closes by name, independent of fence length) — plus the matching skill updates. Against the pre-fix baseline the error mix went from `{footnote 4, fence 3, formula 3, chart 2}` to `{formula 4, fence 3, chart 2}`: the footnote class is gone.

1. **The footnote fix landed cleanly.** Models reach for Markdown footnotes by habit; making `[^id]: text` a real definition removed the entire "unresolved footnote" category (4 → 0) and lifted haiku zero-shot parse-clean 50% → 67% — every `cross-refs` cell is now clean.
2. **The labeled close helps the capable model, less the weak one.** With the `=== #id` recipe, Sonnet+skill nests a code block inside a note correctly; Haiku still miscounts fences even with the recipe (the unterminated-block error now *names* the labeled close, but a small model doesn't take it). Fence nesting stays the footgun for small models.
3. **The compute/summary formula DSL is now the leading error category** (4): wrong column names and malformed formulas (`unknown column`, `missing )`). It was *not* changed this round — the next fix is to lift `compute`/`summary` out of the quoted attribute string onto their own body lines.
4. **A short skill still owns the *vocabulary* problem** (feature-correct: haiku 17%→83%, sonnet 67%→100% from zero-shot to skill). parse-clean is still short of high-90s (haiku 67%, sonnet 83%) — now bounded mainly by the formula DSL and weak-model fence nesting, not footnotes.

## Per-output detail

| model | condition | fixture | parse-clean | feature | first error |
|---|---|---|---|---|---|
| haiku | skill | chart-bound | ✗ | ✓ | `compute `Total`: unknown column `North`` |
| haiku | skill | cross-refs | ✓ | ✓ |  |
| haiku | skill | diagram-math | ✓ | ✓ |  |
| haiku | skill | fy-table | ✓ | ✓ |  |
| haiku | skill | nested-fences | ✗ | ✗ | `unterminated `code` block (no matching === or `=== #example`` |
| haiku | skill | nested-structure | ✓ | ✓ |  |
| haiku | zeroshot | chart-bound | ✓ | ✗ |  |
| haiku | zeroshot | cross-refs | ✓ | ✗ |  |
| haiku | zeroshot | diagram-math | ✓ | ✗ |  |
| haiku | zeroshot | fy-table | ✗ | ✓ | `summary `FY Total`: missing )` |
| haiku | zeroshot | nested-fences | ✗ | ✗ | `unterminated `callout` block (no matching ===)` |
| haiku | zeroshot | nested-structure | ✓ | ✗ |  |
| sonnet | skill | chart-bound | ✗ | ✓ | `summary targets unknown column `Region`` |
| sonnet | skill | cross-refs | ✓ | ✓ |  |
| sonnet | skill | diagram-math | ✓ | ✓ |  |
| sonnet | skill | fy-table | ✓ | ✓ |  |
| sonnet | skill | nested-fences | ✓ | ✓ |  |
| sonnet | skill | nested-structure | ✓ | ✓ |  |
| sonnet | zeroshot | chart-bound | ✓ | ✓ |  |
| sonnet | zeroshot | cross-refs | ✓ | ✗ |  |
| sonnet | zeroshot | diagram-math | ✓ | ✓ |  |
| sonnet | zeroshot | fy-table | ✓ | ✓ |  |
| sonnet | zeroshot | nested-fences | ✗ | ✓ | `unterminated `geml` block (no matching ======)` |
| sonnet | zeroshot | nested-structure | ✓ | ✗ |  |

## Method & caveats

- Sample size is small (one generation per cell); this is a directional measurement, not a benchmark.
- "parse-clean" is the load-bearing metric: GEML degrades unknown input to paragraphs/warnings, so almost anything *parses* — the question is whether the build-time **checks** accept it.
- **Tool-access caveat (important).** Generation subagents had tools; the more capable ones (Sonnet) ran the reference parser and iterated, so their parse-clean reflects "an agent with the build-checks in the loop" — an *upper bound*, not a single-shot completion. The Haiku cells that did a single `Write` are closest to one-shot, and they are the weakest. A true one-shot parse-clean is likely **below** the numbers above; a cleaner run would disable tool access during generation.
- Fixtures deliberately stress the two footguns the design review flagged: **fence-length nesting** (`nested-fences`) and the **compute/summary formula DSL** (`fy-table`).
- Reproduce: generate `bench/outputs/<model>__<cond>__<fixture>.geml`, then `node bench/score.mjs`.
