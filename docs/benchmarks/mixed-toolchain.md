# A real day of editing: the mixed-toolchain benchmark

> **The headline: giving each of the day's 14 edits to the GEML verb built for
> it cut the reading by 3.65× and the bytes spent saying WHERE by 7×.**
>
> The 4 that had to be understood before they could be made went to `find` +
> `get`, and they accounted for half the day's reading. The 10 whose old text
> was already known went to `replace`, which reads nothing at all. **Not one of
> them had to leave GEML.**

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

- the 4 edits it made **one at a time, after reading** → `geml find` +
  `geml get`: locate by content, read exactly that block.
- the 10 edits it made as **batched replacements** → `geml replace`, which
  needs no read at all.

**The second route is new**, and it is why these figures differ from earlier
runs. The rule used to leave batched edits on the original commands because GEML
had no verb for "the old text is already known"; `geml replace` is that verb, so
the exception it was written for is gone.

It also punctures an assumption the old rule carried. "Blind replacement reads
nothing" is not what the recorded day shows: of the nineteen batched edits,
exactly one read nothing. The rest read a window first — the same window several
times over, amortised across the swaps in one script — and that amortised read
is precisely what `replace` removes.

The GEML side runs live: the script converts `README_CN.md` to GEML, then for
each edit searches for the text that edit landed and reads the block it lands in
— `geml find` then `geml get`, both really executed and charged in full.

## Results

| | all Markdown (what happened) | mixed | ratio |
|---|---:|---:|---:|
| Bytes read | 21,732 | 5,953 | **3.65×** |
| **Saying where (bytes written)** | **2,971** | **424** | **7.01×** |

Where it comes from:

| | n | read | saying where |
|---|---:|---|---|
| batched replacement (via `replace`) | 10 | **10,755 → 1,230** | the old text is written either way |
| **needs an address (`find` + `get`)** | **4** | **10,977 → 4,723** | **2,582 → 35** |

**That is the point: those 4 edits are a quarter of the 14, and 51% of
everything the day read.** The edits that must be understood before they can be
made are few and expensive. GEML touches only them, and the day's total falls by
almost a third.

### For contrast: what this looked like before `replace`

The same edits came to **1.40×** when GEML had no `replace`, because the batched
ten had to leave it and the 10,755 bytes they read on the original commands
counted in full.

**The distance from 1.40× to 3.65× is what one verb was worth.** It did not make
GEML better at swapping strings — `sed` was always good at that. It meant those
ten edits no longer had to leave, and leaving costs more than bytes: a write made
outside is not re-parsed, not reported, not in the history, and nothing catches
it when it breaks something.

## The one-time cost

Moving a Markdown document to GEML is not free, and the script pays it in the
open: **10 raw `<a id="…"></a>` anchors are folded into heading ids**. The
Chinese README names its sections with HTML tags today because Markdown offers
no other way; in GEML a heading carries its own id. The step is automatic, but
it is real conversion work.

## What this does **not** show

- **Not "GEML is cheaper at everything."** What it saves is READING. `replace`
  says where with the old text exactly as the script did, so that column costs
  the same on both sides — the 7.01× comes entirely from the other 4 edits.
- **One document, 14 replayable edits.** That is the sample replaying real
  history can yield; for a larger controlled sample see the
  [addressing benchmark](addressing-cost.md) (4 documents, 47 edits).
- **It does not measure writing.** Writing a paragraph well means understanding
  its surroundings, and that costs the same either way.
- **The figures move with the corpus.** This reads the real `README_CN.md` in
  this repository, so editing it changes them; run it yourself before quoting a
  precise value.

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
