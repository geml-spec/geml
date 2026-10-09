// The sync engine end to end against the fake Anytype API: a temp vault, real
// files, real change graphs, real git.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { verify, listRevisions } from "@geml/geml/dist/history.js";
import { parse } from "@geml/geml";
import { syncOnce } from "../core/src/engine.mjs";
import { anytypeAdapter } from "../adapters/anytype/index.mjs";
import { fakeAnytype } from "./fake-anytype.mjs";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

async function setup({ git: withGit = false } = {}) {
  const fake = fakeAnytype();
  const url = await fake.start();
  const vault = mkdtempSync(join(tmpdir(), "las-vault-"));
  if (withGit) {
    git(vault, "init", "-q");
    git(vault, "config", "user.name", "Test");
    git(vault, "config", "user.email", "test@example.com");
  }
  const adapter = anytypeAdapter({ baseUrl: url, apiKey: fake.apiKey, space: fake.space });
  let tick = 0;
  // Vault edits stamped before anything the fake does, unless a test says otherwise.
  const cycle = (o = {}) => syncOnce({ vault, adapter, author: "me", now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)), ...o });
  const done = async () => { await fake.stop(); rmSync(vault, { recursive: true, force: true }); };
  return { fake, vault, adapter, cycle, done, page: (rel) => join(vault, rel) };
}

const PHOENIX = {
  type: "Page",
  properties: { Name: "Project Phoenix" },
  blocks: [
    { type: "heading_2", text: "Goals" },
    { type: "paragraph", text: "Ship the export." },
    { type: "bulleted_list_item", text: "Flat schema" },
    { type: "checkbox", text: "Draft spec" },
  ],
};

await test("first cycle: every app object becomes a page with a verified history, an index and a commit", async () => {
  const t = await setup({ git: true });
  const a = t.fake.add(PHOENIX);
  t.fake.add({ type: "Page", properties: { Name: "Notes" }, blocks: [{ type: "paragraph", text: "Hello." }] });
  const r = await t.cycle();
  assert.deepEqual(r.created.sort(), ["pages/notes.geml", "pages/project-phoenix.geml"]);
  const text = read(t.page("pages/project-phoenix.geml"));
  assert.match(text, /^# Project Phoenix$/m);
  const blockIds = t.fake.doc(a).blocks.map((b) => b.id);
  for (const id of blockIds) assert.match(text, new RegExp(`#${id}\\b`), "every block addressable by its Anytype id");
  assert.deepEqual(parse(text).diagnostics.filter((d) => d.severity !== "info"), []);
  assert.equal(verify(t.page("pages/project-phoenix.gemlhistory"), t.page("pages/project-phoenix.geml")).ok, true);
  assert.match(read(t.page("space.geml")), /pages\/project-phoenix\.geml,/);
  assert.match(read(t.page(".gitignore")), /\.geml-sync\.json/);
  assert.equal(r.git?.committed, true, JSON.stringify(r.git));
  assert.equal(git(t.vault, "status", "--porcelain").stdout.trim(), "", "everything the cycle wrote is committed; state stays out");
  await t.done();
});

await test("a quiet second cycle reads nothing new and writes nothing", async () => {
  const t = await setup();
  t.fake.add(PHOENIX);
  await t.cycle();
  const r = await t.cycle();
  assert.deepEqual([r.pulled, r.pushed, r.written], [[], [], []]);
  await t.done();
});

await test("a vault edit to one block reaches the app as an update of that block", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f).replace("Ship the export.", "Ship the export by Q3."));
  t.fake.log.length = 0;
  const r = await t.cycle();
  assert.deepEqual(r.pushed, ["pages/project-phoenix.geml"]);
  assert.equal(t.fake.doc(a).blocks[1].text, "Ship the export by Q3.");
  assert.equal(t.fake.log.filter((l) => l.startsWith("PATCH")).length, 1);
  assert.equal(verify(t.page("pages/project-phoenix.gemlhistory"), f).ok, true);
  await t.done();
});

await test("an app edit reaches the vault", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  t.fake.edit(a, (d) => { d.blocks[3].checked = true; });
  const r = await t.cycle();
  assert.deepEqual(r.pulled, ["pages/project-phoenix.geml"]);
  assert.match(read(t.page("pages/project-phoenix.geml")), /- \[x\] Draft spec/);
  assert.deepEqual(r.pushed, [], "nothing to send back");
  await t.done();
});

