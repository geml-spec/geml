# What one edit costs: the addressing benchmark

> **The headline: saying WHERE a change goes costs 21× more in Markdown.**
>
> Same documents, same 47 edits. Pointing at a place in Markdown means quoting
> the text back — 13,109 bytes. In GEML it means writing an address — 611 bytes.
> The replacement content is identical in both and is excluded from that figure,
> so the whole **21.45×** is what the format charges to say where.

This is not a number quoted from a one-off measurement. One command reproduces it:

```sh
node docs/benchmarks/addressing-cost.mjs
```

## Why measure this

Most of a document's life is spent being changed, and every change has two
parts: **finding the place**, then **saying that this is the place**. A person
does the first with their eyes and a scrollbar, and it costs nothing anyone
counts. When the editor is a program — an editor plugin, a CI script, a language
model agent — both parts are paid for: what it reads costs, what it writes
costs, and what it writes costs more.

Markdown has no stable name for a part of a document. To point at a paragraph
you quote it, and you keep quoting until the quote is unique in the file. In
GEML every block has an address, and pointing at one means writing that address.

This benchmark measures that difference.

## Method

**The design was fixed before the first run**; the script's header comment is
the original.

| | |
|---|---|
| **Corpus** | Four documents that exist in this repository in **both formats**: the specification and the history specification, English and Chinese, 16.8 KB to 70.6 KB. Same content, same heading count. Arm A edits the Markdown, arm B the GEML, so neither arm gets the easier document |
| **Sampling** | Mechanical: every Nth addressable block, about twelve per document, **nothing hand-picked**. The only exclusion is the document-level H1 — its "block" is the whole file, and nobody edits a document as a single operation |
| **The job** | "Replace the content of block B." The editor knows **what** to change, not **where** it is, so both arms must find it first. The search phrase comes from one rule — B's first line of twelve characters or more — and **both arms search for the same phrase** |
| **Arm A (Markdown)** | `grep -n` to locate → `sed -n '<hit>,+45p'` for a 46-line window → (a second read when the block does not fit) → write a unique `old_string`, then the new content |
| **Arm B (GEML)** | `geml find` to locate and get back an address → `geml get <address>` to read exactly that block → write the address, then the new content |

The new content is identical in both arms, so it is **left out** of the "saying
where" figure. What remains is each format's charge for pointing at a place.

**Two choices deliberately favour arm A**, so the result is a floor rather than
a flattering case:

- the window is 46 lines — the **median** window an agent was measured using on
  real work, not a large safe one;
- `old_string` is the **shortest unique leading slice** of the block, which is
  the cheapest exact-string edit that still applies correctly.

## Results

47 edits across 4 documents:

| | Markdown | GEML | ratio |
|---|---:|---:|---:|
| **Saying where (bytes written)** | **13,109** | **611** | **21.45×** |
| Bytes read | 107,861 | 44,155 | 2.44× |
| Median read per edit | 2,124 | 565 | 3.76× |
| Round trips | 103 | 94 | 1.10× |

- **GEML costs more on 0 of 47 edits.** Not one exception.
- **The 46-line window did not contain the block on 9 of 47 (19%).** Markdown
  then needs a second read — and how big to make the window was a guess in the
  first place: too small misses content, too large reads it for nothing.
- Per-edit read ratio: min 1.41× · median 3.10× · max 18.12×.

Each document computed on its own, so the result is not carried by one of them:

| document | n | read | saying where |
|---|---:|---:|---:|
| GEML-spec_CN.md | 12 | 2.13× | 10.7× |
| GEML-spec.md | 11 | 2.91× | 11.0× |
| GEML-history-spec_CN.md | 12 | 2.41× | 25.6× |
| GEML-history-spec.md | 12 | 2.30× | 32.7× |

### A corroboration

Arm A's median read per edit is **2,124 bytes**. A completely separate
measurement — counting, line by line, an agent's session log from a full day of
real document editing — came to **2,133 bytes**. Different corpus, different
method, within **0.4%**. The procedure above reproduces real behaviour rather
than a model built to look good.

## What this does **not** show

- **Round trips barely move** (1.10×). `find` + `get` is two calls; `grep` +
  `sed` is two calls. GEML saves what each call carries, not how many there are.
- **Smaller blocks widen the gap.** These documents are specifications, so their
  blocks are large. Documents with smaller blocks read better than this; a few
  very large blocks read worse. The median (3.10×) describes a typical edit
  better than the total (2.44×).
- **It does not measure writing.** Writing a paragraph well means understanding
  its surroundings, and that cost is the same in both formats. This measures
  finding the paragraph and pointing at it.
- **Four documents, 47 edits**, all from this repository. More corpus would make
  it firmer; the script takes a different corpus without modification.

## Why the gap is widest on "saying where"

Because that is where the two formats do genuinely different things.

Markdown offers no alternative: for a replacement to land in the right place,
the quoted text must be long enough to be unique — a short quote collides with
the same wording elsewhere and the edit lands in the wrong paragraph. The longer
the document and the more its phrasing repeats, the longer the quote must be.

In GEML that step is an address: `#3-blocks`, or `=== table@412f8f61`. An
address does not grow with the content, or with the document.

And this is the part paid in bytes **written** — which, for anything billed by
token, is the expensive direction.

## Reproducing it

```sh
git clone https://github.com/geml-spec/geml && cd geml
cd geml-parser && npm install && npm run build && cd ..
node docs/benchmarks/addressing-cost.mjs
node docs/benchmarks/addressing-cost.mjs --json > result.json   # per-edit rows
```

The figures here are from geml-spec `0c6be2c`. Both arms run for real against
the four documents in the repository, so re-running after a change to the spec
or the CLI moves the last digit — `107,889 → 107,861` is one spec revision's 28
bytes. Neither the order of magnitude nor the conclusion moves with it; quote a
figure only after running it yourself.

The script, the corpus and the sampling rule are all in the repository. To run
it against your own documents, change `PAIRS` at the top: it needs the same
content as both Markdown and GEML, and `geml <file.md> --from md --to geml`
produces the second.
