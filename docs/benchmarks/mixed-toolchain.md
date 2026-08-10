# A real day of editing: the mixed-toolchain benchmark

> **The headline: only 4 of 14 edits needed an address, and those 4 accounted
> for half the cost — moving just them to GEML cut the day's reading by 1.48×
> and the bytes spent saying WHERE by 7×.**
>
> The other 10 were mechanical bulk replacements and **stayed on the original
> commands**, identical on both sides. All of the gain comes from the few edits
> that had to be understood before they could be made.

This benchmark complements the [addressing benchmark](addressing-cost.md): that
one measures a single edit's ceiling on a controlled corpus, this one asks what
**a full day of real work** looks like once each edit is done with the tool that
suits it.

To reproduce:

```sh
node docs/benchmarks/real-session-replay.mjs
```

## The premise: an agent is not confined to GEML

An agent has many tools, and **picking the one that fits is simply correct**.
For a mechanical swap where the exact old text is already known, `sed` and a
one-off script are fast and cheap. GEML earns its place on the edits that need
to see the content and address it.

So the question here is not "can GEML replace sed". It is: **use GEML only where
it belongs, and what does a day cost then?**

## The baseline is not a model

`real-session-edits.json` is the recovered record of one agent (Claude) editing
this repository's `README_CN.md` for a day: **33 edits**, each carrying what it
actually cost at the time — bytes read to locate the place, how many calls that
took, and bytes written to say where the change goes. The session log itself is
not published; that file is everything derived from it, and it can be inspected
line by line.

Those 33 edits were made with two tools:

| tool | count | how |
|---|---:|---|
| `Edit` (one at a time) | 12 | read first, then replace a unique piece of text |
| node script (batched) | 19 | several `s.replace('old','new')` in one script — **blind, no reading** |
| `Write` | 2 | whole-file write |

**14 are replayable.** The other 19 put text into the document that is no longer
there — it was itself rewritten later the same day, so **neither tool could
locate it**. That is the ceiling of replaying history, not a thumb on the scale.

## The split, fixed before running

**Nothing here picks whichever tool turned out cheaper.** The division is the
agent's own choice, recorded at the time:

- the 10 edits it made as **batched blind replacements** → **stay on the
  original commands**. Identical on both sides; they contribute no difference.
- the 4 edits it made **one at a time, after reading** → **move to GEML**.

The GEML side runs live: the script converts `README_CN.md` to GEML, then for
each edit searches for the text that edit landed and reads the block it lands in
— `geml find` then `geml get`, both really executed and charged in full.

## Results

| | all Markdown (what happened) | mixed | ratio |
|---|---:|---:|---:|
| Bytes read | 21,732 | 14,702 | **1.48×** |
| **Saying where (bytes written)** | **2,971** | **424** | **7.01×** |

Where it comes from:

| | n | read | saying where |
|---|---:|---|---|
| batched replacement (left as it was) | 10 | 10,755 → 10,755 | identical |
| **needs an address (moved to GEML)** | **4** | **10,977 → 3,947** | **2,582 → 35** |

**That is the point: those 4 edits are a quarter of the 14, and 51% of
everything the day read.** The edits that must be understood before they can be
made are few and expensive. GEML touches only them, and the day's total falls by
almost a third.

### For contrast: forcing every edit through GEML

**Reading falls to only 1.26× — worse than the mixed run.** Batching is why: one
script shares a single locating step across 10 edits and reads nothing at all,
while GEML pays `find` + `get` per edit and `set` writes one block at a time.

**That is GEML's real gap today**, and it is written up as
[the `geml patch` batch-edit design](https://github.com/geml-spec/geml/blob/main/docs/design/specs/2026-08-07-geml-batch-edit-design.md).
Until it lands, mechanical bulk replacement should keep using the original
commands — which is exactly how this benchmark counts it.

## The one-time cost

Moving a Markdown document to GEML is not free, and the script pays it in the
open: **10 raw `<a id="…"></a>` anchors are folded into heading ids**. The
Chinese README names its sections with HTML tags today because Markdown offers
no other way; in GEML a heading carries its own id. The step is automatic, but
it is real conversion work.

## What this does **not** show

- **Not "GEML is cheaper at everything."** Forcing every edit through it is
  1.26×, worse than the mixed run's 1.48×.
- **One document, 14 replayable edits.** That is the sample replaying real
  history can yield; for a larger controlled sample see the
  [addressing benchmark](addressing-cost.md) (4 documents, 47 edits).
- **It does not measure writing.** Writing a paragraph well means understanding
  its surroundings, and that costs the same either way.
- **1.48× looks weaker than the controlled 2.44×** — because it counts 10 edits
  with zero benefit on its own side. **It is harder to argue with, and closer to
  how the tools are really used.**

## Reproducing it

```sh
git clone https://github.com/geml-spec/geml && cd geml
cd geml-parser && npm install && npm run build && cd ..
node docs/benchmarks/real-session-replay.mjs
node docs/benchmarks/real-session-replay.mjs --json > result.json   # per-edit rows
```

`docs/benchmarks/real-session-edits.json` is the frozen baseline dataset and can
be audited row by row. The GEML side is executed on every run, so the numbers
move when the CLI does.