await test("both sides edit different blocks: both edits survive, nothing reported", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f).replace("Flat schema", "Flat schema, validated"));
  t.fake.edit(a, (d) => { d.blocks[1].text = "Ship the export — from the phone."; });
  const r = await t.cycle();
  const doc = t.fake.doc(a);
  assert.equal(doc.blocks[1].text, "Ship the export — from the phone.");
  assert.equal(doc.blocks[2].text, "Flat schema, validated");
  assert.match(read(f), /from the phone/);
  assert.match(read(f), /validated/);
  assert.deepEqual(r.lost, []);
  assert.equal(verify(t.page("pages/project-phoenix.gemlhistory"), f).ok, true);
  await t.done();
});

await test("both sides edit the same block: the later edit wins everywhere, the other is reported", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f).replace("Ship the export.", "Ship it (vault)."));
  t.fake.edit(a, (d) => { d.blocks[1].text = "Ship it (phone)."; });   // the fake's clock is later than the vault's
  const r = await t.cycle();
  assert.equal(t.fake.doc(a).blocks[1].text, "Ship it (phone).");
  assert.match(read(f), /Ship it \(phone\)\./);
  assert.equal(r.lost.length, 1);
  assert.match(r.lost[0], /concurrent edits to #\S+: kept \S+ \(anytype\), superseded \S+ \(me\)/);
  const losing = listRevisions(t.page("pages/project-phoenix.gemlhistory")).find((x) => x.author === "me" && x.summary === "edited in the vault");
  assert.ok(losing, "the losing edit is in the history");
  await t.done();
});

await test("blocks the vault adds get Anytype ids; a block the vault named keeps its name", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f) + "\nA paragraph an agent added.\n\n=== note {#decision}\nWe ship on Friday.\n===\n");
  const r = await t.cycle();
  assert.deepEqual(r.pushed, ["pages/project-phoenix.geml"]);
  const doc = t.fake.doc(a);
  assert.equal(doc.blocks.length, 6);
  const para = doc.blocks[4], note = doc.blocks[5];
  assert.deepEqual([para.type, para.text], ["paragraph", "A paragraph an agent added."]);
  assert.deepEqual([note.type, note.text], ["callout", "We ship on Friday."]);
  const text = read(f);
  assert.match(text, new RegExp(`=== text \\{#${para.id}\\}\\nA paragraph an agent added\\.`), "the id-less paragraph now carries its Anytype id");
  assert.match(text, /=== note \{#decision\}/, "the named block keeps its GEML id");
  const st = JSON.parse(read(t.page(".geml-sync.json")));
  assert.equal(st.files["pages/project-phoenix.geml"].state.ids.decision, note.id);
  // An edit to the named block goes to the right Anytype block.
  writeFileSync(f, read(f).replace("We ship on Friday.", "We ship on Monday."));
  await t.cycle();
  assert.equal(t.fake.doc(a).blocks[5].text, "We ship on Monday.");
  assert.equal(t.fake.doc(a).blocks.length, 6, "not inserted twice");
  await t.done();
});

await test("a new child under a new block reaches the app over two rounds", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  // Move the existing checkbox under a new toggle: the toggle must exist before the move.
  const text = read(f);
  const box = /(=== text \{#(\S+)\}\n- \[ \] Draft spec\n===)/.exec(text);
  writeFileSync(f, text.replace(box[1], `=== note {#later .toggle}\nLater\n===\n\n=== text {#${box[2]} .level-2}\n- [ ] Draft spec\n===`));
  await t.cycle();
  const doc = t.fake.doc(a);
  const toggle = doc.blocks.find((b) => b.type === "toggle");
  const moved = doc.blocks.find((b) => b.id === box[2]);
  assert.ok(toggle, "the toggle was inserted");
  assert.equal(moved.indent, 1, "the existing checkbox moved under it");
  assert.equal(doc.blocks.indexOf(moved), doc.blocks.indexOf(toggle) + 1);
  await t.done();
});

await test("a conflict while pushing: re-read, re-merge, push again", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f).replace("Flat schema", "Flat schema v2"));
  t.fake.conflictNext(1);
  const r = await t.cycle();
  assert.deepEqual(r.pushed, ["pages/project-phoenix.geml"]);
  assert.equal(t.fake.doc(a).blocks[2].text, "Flat schema v2");
  await t.done();
});

