// The Godot reader: what it reads, where each value lies, what it refuses, the
// references it checks — and the same file read and written through geml.
//
// The fixtures are Dodge the Creeps' text files, from the official Godot demo
// projects (MIT, see fixtures/dodge_the_creeps/LICENSE). Its art, audio and
// scripts are not here, so a test that wants `res://` checked builds a project
// of its own.

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import reader, { GodotReadError, diagnose, parseGodot } from "../src/reader.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "dodge_the_creeps");
const scene = reader.readers.find((r) => r.format === "godot-scene");
const config = reader.readers.find((r) => r.format === "godot-config");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const fixture = (f) => readFileSync(join(fixtures, f), "utf8");
const steps = (at) => at.map((s) => (typeof s === "number" ? `[${s}]` : `[${JSON.stringify(s)}]`)).join("");
const slice = (res, text, at) => {
  const x = res.extents.find((e) => steps(e.at) === at);
  assert.ok(x, `an extent for ${at}`);
  return text.slice(x.start, x.end);
};
const refuses = (text, kind, why) => assert.throws(() => parseGodot(text, kind), (e) => e instanceof GodotReadError && why.test(e.message), String(why));

test("a scene reads into scene, ext, sub, nodes and connections", () => {
  const text = fixture("main.tscn");
  const { value } = scene.read(text, {});
  assert.deepEqual(value.scene, { format: 3, uid: "uid://bggkaprn62fwm" });
  assert.deepEqual(value.ext["1_0r6n5"], { type: "Script", uid: "uid://c4wt6ace7hycd", path: "res://main.gd" });
  assert.equal(value.sub["1"]["@type"], "Curve2D");
  assert.equal(value.sub["1"].point_count, 5);
  assert.deepEqual(value.nodes["."], { "@type": "Node", "@unique_id": 1975992027, script: 'ExtResource("1_0r6n5")', mob_scene: 'ExtResource("2_50pww")' });
  assert.deepEqual(value.nodes.MobTimer, { "@type": "Timer", "@unique_id": 228987391, wait_time: 0.5 });
  assert.equal(value.nodes["MobPath/MobSpawnLocation"]["@type"], "PathFollow2D");
  assert.equal(value.nodes.Player["@instance"], 'ExtResource("3_veqnc")');
  assert.deepEqual(value.connections[0], { signal: "hit", from: "Player", to: ".", method: "game_over" });
  assert.equal(value.connections.length, 5);
});

test("arrays, dictionaries, StringNames and multi-line strings keep their shape", () => {
  const player = scene.read(fixture("player.tscn"), {}).value;
  assert.equal(player.sub["1"].animations[1].name, '&"up"');
  assert.equal(player.sub["1"].animations[0].frames[1].texture, 'ExtResource("3")');
  const hud = scene.read(fixture("hud.tscn"), {}).value;
  assert.equal(hud.nodes.MessageLabel.text, "Dodge the\nCreeps");
  assert.equal(hud.nodes.ScoreLabel["theme_override_font_sizes/font_size"], 60);
  const mob = scene.read(fixture("mob.tscn"), {}).value;
  assert.deepEqual(mob.nodes["."]["@groups"], ["mobs"]);
});

