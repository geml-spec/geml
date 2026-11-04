// The build script without an engine: what it reads from game.config.geml,
// where it looks for Godot, how it reads a probe, which assets need a credit,
// the zip it packs, and the report it writes even when it stops. The steps that
// run Godot are exercised by building a real game; CI has no engine to run.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BuildError, STEPS, build, compare, creditsText, globMatch, parseProbe, readConfig, reportText, uncredited,
} from "../src/build.mjs";
import { readZip, writeZip } from "../src/zip.mjs";
import * as godot from "../engines/godot/engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Dodge the Creeps' text files, as the Godot reader's tests keep them.
const fixtures = resolve(here, "..", "engines", "godot", "test", "fixtures", "dodge_the_creeps");
const { parse } = await import(pathToFileURL(resolve(here, "..", "..", "..", "geml-parser", "dist", "geml.js")).href);

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

const tmp = mkdtempSync(join(tmpdir(), "geml-godot-build-"));
const file = (path, text = "") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
const flatten = (blocks) => blocks.flatMap((b) => [b, ...flatten(b.children ?? [])]);

const CONFIG = [
  "=== meta",
  'title = "dodge"',
  "===",
  "",
  "=== data {#game-cfg format=yaml}",
  "name: dodge",
  "version: 1.0.0",
  "engine: godot",
  "project: dodge_the_creeps",
  "design:",
  "  - dodge.geml",
  "===",
  "",
  "=== table {#probe-checks}",
  "| probe | key | op | value |",
  "|---|---|---|---|",
  '| probes/spawn.gd | mob_wait_time | = | [[dodge.geml#main["nodes"]["MobTimer"]["wait_time"]]] |',
  "| probes/spawn.gd | mobs_spawned | >= | 20 |",
  "===",
  "",
  "=== data {#release-cfg format=yaml}",
  "preset: Windows Desktop",
  'package: "{name}-{version}-windows-x86_64"',
  "licenses:",
  "  GAME-LICENSE.txt: dodge_the_creeps/LICENSE",
  "===",
  "",
  "=== table {#credit-rows}",
  "| what | files | holder | license | source |",
  "|---|---|---|---|---|",
  "| Game code | *.gd, *.tscn | KidsCanCode, 2017 | MIT | https://github.com/godotengine/godot-demo-projects |",
  "| Music | art/House In a Forest Loop.ogg | HorrorPen, 2012 | CC-BY 3.0 | https://opengameart.org/content/loop-house-in-a-forest |",
  "===",
  "",
].join("\n");

// A game folder: the fixture project, its design document and its config.
function game(name, config = CONFIG) {
  const dir = join(tmp, name);
  cpSync(fixtures, join(dir, "dodge_the_creeps"), { recursive: true });
  file(join(dir, "dodge.geml"), '=== meta\ntitle = "d"\n===\n\nEvery ![[#main["nodes"]["MobTimer"]["wait_time"]]] s.\n\n=== data {#main src=dodge_the_creeps/main.tscn}\n===\n');
  file(join(dir, "game.config.geml"), config);
  return dir;
}

