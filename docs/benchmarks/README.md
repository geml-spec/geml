# Benchmarks

The instruments live here because they need this repository — the corpus they
measure and the CLI they measure it with. The write-ups they produce live with
the rest of the outreach material.

| script | what it measures |
|---|---|
| `addressing-cost.mjs` | One edit's cost, on a controlled corpus: four documents this repository keeps as both Markdown and GEML, ~12 blocks sampled from each, both arms executed for real. |
| `real-session-replay.mjs` | A full day of real editing, with each edit done the way that suits it — mechanical bulk replacement left on the original commands, edits that need an address moved to GEML. |

```sh
node docs/benchmarks/addressing-cost.mjs
node docs/benchmarks/real-session-replay.mjs
```

Both take `--json` for the per-edit rows.

`real-session-edits.json` is the frozen baseline for the replay: 33 edits one
agent made to `README_CN.md` over a single day, recovered from its session log,
each carrying what it actually cost. The log itself is not published — that file
is everything derived from it, and it can be audited row by row. The GEML side
is executed on every run, so the numbers move when the CLI does.

Design decisions for both — corpus, sampling, what is counted, and the two
choices that deliberately favour the Markdown side — are stated in each script's
header comment, and were fixed before the first run.