test("a config file reads as its sections; a `/` key is one key", () => {
  const project = config.read(fixture("project.godot"), {}).value;
  assert.equal(project.config_version, 5);
  assert.equal(project.application["config/name"], "Dodge the Creeps");
  assert.equal(project.display["window/size/viewport_width"], 480);
  assert.match(project.input.move_left.events[1], /^Object\(InputEventKey,/);
  const imported = config.read(fixture("art/enemyWalking_1.png.import"), {}).value;
  assert.equal(imported.remap.importer, "texture");
  const presets = parseGodot('[preset.0]\n\nname="Web"\n\n[preset.0.options]\n\n; a comment\n"custom key"=1\n', "config").tree;
  assert.deepEqual(presets, { "preset.0": { name: "Web" }, "preset.0.options": { "custom key": 1 } });
});

test("every value's extent is the text it was read from", () => {
  for (const [f, r] of [["main.tscn", scene], ["player.tscn", scene], ["hud.tscn", scene], ["mob.tscn", scene], ["project.godot", config]]) {
    const text = fixture(f);
    const res = r.read(text, {});
    assert.ok(res.extents.length > 10, f);
    for (const x of res.extents) {
      let v = res.value;
      for (const s of x.at) v = v[s];
      const t = text.slice(x.start, x.end);
      if (typeof v === "number") assert.equal(Number(t), v, `${f} ${steps(x.at)}`);
      else if (typeof v === "boolean") assert.equal(t, String(v), `${f} ${steps(x.at)}`);
      else if (typeof v === "string" && !t.startsWith('"')) assert.equal(t, v, `${f} ${steps(x.at)}`);
      else if (typeof v === "string") assert.equal(JSON.parse(t.replace(/\n/g, "\\n")), v, `${f} ${steps(x.at)}`);
    }
  }
  const text = fixture("main.tscn");
  const res = scene.read(text, {});
  assert.equal(slice(res, text, '["nodes"]["MobTimer"]'), '[node name="MobTimer" type="Timer" parent="." unique_id=228987391]\nwait_time = 0.5', "a whole node is one extent");
  assert.equal(slice(res, text, '["connections"][0]'), '[connection signal="hit" from="Player" to="." method="game_over"]');
});

test("typed collections, odd keys, Godot 3 ids, big integers and specials", () => {
  const t = parseGodot([
    '[gd_scene load_steps=2 format=2]', '',
    '[ext_resource path="res://a.gd" type="Script" id=1]', '',
    '[node name="Root" type="Node"]',
    'script = ExtResource( 1 )',
    'ids = Array[int]([1, 2])',
    'map = Dictionary[String, int]({"a": 1})',
    'libraries = {&"RESET": 1, &"walk": 2, 3: "three", ^"path": 4}',
    'seed = 9007199254740993',
    'limits = [inf, -inf, nan]',
    'name_u = "caf\\u00e9"', '',
  ].join("\n"), "resource").tree;
  assert.equal(t.ext["1"].path, "res://a.gd", "a numeric id is its digits");
  const root = t.nodes["."];
  assert.equal(root.ids, "Array[int]([1, 2])");
  assert.equal(root.map, 'Dictionary[String, int]({"a": 1})');
  // a map has no order (a JS object lists integer-like keys first anyway)
  assert.deepEqual(Object.keys(root.libraries).sort(), ["3", "RESET", '^"path"', "walk"]);
  assert.equal(root.seed, "9007199254740993", "an integer past 2^53 stays text");
  assert.deepEqual(root.limits, ["inf", "-inf", "nan"]);
  assert.equal(root.name_u, "café");
});

test("a node's own `type` property sits beside its header's `@type`", () => {
  const t = parseGodot('[gd_scene format=3]\n\n[node name="Object" type="Node2D"]\ntype = 2\n', "resource").tree;
  assert.deepEqual(t.nodes["."], { "@type": "Node2D", type: 2 });
});

test("CRLF and a BOM read the same tree", () => {
  const text = fixture("main.tscn");
  const lf = parseGodot(text, "resource").tree;
  assert.deepEqual(parseGodot("﻿" + text.replace(/\n/g, "\r\n"), "resource").tree, lf);
});

test("what the reader cannot read whole, it refuses", () => {
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\nx = 1]\n', "resource", /more text after a value/);
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\nx = "never closed\n', "resource", /never closed/);
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\nx = 1\nx = 2\n', "resource", /set twice/);
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\n\n[node name="A" type="Node"]\n', "resource", /a second node at `\.`/);
  refuses('[gd_scene format=3]\n\n[mystery]\n', "resource", /not a section/);
  refuses('[node name="A"]\n', "resource", /begins with \[gd_scene\]/);
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\nx = {1: 2, 1: 3}\n', "resource", /two keys of one dictionary/);
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\nx = whatever\n', "resource", /not a value/);
  refuses('[gd_scene format=3]\n\n[node name="A" type="Node"]\nnot a property\n', "resource", /neither a section nor/);
  refuses('[section\nkey=1\n', "config", /never closed/);
});