await test("a page made in the vault is created in the app and rewritten in the app's shape", async () => {
  const t = await setup();
  await t.cycle();
  mkdirSync(t.page("pages"), { recursive: true });
  writeFileSync(t.page("pages/ideas.geml"), "# Ideas\n\nFirst idea.\n\n- [ ] try it\n");
  const r = await t.cycle();
  assert.deepEqual(r.published, ["pages/ideas.geml"]);
  const [id] = [...t.fake.objects.keys()];
  const doc = t.fake.doc(id);
  assert.equal(doc.properties.Name, "Ideas");
  assert.deepEqual(doc.blocks.map((b) => b.type), ["paragraph", "checkbox"]);
  const text = read(t.page("pages/ideas.geml"));
  assert.match(text, /=== data \{#object \.object format=json\}/);
  assert.equal(verify(t.page("pages/ideas.gemlhistory"), t.page("pages/ideas.geml")).ok, true);
  const again = await t.cycle();
  assert.deepEqual([again.published, again.pushed, again.pulled], [[], [], []], "and then it is quiet");
  await t.done();
});

await test("a page that does not parse is held; nothing is sent", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f) + "\n=== note {#broken}\nnever closed\n");
  t.fake.log.length = 0;
  const r = await t.cycle();
  assert.equal(r.held.length, 1);
  assert.match(r.held[0].why, /does not parse/);
  assert.equal(t.fake.log.filter((l) => l.startsWith("PATCH")).length, 0);
  assert.equal(t.fake.doc(a).blocks.length, 4);
  await t.done();
});

await test("a page deleted in the vault is not deleted in the app", async () => {
  const t = await setup();
  const a = t.fake.add(PHOENIX);
  await t.cycle();
  unlinkSync(t.page("pages/project-phoenix.geml"));
  const r = await t.cycle();
  assert.match(r.held.map((h) => h.why).join(" "), /deleted in the vault/);
  assert.ok(t.fake.objects.has(a));
  await t.done();
});

await test("a dry run writes nothing and sends nothing, and says what it would send", async () => {
  const t = await setup();
  t.fake.add(PHOENIX);
  await t.cycle();
  const f = t.page("pages/project-phoenix.geml");
  writeFileSync(f, read(f).replace("Flat schema", "Flat schema (dry)"));
  const before = read(t.page("pages/project-phoenix.gemlhistory"));
  t.fake.log.length = 0;
  const r = await t.cycle({ dryRun: true });
  assert.equal(r.planned.length, 1);
  assert.deepEqual(r.planned[0].ops.map((o) => o.op), ["update_block"]);
  assert.equal(t.fake.log.filter((l) => !l.startsWith("GET")).length, 0);
  assert.equal(read(t.page("pages/project-phoenix.gemlhistory")), before);
  await t.done();
});

await test("files: the app's image is downloaded into assets/, a local image is uploaded", async () => {
  const t = await setup();
  const fid = t.fake.addFile("PNGDATA", "cat.png");
  const a = t.fake.add({ type: "Page", properties: { Name: "Pics" }, blocks: [{ type: "image", object_id: fid, name: "cat.png", size: 7 }] });
  await t.cycle();
  const f = t.page("pages/pics.geml");
  assert.match(read(f), new RegExp(`!\\[cat\\.png\\]\\(\\.\\./assets/${fid}-cat\\.png\\)`));
  assert.equal(readFileSync(t.page(`assets/${fid}-cat.png`), "utf8"), "PNGDATA");
  mkdirSync(t.page("local"), { recursive: true });
  writeFileSync(t.page("local/dog.png"), "DOGDATA");
  writeFileSync(f, read(f) + "\n![a dog](../local/dog.png)\n");
  await t.cycle();
  const blocks = t.fake.doc(a).blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "image");
  assert.equal(t.fake.files.get(blocks[1].object_id).bytes.toString(), "DOGDATA");
  assert.match(read(f), new RegExp(`assets/${blocks[1].object_id}-a_dog`), "the uploaded image is read back like any other");
  await t.done();
});

await test("--markdown: written pages are mirrored as Markdown, one way", async () => {
  const t = await setup();
  t.fake.add(PHOENIX);
  const md = mkdtempSync(join(tmpdir(), "las-md-"));
  await t.cycle({ markdownDir: md });
  const out = read(join(md, "project-phoenix.md"));
  assert.match(out, /Goals/);
  assert.match(out, /Ship the export\./);
  assert.doesNotMatch(out, /anyblock|#object/);
  rmSync(md, { recursive: true, force: true });
  await t.done();
});

console.log(`\n${passed} test(s) passed.`);
