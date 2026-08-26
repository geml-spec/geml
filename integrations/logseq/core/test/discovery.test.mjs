// Tests for discovery.mjs — everything the watcher can work out for itself
// instead of asking the user to type it. Filesystem and platform arrive as an
// injected probe, so these run identically on macOS, Linux and Windows CI.
import { strict as assert } from "node:assert";
import { join } from "node:path";
import {
  PLUGIN_ID,
  logseqDotDir,
  logseqRootDir,
  signalFilePath,
  pluginSettings,
  findAppCli,
  detectGraph,
} from "../src/discovery.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok", name);
}

const HOME = join("/home", "u");

function probe({ platform = "darwin", env = {}, home = HOME, files = {}, dirs = {} } = {}) {
  return {
    platform,
    env,
    home,
    exists: (p) => p in files || p in dirs,
    read: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    listDir: (p) => dirs[p] ?? [],
  };
}

function run() {
  test("logseqDotDir: ~/.logseq by default, LOGSEQ_DOTDIR when set", () => {
    assert.equal(logseqDotDir(probe()), join(HOME, ".logseq"));
    assert.equal(
      logseqDotDir(probe({ env: { LOGSEQ_DOTDIR: join("/custom", "dot") } })),
      join("/custom", "dot")
    );
  });

  test("logseqRootDir: ~/logseq by default — graphs live there, not in the dotdir", () => {
    assert.equal(logseqRootDir(probe()), join(HOME, "logseq"));
    assert.equal(
      logseqRootDir(probe({ env: { LOGSEQ_ROOT_DIR: join("/vol", "graphs-root") } })),
      join("/vol", "graphs-root")
    );
  });

  test("signalFilePath: the plugin storage path the user should never have to type", () => {
    assert.equal(
      signalFilePath(probe()),
      join(HOME, ".logseq", "storages", PLUGIN_ID, "geml-sync-dirty.json")
    );
  });

  test("pluginSettings: reads the settings the plugin writes, and never throws", () => {
    const settingsPath = join(HOME, ".logseq", "settings", `${PLUGIN_ID}.json`);

    const good = pluginSettings(
      probe({ files: { [settingsPath]: '{"vaultPath":"/v/vault","debounceSeconds":5}' } })
    );
    assert.equal(good.vaultPath, "/v/vault");

    // A user who never opened the settings panel has no file at all.
    assert.deepEqual(pluginSettings(probe()), {});

    // A half-written file must not take the watcher down.
    assert.deepEqual(pluginSettings(probe({ files: { [settingsPath]: "{not json" } })), {});
  });

  test("findAppCli: prefers the shim on PATH", () => {
    const onPath = join("/opt", "bin", "logseq");
    const found = findAppCli(
      probe({ env: { PATH: [join("/nope"), join("/opt", "bin")].join(":") }, files: { [onPath]: "" } })
    );
    assert.equal(found.command, onPath);
    assert.deepEqual(found.argsPrefix, []);
  });

  test("findAppCli: falls back to ~/.local/bin/logseq, where the app installs it", () => {
    const local = join(HOME, ".local", "bin", "logseq");
    const found = findAppCli(probe({ files: { [local]: "" } }));
    assert.equal(found.command, local);
  });

  test("findAppCli: with no shim at all, drives the macOS app bundle directly", () => {
    const electron = "/Applications/Logseq.app/Contents/MacOS/Logseq";
    const cliJs = "/Applications/Logseq.app/Contents/Resources/app.asar/js/logseq-cli.js";
    const found = findAppCli(probe({ platform: "darwin", files: { [electron]: "" } }));
    assert.equal(found.command, electron);
    assert.deepEqual(found.argsPrefix, [cliJs]);
    assert.equal(
      found.env.ELECTRON_RUN_AS_NODE,
      "1",
      "the app binary is Electron; without this it launches the GUI instead of the CLI"
    );
  });

  test("findAppCli: returns null when nothing is installed, rather than guessing", () => {
    assert.equal(findAppCli(probe({ env: { PATH: "/nowhere" } })), null);
  });

  test("findAppCli: on Windows takes the .exe and never a .cmd shim", () => {
    const dir = join("C:", "Program Files", "Logseq");
    const found = findAppCli(
      probe({
        platform: "win32",
        env: { PATH: dir },
        files: { [join(dir, "logseq.cmd")]: "", [join(dir, "logseq.exe")]: "" },
      })
    );
    assert.ok(found, "expected the .exe to be found");
    assert.ok(
      found.command.endsWith(".exe"),
      `Node cannot exec a .cmd without a shell, got ${found.command}`
    );
  });

  test("detectGraph: one graph on disk needs no asking", () => {
    const graphs = join(HOME, "logseq", "graphs");
    const got = detectGraph(probe({ dirs: { [graphs]: ["Demo"] } }));
    assert.equal(got.name, "Demo");
  });

  test("detectGraph: with several, the one the app has open wins", () => {
    const graphs = join(HOME, "logseq", "graphs");
    const got = detectGraph(
      probe({
        dirs: { [graphs]: ["Work", "Demo", "Archive"] },
        files: { [join(graphs, "Demo", "db-worker.lock")]: '{"owner-source":"electron"}' },
      })
    );
    assert.equal(got.name, "Demo");
    assert.match(got.how, /open/i, "the reason shown to the user should say why this one");
  });

  test("detectGraph: a CLI-spawned worker's lock is not the app having it open", () => {
    const graphs = join(HOME, "logseq", "graphs");
    const got = detectGraph(
      probe({
        dirs: { [graphs]: ["Demo", "scratch"] },
        files: {
          // Exporting a graph starts a db-worker of its own and leaves this
          // behind; only the desktop app writes owner-source "electron".
          [join(graphs, "scratch", "db-worker.lock")]: '{"owner-source":"cli","pid":1}',
          [join(graphs, "Demo", "db-worker.lock")]: '{"owner-source":"electron","pid":2}',
        },
      })
    );
    assert.equal(got.name, "Demo");
  });

  test("detectGraph: an unreadable lock file is ignored, not trusted", () => {
    const graphs = join(HOME, "logseq", "graphs");
    const got = detectGraph(
      probe({
        dirs: { [graphs]: ["A", "B"] },
        files: { [join(graphs, "A", "db-worker.lock")]: "{corrupt" },
      })
    );
    assert.deepEqual(got.candidates.sort(), ["A", "B"]);
  });

  test("detectGraph: several and none open is ambiguous — report candidates, do not guess", () => {
    const graphs = join(HOME, "logseq", "graphs");
    const got = detectGraph(probe({ dirs: { [graphs]: ["Work", "Demo"] } }));
    assert.equal(got.name, undefined);
    assert.deepEqual(got.candidates.sort(), ["Demo", "Work"]);
  });

  test("detectGraph: no graphs at all returns null", () => {
    assert.equal(detectGraph(probe()), null);
  });

  console.log(`\n${passed} discovery tests passed.`);
}

run();
