# geml-gamemaker

Makes a game from GEML documents, in two parts:

- **Readers** let a `data` block's `src=` address an engine's own files: a
  design document quotes a scene's numbers, `geml check` finds a reference into
  a scene that is not there, and `geml set` changes one value in the scene and
  leaves every other byte alone.
- **The build script** takes a game from its design documents to a release a
  player can download, as the game's own `game.config.geml` describes.

Godot is the one engine so far. What belongs to one engine lives under
`engines/<engine>/`; `src/` knows no engine.

```text
src/build.mjs               the build: config, steps, report, credits, package, self-test
src/zip.mjs                 the release archive
engines/godot/reader.mjs    Godot's text files as GEML values
engines/godot/engine.mjs    Godot for the build: find it, import, probe, export, licenses
engines/godot/licenses.gd   the engine's own license texts, written by the engine
engines/godot/test/         the reader's tests, its acceptance run, Dodge the Creeps
test/build.test.mjs         the build, without an engine
```

## The Godot reader

A `data` block whose `src=` names a `.tscn`, `.tres`, `project.godot` or
`.import` file is read as a value tree:

```geml
=== data {#main src=game/main.tscn}
===

A mob spawns every ![[#main["nodes"]["MobTimer"]["wait_time"]]] seconds.
```

A reader is code, so geml takes it from whoever runs geml — never from a
document (spec §3.2, §9.1):

```sh
geml check design.geml --reader integrations/geml-gamemaker/engines/godot/reader.mjs
geml get   design.geml '#main["nodes"]["MobTimer"]' --reader integrations/geml-gamemaker/engines/godot/reader.mjs
printf 0.3 | geml set design.geml '#main["nodes"]["MobTimer"]["wait_time"]' --in - --reader integrations/geml-gamemaker/engines/godot/reader.mjs
geml mcp --root . --reader integrations/geml-gamemaker/engines/godot/reader.mjs
```

Without `--reader`, the block has no value tree: a `data-format-no-engine`
warning, and the document's coordinates into it are not checked.

### The value tree

A scene (`.tscn`):

| Key | Holds | Example coordinate |
|---|---|---|
| `scene` | the `[gd_scene]` header | `["scene"]["uid"]` |
| `ext` | `[ext_resource]` by id | `["ext"]["1_0r6n5"]["path"]` |
| `sub` | `[sub_resource]` by id | `["sub"]["1"]["point_count"]` |
| `nodes` | `[node]` by path from the root; the root is `"."` | `["nodes"]["MobPath/MobSpawnLocation"]` |
| `connections` | `[connection]` in file order | `["connections"][0]["method"]` |
| `editable` | `[editable]` in file order, when there are any | `["editable"][0]["path"]` |

A resource (`.tres`) has `header` and `resource` in place of `scene` and
`nodes`. A config file (`project.godot`, `.import`, `.cfg`) is its sections by
name, with any key before the first section at the top; a key written with `/`
is one key: `["display"]["window/size/viewport_width"]`.

A node or a sub-resource keeps its header's attributes under `@`-names —
`["nodes"]["MobTimer"]["@type"]`, `["@unique_id"]`, `["@instance"]` — and its
properties under their own: `["nodes"]["MobTimer"]["wait_time"]`. A script may
export a property called `type`, so the two cannot share names.

JSON's scalars, Godot's arrays and its dictionaries become the tree's own.
Everything else Godot writes stays the text it was written as: `Vector2(240,
450)`, `ExtResource("1_0r6n5")`, `&"walk"`, `Array[int]([1, 2])`, `inf`. An
integer past 2^53 stays text as well. A number reads as a number, so `2.0` reads
as `2`; a write puts back exactly the text it is given.

A whole node, sub-resource or connection has an extent of its own, so `geml
get` can hand back one node, and `geml set` can replace one.

### What `geml check` reports

The reader's own diagnostics, each code prefixed `godot-scene/`:

| Code | When |
|---|---|
| `unknown-ext-resource` | `ExtResource("…")` names no `[ext_resource]` |
| `unknown-sub-resource` | `SubResource("…")` names no `[sub_resource]` |
| `connection-node-missing` | a connection's `from` or `to` is not a node |
| `parent-missing` | a node's `parent` is not a node |
| `res-path-missing` | an `[ext_resource]`'s `res://` path is not in the project around the file |

