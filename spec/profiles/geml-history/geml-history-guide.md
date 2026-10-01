# geml-history guide

> **Status** stable · **Declare** `profile = "geml-history/v1"` in the `.gemlhistory` file's `=== meta` (`geml history save` writes it) · **Limits** linear history: no branches, no merges

## What it does

It keeps a document's past versions in a plain-text file beside it: `notes.geml` gets `notes.gemlhistory`.
You can read any old version, put one block back, or roll the whole file back, without git or a server.

## Try it

You need the CLI: `npm i -g @geml/geml` (Node 22+). Take any `.geml` file. This guide uses `notes.geml`:

```geml
# Notes

## Plan {#plan}

Launch on Friday.

## Budget {#budget}

Budget is 10k.
```

Save a revision. Change `10k` to `25k` in your editor. Save again, then list the revisions:

```console
$ geml history save notes.geml -m "first draft"
saved 20261001T035415Z-16b4ba53
$ geml history save notes.geml -m "raise budget"
saved 20261001T035416Z-983b5b04
$ geml history get notes.geml
0       20261001T035416Z-983b5b04  -  raise budget
-1      20261001T035415Z-16b4ba53  -  first draft
```

The first column is what the other commands take: `0` is the latest save, `-1` the one before it.
Saving an unchanged file adds nothing.

## Everyday use

Print an old revision in full:

```sh
geml history get notes.geml -1
```

Undo one block. The rest of the file stays as it is, and nothing is saved until you run `geml history save`:

```console
$ geml revert notes.geml '#budget'
reverted #budget to 20261001T035415Z-16b4ba53
```

That goes back one revision. `--rev changed` goes back to the block's own previous version instead,
even if other blocks were saved since; use it after an agent's edit.

Roll the whole file back. Every newer revision is deleted (§7 of the reference).
If the file has unsaved changes it refuses: save first, or add `--force` to throw them away.

```sh
geml history restore notes.geml -1
```

Agents get the same through `geml mcp`: each write saves a revision first, so `geml_revert` can undo a single block.
Leave `.gemlhistory` to the tool; §10 of the reference says why.

**More:** [Reference](geml-history-profile.md) · [Illustrated](https://geml-spec.github.io/illustrated/08-profile-history.html)