try {
  await test("a zip reads back as written, the same files make the same bytes, and a damaged one says so", () => {
    const entries = [
      { name: "pkg/CREDITS.txt", data: Buffer.from("credits\n") },
      { name: "pkg/空 文件.txt", data: Buffer.alloc(0) },
      { name: "pkg/game", data: randomBytes(70_000), mode: 0o755 },
    ];
    const zip = writeZip(entries);
    assert.deepEqual(zip, writeZip(entries), "no clock in the archive");
    const back = readZip(zip);
    assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
    for (const [i, e] of back.entries()) assert.ok(e.data.equals(entries[i].data), e.name);
    assert.deepEqual(back.map((e) => e.mode), [0o644, 0o644, 0o755]);
    // A byte of the first entry's packed data: past its 30-byte header and its name.
    const damaged = Buffer.from(zip);
    damaged[30 + Buffer.byteLength(entries[0].name) + 1] ^= 0xff;
    assert.throws(() => readZip(damaged));
    assert.throws(() => readZip(Buffer.from("not a zip at all, not even close to one")), /not a zip/);
  });

  await test("an engine folder offers its console build first; any other path is itself", () => {
    const dir = join(tmp, "engine");
    for (const n of ["Godot_v4.7.2-stable_win64.exe", "Godot_v4.7.2-stable_win64_console.exe", "Godot_v4.7.2-stable_linux.x86_64",
      "Godot_v4.7.2-stable_win64.exe.zip", "SHA512-SUMS.txt", "_sc_"]) file(join(dir, n));
    mkdirSync(join(dir, "editor_data"), { recursive: true });
    assert.deepEqual(godot.candidates(dir).map((p) => basename(p)),
      ["Godot_v4.7.2-stable_win64_console.exe", "Godot_v4.7.2-stable_win64.exe", "Godot_v4.7.2-stable_linux.x86_64"]);
    assert.deepEqual(godot.candidates(join(dir, "Godot_v4.7.2-stable_win64.exe")), [join(dir, "Godot_v4.7.2-stable_win64.exe")]);
  });

  await test("no Godot at --godot, GODOT_BIN or on PATH is an error that names all three", () => {
    const empty = join(tmp, "empty-path");
    mkdirSync(empty, { recursive: true });
    assert.throws(
      () => godot.locate(join(tmp, "no-godot"), { PATH: empty, GODOT_BIN: join(tmp, "no-godot-either") }),
      (e) => e instanceof BuildError && /--godot/.test(e.message) && /GODOT_BIN/.test(e.message) && /PATH/.test(e.message),
    );
  });

  await test("a probe's last PROBE line is read, and compared as numbers when both sides are", () => {
    assert.deepEqual(parseProbe("Godot Engine v4.7.2\nPROBE a=1 b=x\nPROBE mob_wait_time=0.3 mobs_spawned=26 score=<null>\nERROR: 2 resources still in use"),
      { mob_wait_time: "0.3", mobs_spawned: "26", score: "<null>" });
    assert.equal(parseProbe("nothing here"), null);
    assert.equal(compare("0.30", "=", "0.3"), true);
    assert.equal(compare("26", ">=", "20"), true);
    assert.equal(compare("15", ">=", "20"), false);
    assert.equal(compare("2", "!=", "2.0"), false);
    assert.equal(compare("walk", "=", "walk"), true);
    assert.equal(compare("walk", ">", "run"), false, "text is only equal or not");
  });

  await test("assets are listed as an export ships them, and each needs a credit row", () => {
    const project = join(tmp, "assets");
    for (const p of ["art/a.png", "art/House In a Forest Loop.ogg", "art/gameover.wav", "fonts/X.ttf", "icon.webp", "main.gd",
      "screenshots/.gdignore", "screenshots/shot.png", ".godot/imported/a.png", "build/stray.png"]) file(join(project, ...p.split("/")));
    const assets = godot.assets(project, [join(project, "build")]);
    assert.deepEqual(assets, ["art/House In a Forest Loop.ogg", "art/a.png", "art/gameover.wav", "fonts/X.ttf", "icon.webp"]);
    const rows = [{ files: ["art/*.png"] }, { files: ["art/House In a Forest Loop.ogg"] }, { files: ["*.ttf"] }];
    assert.deepEqual(uncredited(assets, rows), ["art/gameover.wav", "icon.webp"]);
    assert.equal(globMatch("*.png", "art/a.png"), true, "a pattern with no folder is a file name anywhere");
    assert.equal(globMatch("art/*.png", "art/deep/a.png"), false, "`*` stays in its folder");
    assert.equal(globMatch("art/**.png", "art/deep/a.png"), true, "`**` crosses folders");
    assert.equal(globMatch("a?.png", "ab.png"), true);
    assert.equal(globMatch("*.png", "a.png.import"), false);
  });

  await test("a game's config is read by its blocks' ids; what it lacks is said", async () => {
    const dir = game("config");
    const c = await readConfig(dir);
    assert.equal(c.name, "dodge");
    assert.equal(c.project, join(dir, "dodge_the_creeps"));
    assert.deepEqual(c.design, ["dodge.geml"]);
    assert.equal(c.packageName, "dodge-1.0.0-windows-x86_64");
    assert.deepEqual(c.licenses, { "GAME-LICENSE.txt": "dodge_the_creeps/LICENSE" });
    assert.deepEqual(c.probes[0].value.ref, { doc: "dodge.geml", anchor: 'main["nodes"]["MobTimer"]["wait_time"]' }, "a reference keeps where it points");
    assert.equal(c.probes[1].value.ref, undefined);
    assert.deepEqual(c.credits.map((r) => r.files), [["*.gd", "*.tscn"], ["art/House In a Forest Loop.ogg"]]);

    const refuses = async (config, why) => assert.rejects(readConfig(game(`bad-${Math.random()}`, config)), (e) => e instanceof BuildError && why.test(e.message));
    await refuses(CONFIG.replace("| mobs_spawned | >= |", "| mobs_spawned | ~ |"), /`~` is not one of/);
    await refuses(CONFIG.replace("{#credit-rows}", "{#credits-elsewhere}"), /no `#credit-rows`/);
    await refuses(CONFIG.replace("version: 1.0.0\n", ""), /needs a `version`/);
    await refuses(CONFIG.replace("engine: godot", "engine: unity"), /no engine `unity` here \(there is `godot`\)/);
    await assert.rejects(readConfig(join(tmp, "nowhere")), /no game\.config\.geml/);
  });

  await test("a build with no engine stops at the engine, and still writes a report that checks", async () => {
    const dir = game("no-engine");
    const empty = join(tmp, "empty-path-2");
    mkdirSync(empty, { recursive: true });
    const out = join(tmp, "no-engine-out");
    const r = await build(dir, { godot: join(tmp, "no-godot"), out, env: { PATH: empty } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.steps.map((s) => `${s.name}:${s.result}`), STEPS.map(([n], i) => `${n}:${i === 0 ? "failed" : "skipped"}`));
    assert.ok(existsSync(join(out, ".gdignore")), "a build folder is never imported as part of a project");
    assert.ok(!existsSync(join(out, "dodge-1.0.0-windows-x86_64.zip")));
    const doc = parse(readFileSync(r.report, "utf8"));
    assert.deepEqual(doc.diagnostics.filter((d) => d.severity === "error"), []);
    const rows = flatten(doc.children).find((b) => b.id === "stage-rows").table.rows;
    assert.deepEqual(rows.map((row) => row[1].text), ["失败", "未跑", "未跑", "未跑", "未跑", "未跑", "未跑", "未跑"]);
    assert.match(rows[0][3].text, /GODOT_BIN/);
  });

  await test("a report keeps what a note says, a `|` included", () => {
    const config = { name: "g", version: "1", packageName: "g-1" };
    const steps = STEPS.map(([name], i) => ({ name, result: i === 0 ? "failed" : "skipped", seconds: i === 0 ? 0.25 : undefined, note: i === 0 ? "a | b `c`" : undefined }));
    const doc = parse(reportText(config, steps, {}, { built: "2026-11-04T00:00:00Z" }));
    assert.deepEqual(doc.diagnostics.filter((d) => d.severity === "error"), []);
    const row = flatten(doc.children).find((b) => b.id === "stage-rows").table.rows[0];
    assert.equal(row[3].text, "a | b `c`");
    assert.equal(row[2].text, "0.3 s");
  });

  await test("CREDITS.txt says each row, the engine, and the license texts it ships", async () => {
    const c = await readConfig(game("credits"));
    const text = creditsText(c, godot.creditLines("4.7.2.stable.official.ed1daf0bf"), ["GAME-LICENSE.txt", "GODOT-LICENSE.txt"]);
    assert.match(text, /^dodge 1\.0\.0\n/);
    assert.match(text, /Music\n {2}HorrorPen, 2012\. CC-BY 3\.0\.\n {2}Files: art\/House In a Forest Loop\.ogg\n {2}Source: https:\/\/opengameart\.org/);
    assert.match(text, /Godot Engine 4\.7\.2\.stable\.official\.ed1daf0bf\. MIT License: licenses\/GODOT-LICENSE\.txt/);
    assert.match(text, /License texts\n {2}licenses\/GAME-LICENSE\.txt\n {2}licenses\/GODOT-LICENSE\.txt\n/);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`gamemaker build: ${passed} passed`);