A path inside an instanced scene, and every path in an inherited scene, is
declared by another file, so it is not checked here.

### How it was accepted

Against the official [Godot demo projects](https://github.com/godotengine/godot-demo-projects)
at `b761b4c`: all 1,521 files of the 139 projects (533 scenes and resources,
988 config files) read whole; every one of the 44,130 numbers in them,
rewritten through its extent, reads back as written with nothing else changed;
and the checks report nothing on projects that open in Godot. To run it again
against a directory of projects:

```sh
node engines/godot/test/corpus.mjs <dir>
```

### Not yet

- Scripts are not read: a connection's `method` is not checked against its
  `.gd` file, and a value a script holds (`@export var speed = 400`) has no
  coordinate.
- A coordinate edit only replaces a value that is there. Adding or removing a
  node, a property or a connection is an edit to the file itself.

## Building a release

`src/build.mjs` builds a game into a zip a player can download and stops at the
first step that fails:

```sh
node integrations/geml-gamemaker/src/build.mjs <game-dir> --godot <godot-folder>
```

The game names its engine in its config. Where that engine is on this machine
is given to the build: `--godot` (the unzipped release folder, or the
executable), else `GODOT_BIN`, else `godot` on PATH. Exporting needs that
version's export templates installed. The build checks documents with this
checkout's parser, so build `geml-parser` first.

| Step | What it does |
|---|---|
| engine | finds the engine and asks it for its version |
| documents | `geml check` on the config and the design documents, with the engine's reader |
| import | imports the project headlessly |
| probes | runs each probe and checks what it prints against the config's table; a value written as a reference to a design document is compared with that document's value |
| export | exports the config's preset |
| credits | every image, sound, font and model the project ships must match a row of the credits table; writes `CREDITS.txt`, copies the license files, and has the engine write its own license and third-party notices |
| package | zips the release; the same files make the same bytes |
| self-test | unpacks the zip into a fresh folder and starts the game headless, on a machine that can run it |

Every step goes into `report.geml` beside the release (`--out`, else
`<game-dir>/build`).

`game.config.geml` is read by its blocks' ids:

| Block | Holds |
|---|---|
| `#game-cfg` (data) | `name`, `version`, `engine` (`godot`), `project` (the engine's project folder), `design` (the documents to check) |
| `#probe-checks` (table, optional) | `probe`, `key`, `op` (`=` `!=` `>=` `<=` `>` `<`), `value`: a number, text, or `[[design.geml#coordinate]]` |
| `#release-cfg` (data) | `preset` (an export preset's name), `package` (`{name}` and `{version}` filled in), `licenses` (a name in the release → a file of the game) |
| `#credit-rows` (table) | `what`, `files`, `holder`, `license`, `source`; `files` is comma-separated, `*` and `?` stay in one folder, `**` crosses folders, and a pattern with no `/` is a file name anywhere |

A Godot probe is a script the build runs with `--script` and `--fixed-fps 60` in
the project: it prints one line `PROBE key=value …` and quits.

## Adding an engine

An engine is a folder `engines/<engine>/` with a reader for its files and an
`engine.mjs`, registered in `ENGINES` in `src/build.mjs`. A game then names it
with `engine: <engine>`, and the build takes `--<engine>` for where it is.
`engine.mjs` exports:

| Name | What it is |
|---|---|
| `name`, `label`, `variable` | `godot`, `Godot`, `GODOT_BIN` |
| `readerPath` | the reader the engine's files are checked with |
| `locate(given, env)` | the executable and its version: from `--<engine>`, the variable, then PATH |
| `importProject`, `runProbe`, `preset`, `exportRelease`, `startExported` | the steps that run the engine |
| `writeLicenses`, `creditLines` | the engine's own license texts, and what `CREDITS.txt` says of the engine |
| `assets` | the files an export ships, which the credits table must cover |
| `keepOut` | marks the build folder so the engine does not import it |

## Tests

`npm test` runs the Godot reader's tests and the build's. Both go through geml
itself, so build `geml-parser` first. CI has no engine: the build's tests cover
what runs without one, and the steps that run Godot are checked by building a
real game.

## License

MIT. The test fixtures are Dodge the Creeps from the Godot demo projects, MIT,
copyright KidsCanCode — see `engines/godot/test/fixtures/dodge_the_creeps/LICENSE`.
