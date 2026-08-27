// Tests for bin/logseq-sync.mjs CLI: argument parsing, validation, error exits, and execution.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_FILE, SIGNAL_FILE } from "../../core/src/bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "bin", "logseq-sync.mjs");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok", name);
}

// Every fixture gets its own Logseq layout: a dotdir, so a run never writes
// status into the developer's real plugin storage, and a graphs directory
// holding "test-graph", so the unknown-graph guard sees the graph these tests
// name. Without this the tests silently depend on whoever's machine runs them.
function plantLayout(dir) {
  mkdirSync(join(dir, "ls-root", "graphs", "test-graph"), { recursive: true });
  mkdirSync(join(dir, "dot"), { recursive: true });
  return {
    LOGSEQ_ROOT_DIR: join(dir, "ls-root"),
    LOGSEQ_DOTDIR: join(dir, "dot"),
    LOGSEQ_APP_CLI: "",
    LOGSEQ_API_SERVER_TOKEN: "",
  };
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

// A fake @logseq/cli that records the argv it was called with, then writes
// fixture EDN to the -f target — so we can assert HOW the watcher invokes the
// exporter (-g local graph vs -a in-app API server), with no Logseq installed.
const FIXTURE_EDN = `
{:properties {} :classes {}
 :pages-and-blocks
 [{:page {:block/title "Page Alpha"}
   :blocks [{:block/title "First block"
             :block/uuid #uuid "11111111-2222-3333-4444-555555555555"}]}]}
`;

function plantRecordingCli(dir) {
  const cliDir = join(dir, "node_modules", "@logseq", "cli");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, "cli.mjs"),
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.RECORD_ARGV_PATH, JSON.stringify(args));
// Guard the -f lookup: indexOf returns -1 when absent, and writing to args[0]
// drops a file named after the subcommand into whatever directory ran the test.
if (args.includes("-f")) {
  writeFileSync(args[args.indexOf("-f") + 1], process.env.FAKE_EDN);
}
`
  );
}

function runSync(cliArgs, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "geml-cli-argv-"));
  try {
    plantRecordingCli(tmp);
    const record = join(tmp, "argv.json");
    const res = runCli([...cliArgs, join(tmp, "out"), "--once"], {
      env: {
        ...process.env,
        ...plantLayout(tmp),
        LOGSEQ_CLI_DIR: tmp,
        RECORD_ARGV_PATH: record,
        FAKE_EDN: FIXTURE_EDN,
        ...extraEnv,
      },
    });
    assert.equal(res.status, 0, `sync failed: ${res.stderr}`);
    return { argv: JSON.parse(readFileSync(record, "utf8")), stdout: res.stdout };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const exportArgvFor = (cliArgs, extraEnv) => runSync(cliArgs, extraEnv).argv;

// The Logseq desktop app ships its own CLI, and unlike @logseq/cli it talks to
// the running app's db-worker instead of opening db.sqlite — the only route
// that works while the app has the graph open. The fake stands in for it.
// POSIX only: Node refuses to execFile a .cmd/.bat without a shell, so the
// Windows shape is covered by the argument-validation tests instead.
function plantFakeAppCli(dir) {
  const impl = join(dir, "app-cli-impl.mjs");
  writeFileSync(
    impl,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.RECORD_ARGV_PATH, JSON.stringify(args));
// Detection asks for the graph list first; answer it so the search stops here
// rather than walking on to a real Logseq on the machine running these tests.
if (args[0] === "graph" && args[1] === "list") {
  console.log(JSON.stringify({ status: "ok", data: { graphs: ["test-graph"] } }));
} else if (args[0] === "server" && args[1] === "list") {
  console.log(JSON.stringify({ status: "ok", data: { servers: [] } }));
} else if (args.includes("--file")) {
  writeFileSync(args[args.indexOf("--file") + 1], process.env.FAKE_EDN);
}
`
  );
  const shim = join(dir, "logseq");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function runWithAppCli(extraArgs, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "geml-appcli-"));
  try {
    const shim = plantFakeAppCli(tmp);
    const record = join(tmp, "argv.json");
    const res = runCli(["test-graph", join(tmp, "out"), "--once", ...extraArgs(shim)], {
      env: {
        ...process.env,
        ...plantLayout(tmp),
        RECORD_ARGV_PATH: record,
        FAKE_EDN: FIXTURE_EDN,
        ...extraEnv(shim),
      },
    });
    assert.equal(res.status, 0, `sync failed: ${res.stderr}`);
    return { argv: JSON.parse(readFileSync(record, "utf8")), stdout: res.stdout };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  await test("CLI: exits 2 on invalid --interval (0, negative, non-integer, missing value)", () => {
    // 0
    const res0 = runCli(["graph", "dir", "--interval", "0"]);
    assert.equal(res0.status, 2);
    assert.ok(res0.stderr.includes("--interval must be a positive integer"));

    // Negative
    const resNeg = runCli(["graph", "dir", "--interval", "-5"]);
    assert.equal(resNeg.status, 2);
    assert.ok(resNeg.stderr.includes("--interval must be a positive integer"));

    // Non-integer
    const resFloat = runCli(["graph", "dir", "--interval", "abc"]);
    assert.equal(resFloat.status, 2);
    assert.ok(resFloat.stderr.includes("--interval must be a positive integer"));

    // Missing value
    const resMissing = runCli(["graph", "dir", "--interval"]);
    assert.equal(resMissing.status, 2);
    assert.ok(resMissing.stderr.includes("--interval requires a value"));
  });

  await test("CLI: exits 2 on invalid graph name (command/shell injection protection)", () => {
    const resInjection = runCli(["foo;calc", "dir"]);
    assert.equal(resInjection.status, 2);
    assert.ok(resInjection.stderr.includes("Invalid graph name"));

    const resAmpersand = runCli(["foo&whoami", "dir"]);
    assert.equal(resAmpersand.status, 2);
    assert.ok(resAmpersand.stderr.includes("Invalid graph name"));

    const resSlash = runCli(["foo/bar", "dir"]);
    assert.equal(resSlash.status, 2);
    assert.ok(resSlash.stderr.includes("Invalid graph name"));
  });

  await test("CLI: exits 2 on unknown flags, and points at --help", () => {
    const res = runCli(["graph", "dir", "--nonexistent-flag"]);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes('Unknown flag "--nonexistent-flag"'));
    assert.ok(res.stderr.includes("--help"), "an unknown flag must tell the user where usage lives");
  });

  await test("CLI: a single-dash typo is an unknown flag, never a graph name", () => {
    // `-graph demo` really happened: it synced a graph named "-graph" into ./demo.
    const res = runCli(["-graph", "demo"]);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes('Unknown flag "-graph"'), res.stderr);
  });

  await test("CLI: a graph name may not start with a dash or a dot (argv injection into the exporter)", () => {
    for (const name of ["-evil", ".hidden", ".."]) {
      const res = runCli(["--graph", name, "dir"]);
      assert.equal(res.status, 2, `expected exit 2 for graph name ${name}`);
      assert.ok(res.stderr.includes("Invalid graph name"), res.stderr);
    }
  });

  await test("CLI: --graph over an empty graphs dir refuses like the bare run does", () => {
    // `logseq-sync` said "no graphs found"; `logseq-sync --graph demo` then
    // sailed on to the vault error — the same zero-graph state read as a hard
    // stop on one path and as "cannot verify, proceed" on the other.
    const tmp = mkdtempSync(join(tmpdir(), "geml-nograph-"));
    try {
      mkdirSync(join(tmp, "ls-root", "graphs"), { recursive: true }); // readable, empty
      mkdirSync(join(tmp, "dot"), { recursive: true });
      const res = runCli(["--graph", "demo", join(tmp, "out")], {
        env: {
          ...process.env,
          LOGSEQ_ROOT_DIR: join(tmp, "ls-root"),
          LOGSEQ_DOTDIR: join(tmp, "dot"),
          LOGSEQ_APP_CLI: "",
          LOGSEQ_API_SERVER_TOKEN: "",
        },
      });
      assert.equal(res.status, 2, res.stderr);
      assert.ok(res.stderr.includes('no graph named "demo"'), res.stderr);
      assert.ok(res.stderr.includes("LOGSEQ_ROOT_DIR"), "the escape hatch must be named");
      assert.ok(res.stderr.includes("doctor"), "preflight errors point at doctor");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("CLI: --two-way without an app CLI is refused up front", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-twoway-precheck-"));
    try {
      const res = runCli(["test-graph", join(tmp, "out"), "--once", "--two-way"], {
        env: { ...process.env, ...plantLayout(tmp) },
      });
      assert.equal(res.status, 2, res.stderr);
      assert.ok(res.stderr.includes("--two-way needs the Logseq desktop app's CLI"), res.stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("CLI: the missing-vault error points at doctor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-novault-"));
    try {
      const res = runCli(["--graph", "test-graph"], {
        env: { ...process.env, ...plantLayout(tmp) },
      });
      assert.equal(res.status, 2, res.stderr);
      assert.ok(res.stderr.includes("no vault directory"), res.stderr);
      assert.ok(res.stderr.includes("doctor"), res.stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("CLI: --help/-h/help print usage that speaks the installed name, exit 0", () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const res = runCli(args);
      assert.equal(res.status, 0, `${args[0]} must exit 0, got ${res.status}: ${res.stderr}`);
      assert.ok(res.stdout.includes("logseq-sync ["), `usage must show the command name, not a repo path: ${args[0]}`);
      assert.ok(!res.stdout.includes("node watcher/bin"), "usage must not teach a repo-internal invocation");
      for (const word of ["doctor", "restore", "--mirror", "--api-server-token"]) {
        assert.ok(res.stdout.includes(word), `usage must mention ${word}`);
      }
    }
  });

  await test("CLI: one-shot sync exits 1 on failure (Issue 3: non-zero exit on error)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-cli-fail-"));
    try {
      // An app CLI that is not there fails the same way a broken install does.
      const res = runCli(["test-graph", tmp, "--once", "--app-cli", join(tmp, "no-such-logseq")], {
        env: { ...process.env, ...plantLayout(tmp) },
      });
      assert.equal(res.status, 1, "Failed one-shot sync MUST exit 1, not 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("CLI: without a token, export-edn opens the local graph by name (-g)", () => {
    const argv = exportArgvFor(["test-graph", "--no-app-cli"]);
    assert.deepEqual(argv.slice(0, 3), ["export-edn", "-g", "test-graph"]);
    assert.ok(!argv.includes("-a"), "must not pass -a when no token was given");
  });

  await test("CLI: --api-server-token exports the in-app graph via -a, never -g", () => {
    const argv = exportArgvFor(["test-graph", "--api-server-token", "tok-abc123"]);
    assert.ok(argv.includes("-a"), "expected -a in the export argv");
    assert.equal(argv[argv.indexOf("-a") + 1], "tok-abc123");
    assert.ok(
      !argv.includes("-g"),
      "-a exports whatever graph the app has open; passing -g too is ambiguous"
    );
  });

  await test("CLI: the token can come from LOGSEQ_API_SERVER_TOKEN instead of argv", () => {
    const argv = exportArgvFor(["test-graph"], { LOGSEQ_API_SERVER_TOKEN: "tok-from-env" });
    assert.equal(argv[argv.indexOf("-a") + 1], "tok-from-env");
    assert.ok(!argv.includes("-g"));
  });

  await test("CLI: an explicit --api-server-token beats LOGSEQ_API_SERVER_TOKEN", () => {
    const argv = exportArgvFor(["test-graph", "--api-server-token", "tok-flag"], {
      LOGSEQ_API_SERVER_TOKEN: "tok-from-env",
    });
    assert.equal(argv[argv.indexOf("-a") + 1], "tok-flag");
  });

  await test("CLI: exits 2 when --api-server-token is given no value", () => {
    const res = runCli(["graph", "dir", "--api-server-token"]);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes("--api-server-token requires a value"));
  });

  await test("CLI: the banner names the export source, and never prints the token", () => {
    const local = runSync(["test-graph", "--no-app-cli"]);
    assert.match(local.stdout, /graph "test-graph"/i);
    assert.ok(
      !/API/i.test(local.stdout),
      "a local export must not claim to be going through the app API"
    );

    const viaApi = runSync(["test-graph", "--api-server-token", "tok-secret-xyz"]);
    assert.match(
      viaApi.stdout,
      /API server/i,
      "the banner must say the export goes through the running app, not the sqlite file"
    );
    assert.ok(
      !viaApi.stdout.includes("tok-secret-xyz"),
      "the token must never be echoed to stdout — these logs get pasted into issues"
    );
  });

  await test("CLI: a failed export never leaks the token — not to stderr, not into the status file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-cli-leak-"));
    try {
      // A fake CLI that fails the way the real one does when the app's API
      // server is not listening — execFileSync puts the whole argv, token and
      // all, into err.message.
      const cliDir = join(tmp, "node_modules", "@logseq", "cli");
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(
        join(cliDir, "cli.mjs"),
        `console.error('Failed to connect to HTTP API Server with error "fetch failed"');\nprocess.exit(1);\n`
      );

      const signal = join(tmp, "storage", SIGNAL_FILE);
      const res = runCli(
        ["test-graph", join(tmp, "out"), "--once", "--api-server-token", "tok-secret-xyz", "--signal", signal],
        { env: { ...process.env, ...plantLayout(tmp), LOGSEQ_CLI_DIR: tmp } }
      );

      assert.equal(res.status, 1, "a failed export must still exit 1");
      assert.ok(
        !res.stderr.includes("tok-secret-xyz") && !res.stdout.includes("tok-secret-xyz"),
        `token leaked into the console output:\n${res.stderr}`
      );

      const status = readFileSync(join(dirname(signal), STATUS_FILE), "utf8");
      assert.ok(
        !status.includes("tok-secret-xyz"),
        `token leaked into the status file the plugin renders in the toolbar:\n${status}`
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("CLI: exits 2 when --app-cli is given no value", () => {
    const res = runCli(["graph", "dir", "--app-cli"]);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes("--app-cli requires a value"));
  });

  await test("CLI: --app-cli and --api-server-token are mutually exclusive", () => {
    const res = runCli(["graph", "dir", "--app-cli", "logseq", "--api-server-token", "tok"]);
    assert.equal(res.status, 2);
    assert.ok(
      /mutually exclusive|cannot be combined/i.test(res.stderr),
      `expected a mutual-exclusion error, got: ${res.stderr}`
    );
  });

  await test("CLI: --app-cli rejects a .cmd/.bat shim with actionable guidance", () => {
    for (const shim of ["C:\\Logseq\\logseq.cmd", "/x/logseq.bat"]) {
      const res = runCli(["graph", "dir", "--app-cli", shim]);
      assert.equal(res.status, 2, `expected exit 2 for ${shim}`);
      assert.ok(
        /\.cmd|\.bat/i.test(res.stderr) && /executable/i.test(res.stderr),
        `expected guidance to point at the executable, got: ${res.stderr}`
      );
    }
  });

  if (process.platform === "win32") {
    await test("CLI (Windows): a missing @logseq/cli fails with instructions, not spawn EINVAL", () => {
      const tmp = mkdtempSync(join(tmpdir(), "geml-cli-noinstall-"));
      try {
        // No @logseq/cli under LOGSEQ_CLI_DIR and no app CLI: the old fallback
        // spawned npx.cmd, which Node refuses shell-less — every poll printed
        // `spawnSync npx.cmd EINVAL` and told the user nothing.
        const res = runCli(["test-graph", join(tmp, "out"), "--once"], {
          env: { ...process.env, ...plantLayout(tmp), LOGSEQ_CLI_DIR: tmp },
        });
        assert.equal(res.status, 1);
        assert.ok(res.stderr.includes("LOGSEQ_CLI_DIR"), `expected install guidance, got: ${res.stderr}`);
        assert.ok(!res.stderr.includes("EINVAL"), "a raw spawn error is not an answer a user can act on");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
    console.log("# skipped app-cli invocation tests: needs a POSIX shebang shim");
  } else {
    await test("CLI: --two-way imports a vault edit and holds a both-sides conflict", () => {
      const tmp = mkdtempSync(join(tmpdir(), "geml-twoway-"));
      try {
        // A stateful fake app CLI: export serves the "graph" (a file), import
        // REPLACES that file with the imported EDN — the crudest possible
        // model of Logseq's merge, but enough that the re-export after an
        // import reflects it, exactly like the real app.
        const impl = join(tmp, "app-impl.mjs");
        writeFileSync(
          impl,
          `import { appendFileSync, copyFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "graph" && args[1] === "list") {
  console.log(JSON.stringify({ status: "ok", data: { graphs: ["test-graph"] } }));
} else if (args[0] === "server" && args[1] === "list") {
  console.log(JSON.stringify({ status: "ok", data: { servers: [] } }));
} else if (args.includes("--file")) {
  copyFileSync(process.env.FAKE_EDN_PATH, args[args.indexOf("--file") + 1]);
} else if (args[0] === "graph" && args[1] === "import") {
  copyFileSync(args[args.indexOf("--input") + 1], process.env.FAKE_EDN_PATH);
}
`
        );
        const shim = join(tmp, "logseq");
        writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
        chmodSync(shim, 0o755);

        const src = join(tmp, "graph.edn");
        writeFileSync(src, FIXTURE_EDN);
        const out = join(tmp, "out");
        const log = join(tmp, "argv.jsonl");
        const layout = plantLayout(tmp);
        const env = { ...process.env, ...layout, FAKE_EDN_PATH: src, ARGV_LOG: log };
        const args = ["test-graph", out, "--once", "--two-way", "--app-cli", shim, "--no-git-commit"];
        const statusPath = join(layout.LOGSEQ_DOTDIR, "storages", "logseq-plugin-sync-vault-with-geml", "geml-sync-status.json");
        const importCalls = () =>
          readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a[0] === "graph" && a[1] === "import");

        // 1. First sync writes the baseline; nothing to import yet.
        let res = runCli(args, { env });
        assert.equal(res.status, 0, res.stderr);
        assert.equal(importCalls().length, 0, "the baseline sync must not import");

        // 2. A vault edit imports: backup first, merged state stays on disk.
        const alpha = join(out, "pages", "page-alpha.geml");
        const vaultEdit = readFileSync(alpha, "utf8").replace("First block", "First block, from the vault");
        writeFileSync(alpha, vaultEdit);
        res = runCli(args, { env });
        assert.equal(res.status, 0, res.stderr);
        const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        assert.ok(calls.some((a) => a[0] === "graph" && a[1] === "backup"), "an import is preceded by a backup");
        assert.equal(importCalls().length, 1, "the vault edit must be imported exactly once");
        assert.ok(readFileSync(alpha, "utf8").includes("from the vault"), "the merged state keeps the vault edit");
        let status = JSON.parse(readFileSync(statusPath, "utf8"));
        assert.equal(status.imported, 1);
        assert.deepEqual(status.conflicts, []);

        // 3. Steady state: nothing changed, nothing imported.
        res = runCli(args, { env });
        assert.equal(res.status, 0, res.stderr);
        assert.equal(importCalls().length, 1, "an already-synced vault must not re-import");

        // 4. Both sides move the same page: a conflict — held, not imported,
        //    not overwritten, named in the status the toolbar renders.
        writeFileSync(src, readFileSync(src, "utf8").replace("from the vault", "from the app"));
        const conflictEdit = readFileSync(alpha, "utf8").replace("from the vault", "vault again");
        writeFileSync(alpha, conflictEdit);
        res = runCli(args, { env });
        assert.equal(res.status, 0, res.stderr);
        assert.equal(importCalls().length, 1, "a conflicted file must not be imported");
        assert.equal(readFileSync(alpha, "utf8"), conflictEdit, "the person's version stays on disk");
        status = JSON.parse(readFileSync(statusPath, "utf8"));
        assert.deepEqual(status.conflicts, ["pages/page-alpha.geml"]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    await test("CLI: --app-cli exports through the app, asking for the :graph-human format", () => {
      const { argv } = runWithAppCli((shim) => ["--app-cli", shim], () => ({}));
      assert.deepEqual(argv.slice(0, 2), ["graph", "export"]);
      assert.equal(argv[argv.indexOf("--graph") + 1], "test-graph");
      assert.equal(argv[argv.indexOf("--type") + 1], "edn");
      assert.ok(
        argv.includes("-e") && argv[argv.indexOf("-e") + 1].includes(":graph-human"),
        "2.0 renamed the pages-and-blocks export to :graph-human — :graph is now datoms"
      );
    });

    await test("CLI: the app CLI can come from LOGSEQ_APP_CLI, and the flag beats it", () => {
      const fromEnv = runWithAppCli(() => [], (shim) => ({ LOGSEQ_APP_CLI: shim }));
      assert.deepEqual(fromEnv.argv.slice(0, 2), ["graph", "export"]);
      assert.match(fromEnv.stdout, /app/i, "the banner must name the app CLI as the export source");

      const both = runWithAppCli(
        (shim) => ["--app-cli", shim],
        () => ({ LOGSEQ_APP_CLI: "/nonexistent/logseq" })
      );
      assert.deepEqual(both.argv.slice(0, 2), ["graph", "export"]);
    });
  }

  console.log(`\n${passed} CLI tests passed.`);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
