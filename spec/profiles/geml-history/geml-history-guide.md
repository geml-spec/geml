# geml-history guide

> **Status** stable · **Declare** `profile = "geml-history/v1"` in the `.gemlhistory` file's `=== meta` (`geml history save` writes it) · **Limits** where two copies changed the same block, the later change wins (the other stays in the history)

## What it does

It keeps a document's past versions in a plain-text file beside it: `notes.geml` gets `notes.gemlhistory`.
You can read any old version, put one block back, roll the whole file back, and merge two copies
of the history that were edited apart — without git or a server.

## Try it

You need the CLI: `npm i -g @geml/geml` (Node 22+). Take any `.geml` file. This guide uses `notes.geml`:

```geml
# Notes

## Plan {#plan}

Launch on Friday.

## Budget {#budget}

Budget is 10k.
```

Save a version. Change `10k` to `25k` in your editor. Save again, then list them:

```console
$ geml history save notes.geml -m "first draft"
saved 20261009T035415Z-16b4ba53c0e1
$ geml history save notes.geml -m "raise budget"
saved 20261009T035416Z-983b5b04a7d2
$ geml history get notes.geml
0       20261009T035416Z-983b5b04a7d2  -  raise budget
-1      20261009T035415Z-16b4ba53c0e1  -  first draft
```

The first column is what the other commands take: `0` is the latest, `-1` the one before it.
Saving an unchanged file adds nothing.

## Everyday use

Print an old version in full:

```sh
geml history get notes.geml -1
```

Undo one block. The rest of the file stays as it is:

```console
$ geml revert notes.geml '#budget'
reverted #budget to 20261009T035415Z-16b4ba53c0e1
```

That goes back one version. `--rev changed` goes back to the block's own previous version instead,
even if other blocks were saved since; use it after an agent's edit.

Roll the whole file back. Nothing is deleted: the old version is written to the file and saved as a
new version. If the file has unsaved changes it refuses: save first, or add `--force` to throw them away.

```sh
geml history restore notes.geml -1
```

## Two copies, one history

Edit `notes.geml` on two machines, or let two agents work on copies. Each saves as usual. Then merge
one history into the other:

```console
$ geml history merge notes.geml ../other-copy/notes.gemlhistory
warning: concurrent edits to ~63cb8ebe: kept 20261009T082557Z-cad9d3dc2aa0, superseded 20261009T082557Z-84496656b625
merged 1 change(s); joined the heads as 20261009T082558Z-464374011f63
```

Edits to different blocks both survive. Where both copies changed the same block, the later edit wins
and the merge names the version that lost. It is still in the history: `geml history get notes.geml 84496656b625`
prints it, and for a block with an `#id`, `geml revert notes.geml '#id' --rev 84496656b625` puts it back.
(`~63cb8ebe` is the key the tool gave a paragraph without an id.)

In a git repository, run `geml history setup-git` once per clone: git then merges `.gemlhistory` files
this way on its own, and the next save records whatever git made of the `.geml`.

Agents get the same through `geml mcp`: each write saves a version first, so `geml_revert` can undo a single block.
Leave `.gemlhistory` to the tool; §14 of the reference says why.

**More:** [Reference](geml-history-profile.md) · [Illustrated](https://geml-spec.github.io/illustrated/08-profile-history.html)
