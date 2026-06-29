# P0 #3 — GEML generation fluency

Can current Claude models emit GEML that the reference parser accepts, zero-shot vs. with the one-page [`SKILL.md`](SKILL.md)? Each cell is one generation per [fixture](fixtures.mjs); outputs are parsed unmodified.

- **parse-clean** — zero *error* diagnostics (refs resolve, fences close, formulas valid, ids unique).
- **feature-correct** — the requested construct was actually emitted (not avoided).
- **both** — feature-correct *and* parse-clean: did the task, in valid GEML.

| model | condition | parse-clean | feature-correct | both | warnings |
|---|---|---|---|---|---|
| haiku | skill | 67% (4/6) | 83% (5/6) | 67% (4/6) | 0 |
| haiku | zeroshot | 50% (3/6) | 17% (1/6) | 0% (0/6) | 3 |
| sonnet | skill | 83% (5/6) | 100% (6/6) | 83% (5/6) | 0 |
| sonnet | zeroshot | 83% (5/6) | 67% (4/6) | 50% (3/6) | 2 |

## Error breakdown (all error diagnostics across all runs)

| category | count |
|---|---|
| unresolved ref/footnote | 4 |
| unterminated fence (nesting) | 3 |
| table formula (compute/summary) | 3 |
| chart binding | 2 |

## Findings

1. **A short skill is essential for *using* GEML's constructs.** Zero-shot, models fall back on Markdown habits — fenced `mermaid`, `$$`, `[text](#id)`, Markdown footnotes — so feature-correct collapses (haiku 17%, sonnet 67%). With the one-page skill they actually emit `=== diagram {format=geml-chart}`, `[[#id]]`, `compute=`/`summary=` (haiku 83%, sonnet 100%). The cold-start gap is real, but a one-pager closes most of the *vocabulary* problem.
2. **parse-clean does NOT reach the high-90s bar, even with the skill** (haiku 67%, sonnet 83%) — and those are *optimistic* (see the tool-access caveat). By the roadmap's own conditional, missing high-90s **escalates the P1 footgun fixes to P0.**
3. **Failures cluster on exactly the rules the design review flagged:**
   - **Fence-length nesting** — the most-failed fixture (`nested-fences`): wrong in 3 of 4 cells, *including with the skill* (a `=== code` closed with `====`). For an autoregressive model, the non-local "outer fence must be longer" rule is hard to plan.
   - **The compute/summary formula DSL** — malformed formulas and wrong column names (`missing )`, `summary targets unknown column`).
   - **The reference / footnote model** — models write a Markdown footnote `[^1]` with no target block (a build error), and don't reach for `[[#id]]` without the skill.
4. **Actionable:** promote the P1 fixes — relax the close fence to **≥** the opening length (or a named/heredoc close), lift `compute`/`summary` out of quoted attribute strings, and address the Markdown-footnote trap — then re-measure. Those three changes target every error category above.

## Per-output detail

| model | condition | fixture | parse-clean | feature | first error |
|---|---|---|---|---|---|
| haiku | skill | chart-bound | ✓ | ✓ |  |
| haiku | skill | cross-refs | ✗ | ✗ | `unresolved footnote `[^geml-info]`` |
| haiku | skill | diagram-math | ✓ | ✓ |  |
| haiku | skill | fy-table | ✓ | ✓ |  |
| haiku | skill | nested-fences | ✗ | ✓ | `unterminated `code` block (no matching ====)` |
| haiku | skill | nested-structure | ✓ | ✓ |  |
| haiku | zeroshot | chart-bound | ✓ | ✗ |  |
| haiku | zeroshot | cross-refs | ✗ | ✗ | `unresolved footnote `[^1]`` |
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
