# GEML reader for Godot

A format reader that lets a GEML document address Godot's text files. A `data`
block whose `src=` names a `.tscn`, `.tres`, `project.godot` or `.import` file
is read as a value tree: a design document can quote a scene's numbers, `geml
check` finds a reference into a scene that is not there, and `geml set` changes
one value in the scene and leaves every other byte alone.

```geml
=== data {#main src=game/main.tscn}
===

A mob spawns every ![[#main["nodes"]["MobTimer"]["wait_time"]]] seconds.
```

A reader is code, so geml takes it from whoever runs geml — never from a
document (spec §3.2, §9.1):

```sh
geml check design.geml --reader integrations/godot/src/reader.mjs
geml get   design.geml '#main["nodes"]["MobTimer"]' --reader integrations/godot/src/reader.mjs
printf 0.3 | geml set design.geml '#main["nodes"]["MobTimer"]["wait_time"]' --in - --reader integrations/godot/src/reader.mjs
geml mcp --root . --reader integrations/godot/src/reader.mjs
```

Without `--reader`, the block has no value tree: a `data-format-no-engine`
warning, and the document's coordinates into it are not checked.

## The value tree

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

## What `geml check` reports

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

## How it was accepted

Against the official [Godot demo projects](https://github.com/godotengine/godot-demo-projects)
at `b761b4c`: all 1,521 files of the 139 projects (533 scenes and resources,
988 config files) read whole; every one of the 44,130 numbers in them,
rewritten through its extent, reads back as written with nothing else changed;
and the checks report nothing on projects that open in Godot. To run it again
against a directory of projects:

```sh
node test/corpus.mjs <dir>
```

`npm test` runs the unit tests, which read a scene through geml itself (build
`geml-parser` first).

## Not yet

- Scripts are not read: a connection's `method` is not checked against its
  `.gd` file.
- A coordinate edit only replaces a value that is there. Adding or removing a
  node, a property or a connection is an edit to the file itself.

## License

MIT. The test fixtures are Dodge the Creeps from the Godot demo projects, MIT,
copyright KidsCanCode — see `test/fixtures/dodge_the_creeps/LICENSE`.