test("the four checks: ext and sub ids, connection ends, parents, res:// paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-godot-"));
  try {
    writeFileSync(join(dir, "project.godot"), "config_version=5\n");
    mkdirSync(join(dir, "art"));
    writeFileSync(join(dir, "art", "there.png"), "");
    const file = join(dir, "level.tscn");
    const text = [
      '[gd_scene format=3]', '',
      '[ext_resource type="Texture2D" path="res://art/there.png" id="1"]',
      '[ext_resource type="Texture2D" path="res://art/gone.png" id="2"]',
      '[ext_resource type="PackedScene" path="res://art/there.png" id="3"]', '',
      '[sub_resource type="CircleShape2D" id="s1"]', '',
      '[node name="Level" type="Node2D"]', '',
      '[node name="Sprite" type="Sprite2D" parent="."]',
      'texture = ExtResource("9")',
      'material = SubResource("s9")', '',
      '[node name="Orphan" type="Node" parent="Missing"]', '',
      '[node name="Enemy" parent="." instance=ExtResource("3")]', '',
      '[node name="Hat" type="Sprite2D" parent="Enemy/Body"]', '',
      '[connection signal="hit" from="Sprite" to="Ghost" method="x"]',
      '[connection signal="died" from="Enemy/Body" to="." method="y"]', '',
    ].join("\n");
    const res = scene.read(text, { path: file });
    assert.deepEqual(res.diagnostics.map((d) => `${d.code} ${steps(d.at)}`).sort(), [
      'connection-node-missing ["connections"][0]["to"]',
      'parent-missing ["nodes"]["Missing/Orphan"]',
      'res-path-missing ["ext"]["2"]["path"]',
      'unknown-ext-resource ["nodes"]["Sprite"]["texture"]',
      'unknown-sub-resource ["nodes"]["Sprite"]["material"]',
    ], "a path inside an instanced scene is not this file's to check");
    const inherited = scene.read('[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://art/there.png" id="1"]\n\n[node name="Level" instance=ExtResource("1")]\n\n[connection signal="a" from="Anything" to="." method="b"]\n', { path: file });
    assert.deepEqual(inherited.diagnostics, [], "an inherited scene's base declares the rest");
    assert.deepEqual(scene.read(text, {}).diagnostics.filter((d) => d.code === "res-path-missing"), [], "no project around the file, no res:// check");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a string of unclosed ExtResource( takes linear time to check", () => {
  const junk = "ExtResource(!".repeat(50_000) + 'ExtResource("9")';
  const started = performance.now();
  const found = diagnose({ ext: {}, nodes: { ".": { note: junk } } }, new Set(), undefined);
  assert.ok(performance.now() - started < 2000, "quadratic backtracking would take minutes");
  assert.deepEqual(found.map((d) => d.code), ["unknown-ext-resource"]);
});

// Through geml itself: the reader handed to a run, a document addressing the
// scene, and a coordinate edit landing in the scene file.
const geml = resolve(here, "..", "..", "..", "geml-parser", "dist");
const { parse } = await import(pathToFileURL(join(geml, "geml.js")).href);
const { set } = await import(pathToFileURL(join(geml, "verbs.js")).href);

test("through geml: the document's coordinates resolve, and a write lands in the scene", () => {
  const doc = '=== data {#main src=fixtures/dodge_the_creeps/main.tscn}\n===\n\nEvery ![[#main["nodes"]["MobTimer"]["wait_time"]]] seconds; [[#main["nodes"]["MobTimer"]["@type"]]].\n';
  const opts = {
    resolveDoc: (p) => readFileSync(join(here, p), "utf8"),
    docExists: () => true,
    sourcePath: (p) => join(here, p),
    readers: reader.readers,
  };
  const parsed = parse(doc, opts);
  assert.deepEqual(parsed.diagnostics.filter((d) => d.code !== "res-path-missing" && !d.code.endsWith("/res-path-missing")), [], JSON.stringify(parsed.diagnostics));
  const typo = parse(doc.replace('["MobTimer"]["wait_time"]', '["MobTimers"]["wait_time"]'), opts);
  assert.ok(typo.diagnostics.some((d) => d.code === "unresolved-reference" && /MobTimers/.test(d.message)));
  const before = fixture("main.tscn");
  const r = set(doc, "d.geml", '#main["nodes"]["MobTimer"]["wait_time"]', { part: "whole", named: [], content: { kind: "raw", text: "0.3" } }, { docOpts: () => opts, note: () => {} });
  assert.equal(r.text, doc, "the document is untouched");
  assert.equal(r.external.text, before.replace("wait_time = 0.5", "wait_time = 0.3"));
});

console.log(`godot reader: ${passed} passed`);
