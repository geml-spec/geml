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
  detectGraphViaCli,
  appCliCandidates,
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

  test("findAppCli: a Windows .cmd shim is READ, not run — that is all the app installs there", () => {
    // Verbatim shape of what the app writes (it carries the marker itself).
    const dir = join("C:", "Users", "u", ".local", "bin");
    const exe = join("C:", "Programs", "Logseq", "Logseq.exe");
    const cliJs = join("C:", "Programs", "Logseq", "resources", "app.asar", "js", "logseq-cli.js");
    const found = findAppCli(
      probe({
        platform: "win32",
        home: join("C:", "Users", "u"),
        env: { PATH: dir },
        files: {
          [join(dir, "logseq.cmd")]:
            `@echo off\r\nREM logseq-cli-managed\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${cliJs}" %*\r\n`,
        },
      })
    );
    assert.ok(found, "a managed shim is a usable answer, not a dead end");
    assert.equal(found.command, exe, "Node cannot exec the .cmd, but it can exec what the .cmd names");
    assert.deepEqual(found.argsPrefix, [cliJs]);
    assert.equal(found.env.ELECTRON_RUN_AS_NODE, "1");
  });

  test("findAppCli: a .cmd that is not a managed shim is left alone", () => {
    const dir = join("C:", "bin");
    const found = findAppCli(
      probe({
        platform: "win32",
        env: { PATH: dir },
        files: { [join(dir, "logseq.cmd")]: "@echo off\r\necho something else\r\n" },
      })
    );
    assert.equal(found, null, "guessing at an unknown .cmd is worse than saying nothing");
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

  // --- asking the CLI, instead of guessing at the filesystem ---------------
  // `graph list` and `server list` are the app's own answers: they hold on any
  // OS and for a graph root nobody put in the default place.
  const cliAnswers = (graphs, servers) => (args) => {
    if (args[0] === "graph" && args[1] === "list") {
      return JSON.stringify({ status: "ok", data: { graphs } });
    }
    if (args[0] === "server" && args[1] === "list") {
      return JSON.stringify({ status: "ok", data: { servers } });
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };

  test("appCliCandidates: the launcher the app installed outranks anything we deduce", () => {
    const onPath = join("/opt", "bin", "logseq");
    const cands = appCliCandidates(
      probe({
        platform: "darwin",
        env: { PATH: join("/opt", "bin") },
        files: {
          [onPath]: "",
          [join(HOME, ".local", "bin", "logseq")]: "",
          ["/Applications/Logseq.app/Contents/MacOS/Logseq"]: "",
        },
      })
    );
    assert.equal(cands[0].command, onPath, "what the app put on PATH is the answer we trust most");
    assert.equal(
      cands[cands.length - 1].command,
      "/Applications/Logseq.app/Contents/MacOS/Logseq",
      "the hardcoded bundle path is a guess and must rank last"
    );
  });

  test("appCliCandidates: on Windows the app's launcher is found off PATH too", () => {
    const home = join("C:", "Users", "u");
    const exe = join("C:", "Programs", "Logseq", "Logseq.exe");
    const cliJs = join("C:", "Programs", "Logseq", "js", "logseq-cli.js");
    const cands = appCliCandidates(
      probe({
        platform: "win32",
        home,
        env: { PATH: join("C:", "nothing") },
        files: {
          [join(home, ".local", "bin", "logseq.cmd")]:
            `@echo off\r\nREM logseq-cli-managed\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${cliJs}" %*\r\n`,
        },
      })
    );
    assert.equal(cands.length, 1, "the app's default install directory must be searched on Windows too");
    assert.equal(cands[0].command, exe);
  });

  test("findAppCli: a candidate that does not actually work is skipped for one that does", () => {
    const broken = join("/opt", "bin", "logseq");
    const bundle = "/Applications/Logseq.app/Contents/MacOS/Logseq";
    const pr = probe({
      platform: "darwin",
      env: { PATH: join("/opt", "bin") },
      files: { [broken]: "", [bundle]: "" },
    });
    // Verification is the point: no amount of path knowledge beats asking.
    const found = findAppCli(pr, (c) => c.command !== broken);
    assert.equal(found.command, bundle);

    assert.equal(findAppCli(pr, () => false), null, "nothing that works means nothing to report");
    assert.equal(findAppCli(pr).command, broken, "with no verifier, the ranking stands");
  });

  test("detectGraphViaCli: the app-owned server names the open graph", () => {
    const got = detectGraphViaCli(
      cliAnswers(
        ["Work", "Demo"],
        [
          { graph: "Work", "owner-source": "cli", "root-dir": "/vol/notes" },
          { graph: "Demo", "owner-source": "electron", "root-dir": "/vol/notes" },
        ]
      )
    );
    assert.equal(got.name, "Demo");
    assert.equal(got.rootDir, "/vol/notes", "the CLI knows where the graphs live; we should not guess");
    assert.deepEqual(got.graphs.sort(), ["Demo", "Work"]);
  });

  test("detectGraphViaCli: one graph and no server running is still unambiguous", () => {
    const got = detectGraphViaCli(cliAnswers(["Solo"], []));
    assert.equal(got.name, "Solo");
  });

  test("detectGraphViaCli: several, none app-owned, stays a question for the user", () => {
    const got = detectGraphViaCli(
      cliAnswers(["A", "B"], [{ graph: "A", "owner-source": "cli", "root-dir": "/r" }])
    );
    assert.equal(got.name, undefined);
    assert.deepEqual(got.candidates.sort(), ["A", "B"]);
  });

  test("detectGraphViaCli: an unusable CLI returns null so the caller can fall back", () => {
    assert.equal(detectGraphViaCli(() => "not json at all"), null);
    assert.equal(detectGraphViaCli(() => { throw new Error("ENOENT"); }), null);
    assert.equal(detectGraphViaCli(cliAnswers([], [])), null, "no graphs is not an answer either");
  });

  test("detectGraphViaCli: a broken `server list` does not sink the graph list", () => {
    const got = detectGraphViaCli((args) =>
      args[0] === "graph"
        ? JSON.stringify({ status: "ok", data: { graphs: ["Only"] } })
        : (() => { throw new Error("server list blew up"); })()
    );
    assert.equal(got.name, "Only");
    assert.equal(got.rootDir, null);
  });

  console.log(`\n${passed} discovery tests passed.`);
}

run();
