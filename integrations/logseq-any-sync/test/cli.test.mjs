// The CLI as a child process against the fake Anytype API.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { fakeAnytype } from "./fake-anytype.mjs";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "watcher", "bin", "logseq-any-sync.mjs");

/** Run the CLI without blocking this process — the fake server lives here. */
function run(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ANYTYPE_API_KEY: "", ANYTYPE_SPACE: "", ANYTYPE_API_URL: "", ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => done({ code, out, err }));
  });
}

const fake = fakeAnytype();
const url = await fake.start();
fake.add({ type: "Page", properties: { Name: "Hello" }, blocks: [{ type: "paragraph", text: "World." }] });
const env = { ANYTYPE_API_KEY: fake.apiKey, ANYTYPE_API_URL: url };

await test("no arguments prints the usage and exits 2", async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.out, /Usage:/);
});

await test("a missing key and a missing space are named", async () => {
  assert.match((await run(["v", "--space", "s"])).err, /set ANYTYPE_API_KEY/);
  assert.match((await run(["v"], { ANYTYPE_API_KEY: "k" })).err, /--space <space-id>/);
});

await test("an unknown flag is refused", async () => {
  const r = await run(["v", "--space", fake.space, "--two-way"], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag --two-way/);
});

await test("doctor reaches the API and says whether rows carry modification times", async () => {
  const r = await run(["doctor", "--space", fake.space], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ok: reached .* lists 1 object/);
  assert.match(r.out, /carry last_modified_date/);
  const bad = await run(["doctor", "--space", fake.space], { ...env, ANYTYPE_API_KEY: "wrong" });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /401/);
});

await test("--once syncs one cycle and exits", async () => {
  const vault = mkdtempSync(join(tmpdir(), "las-cli-"));
  const r = await run([vault, "--space", fake.space, "--once"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1 new page/);
  assert.ok(existsSync(join(vault, "pages", "hello.geml")));
  assert.match(readFileSync(join(vault, "pages", "hello.geml"), "utf8"), /World\./);
  rmSync(vault, { recursive: true, force: true });
});

await test("an app that is not running is a clear error with --once", async () => {
  const vault = mkdtempSync(join(tmpdir(), "las-cli-"));
  const r = await run([vault, "--space", fake.space, "--once", "--api", "http://127.0.0.1:9"], env);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot reach the Anytype app .* is the desktop app running\?/);
  rmSync(vault, { recursive: true, force: true });
});

await fake.stop();
console.log(`\n${passed} test(s) passed.`);
