// End-to-end tests for --signal: a planted fake @logseq/cli copies fixture
// EDN to the -f target, so the full watcher pipeline — export, incremental
// write, status file, signal-triggered re-sync — runs with no Logseq
// installed. This is what makes the plugin's half testable in CI.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_FILE, SIGNAL_FILE } from "../../core/src/bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "bin", "geml-sync.mjs");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok", name);
}

const FIXTURE_A = `
{:properties {} :classes {}
 :pages-and-blocks
 [{:page {:block/title "Page Alpha"}
   :blocks [{:block/title "First block"
             :block/uuid #uuid "11111111-2222-3333-4444-555555555555"}]}]}
`;
const FIXTURE_B = FIXTURE_A.replace("First block", "First block, signalled edit");

function plantFakeCli(dir) {
  const cliDir = join(dir, "node_modules", "@logseq", "cli");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, "cli.mjs"),
    `// fake @logseq/cli for tests: copies the EDN at FAKE_EDN_PATH to the -f target
import { copyFileSync } from "node:fs";
const args = process.argv.slice(2);
const out = args[args.indexOf("-f") + 1];
copyFileSync(process.env.FAKE_EDN_PATH, out);
`
  );
}

async function waitFor(predicate, what, timeoutMs = 15000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run() {
  await test("one-shot --signal writes a status file the plugin can read", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-signal-oneshot-"));
    try {
      plantFakeCli(tmp);
      const src = join(tmp, "source.edn");
      writeFileSync(src, FIXTURE_A);
      const target = join(tmp, "out");
      const signal = join(tmp, "storage", SIGNAL_FILE);

      const res = spawnSync(
        process.execPath,
        [CLI_PATH, "test-graph", target, "--signal", signal],
        {
          env: { ...process.env, LOGSEQ_CLI_DIR: tmp, FAKE_EDN_PATH: src },
          encoding: "utf8",
        }
      );
      assert.equal(res.status, 0, `sync failed: ${res.stderr}`);
      assert.ok(existsSync(join(target, "pages", "page-alpha.geml")));

      const statusPath = join(tmp, "storage", STATUS_FILE);
      assert.ok(existsSync(statusPath), "status file must land beside the signal file");
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      assert.equal(status.ok, true);
      assert.equal(status.graph, "test-graph");
      assert.ok(status.written > 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("one-shot failure writes ok:false into the status file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-signal-fail-"));
    try {
      // A fake CLI that always fails, standing in for "graph not found" —
      // deterministic and offline, unlike letting the npx fallback run.
      const cliDir = join(tmp, "node_modules", "@logseq", "cli");
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(
        join(cliDir, "cli.mjs"),
        `console.error("Graph not found");\nprocess.exit(1);\n`
      );
      const signal = join(tmp, "storage", SIGNAL_FILE);
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, "test-graph", join(tmp, "out"), "--signal", signal],
        {
          env: { ...process.env, LOGSEQ_CLI_DIR: tmp },
          encoding: "utf8",
        }
      );
      assert.equal(res.status, 1);
      const status = JSON.parse(readFileSync(join(tmp, "storage", STATUS_FILE), "utf8"));
      assert.equal(status.ok, false);
      assert.ok(status.error && status.error.length > 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("watch mode: touching the signal file triggers a sync without waiting out the interval", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-signal-watch-"));
    let child = null;
    const stderrChunks = [];
    try {
      plantFakeCli(tmp);
      const src = join(tmp, "source.edn");
      writeFileSync(src, FIXTURE_A);
      const target = join(tmp, "out");
      const signal = join(tmp, "storage", SIGNAL_FILE);
      const statusPath = join(tmp, "storage", STATUS_FILE);
      const alphaPath = join(target, "pages", "page-alpha.geml");

      // Interval of an hour: only the signal can plausibly trigger sync #2.
      child = spawn(
        process.execPath,
        [CLI_PATH, "test-graph", target, "--watch", "--interval", "3600", "--signal", signal],
        {
          env: { ...process.env, LOGSEQ_CLI_DIR: tmp, FAKE_EDN_PATH: src },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      child.stderr.on("data", (d) => stderrChunks.push(d));
      const exited = new Promise((resolveExit) => child.on("exit", resolveExit));

      await waitFor(
        () => existsSync(statusPath) && JSON.parse(readFileSync(statusPath, "utf8")).ok === true,
        "initial sync status"
      );
      assert.ok(readFileSync(alphaPath, "utf8").includes("First block"));

      // The graph "changes", and the plugin writes its dirty marker.
      writeFileSync(src, FIXTURE_B);
      writeFileSync(signal, JSON.stringify({ at: Date.now(), changesSeen: 1 }));

      await waitFor(
        () => readFileSync(alphaPath, "utf8").includes("signalled edit"),
        `signal-triggered sync (stderr: ${Buffer.concat(stderrChunks).toString()})`
      );
    } finally {
      if (child) {
        child.kill();
        await new Promise((r) => setTimeout(r, 500));
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} signal sync tests passed.`);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
