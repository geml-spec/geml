# geml-media guide

> **Status** draft · **Declare** `profile = "geml-media/v1"` · **Limits** `geml media build` needs ffmpeg; most messages are in Chinese

## What it does

geml-media writes a video cut as a document. Each file is a `media-asset` block with its hash, each cut is a `media-clip` that points at a span of a file, and subtitles, prompts and lines are `media-text` blocks. For AI-made video it also keeps a log of every generation, so `geml check` can name the shots to remake when an input changes. It calls no generator and is not a video editor.

## Try it

Save this as `hello.geml`. It needs no media files: its one track holds text.

```geml
=== meta
title = "Hello timeline"
profile = "geml-media/v1"
===

==== media {#cut tracks="subtitle:prose"}

=== media-clip {#c1 track=subtitle src=#l1 duration=2}
===

=== media-clip {#c2 track=subtitle src=#l2 duration=3}
===

====

=== media-text {#l1}
Hello.
===

=== media-text {#l2}
This line starts where the first one ends.
===
```

Check it and turn it into a player page:

```bash
geml check hello.geml
geml media export hello.geml --to player -o play.html
```

`check` prints `ok: no diagnostics`. Open `play.html` in a browser and press play: "Hello." shows for two seconds, then the second line until 0:05. Why the second line starts at 0:02 is the time model, §3.2 of the [reference](geml-media-profile.md). `geml hello.geml --to html` does not draw the timeline; use `geml media export`.

## Everyday use

**Bring in a file.** `import` adds a `media-asset` block with the file's `sha256`, and its `duration` if `ffprobe` is on PATH. `library.geml` must already exist and declare the profile.

```bash
geml media import shot.mp4 --into library.geml
```

**Put it on the timeline.** Replace the `media` block in `hello.geml` with this. The first track is now video, and the subtitle is anchored to the shot with `over=` (§3.2 again).

```geml
==== media {#cut tracks="video:video subtitle:prose"}

=== media-clip {#v1 track=video src=library.geml#shot in=0 out=4}
===

=== media-clip {#c1 track=subtitle src=#l1 over=#v1 duration=2}
===

====
```

**Make the MP4.** The subtitles go to `hello.srt` next to it; add `--burn-subs` to burn them into the picture.

```bash
geml media build hello.geml --out hello.mp4
```

An agent can run the whole loop: `geml media todo hello.geml --json` lists prompts with no output and lines with no voice, `geml media log` records what it made in the library's generation log (§6), and after a prompt changes `geml check` names the clips that are now stale (§8).

**More:** [Reference](geml-media-profile.md) · [Demo](https://geml-spec.github.io/demos)
