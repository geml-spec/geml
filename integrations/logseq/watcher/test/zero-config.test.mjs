// The setup this package is judged on: `geml-sync` with nothing after it.
// A temp LOGSEQ_DOTDIR + LOGSEQ_ROOT_DIR stand in for a real installation, so
// the whole resolution path — settings file, graph directory, plugin storage,
// app CLI — runs end to end against real files with no Logseq present.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_FILE } from "../../core/src/bridge.mjs";
import { PLUGIN_ID } from "../../core/src/discovery.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "bin", "geml-sync.mjs");

// The host's PATH minus any directory that already holds a real `logseq` —
// fixtures must never reach the developer's own installation, but they DO need
// git. Everything below builds on this.
const SAFE_PATH = (process.env.PATH || "")
  .split(":")
  .filter((d) => d && !existsSync(join(d, "logseq")))
  .join(":");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok", name);
}

const FIXTURE_EDN = `
{:properties {} :classes {}
 :pages-and-blocks
 [{:page {:block/title "Page Alpha"}
   :blocks [{:block/title "First block"
             :block/uuid #uuid "11111111-2222-3333-4444-555555555555"}]}
  {:page {:block/title "Page Beta"}
   :blocks [{:block/title "Second block"
             :block/uuid #uuid "22222222-3333-4444-5555-666666666666"}]}]}
`;

// The same graph with Page Alpha removed. Not an EMPTY graph — the engine
// rightly refuses to sync 0 pages over a populated vault, and that guard is
// not what these tests are about.
const FIXTURE_EDN_MINUS_ALPHA = `
{:properties {} :classes {}
 :pages-and-blocks
 [{:page {:block/title "Page Beta"}
   :blocks [{:block/title "Second block"
             :block/uuid #uuid "22222222-3333-4444-5555-666666666666"}]}]}
`;

/**
 * A throwaway Logseq installation: dotdir, graph directories, a fake app CLI
 * on PATH. Returns the environment a `geml-sync` run should be given.
 */
function installation({ graphs = ["Demo"], openGraph = "Demo", settings = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "geml-zeroconf-"));
  const dotDir = join(root, "dot");
  const rootDir = join(root, "logseq");

  for (const g of graphs) {
    mkdirSync(join(rootDir, "graphs", g), { recursive: true });
  }
  if (openGraph) {
    writeFileSync(join(rootDir, "graphs", openGraph, "db-worker.lock"), "{}");
  }
  if (settings) {
    mkdirSync(join(dotDir, "settings"), { recursive: true });
    writeFileSync(join(dotDir, "settings", `${PLUGIN_ID}.json`), JSON.stringify(settings));
  }

  // The fake app CLI records its argv and writes fixture EDN to --file.
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const impl = join(root, "app-cli-impl.mjs");
  writeFileSync(
    impl,
    `import { writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.RECORD_ARGV_PATH, JSON.stringify(args));
appendFileSync(process.env.RECORD_ARGV_PATH + ".all", JSON.stringify(args) + "\\n");
// Only an export writes a file; import and backup take no --file.
if (args.includes("--file")) {
  writeFileSync(args[args.indexOf("--file") + 1], process.env.FAKE_EDN);
}
`
  );
  const shim = join(binDir, "logseq");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(shim, 0o755);

  return {
    root,
    dotDir,
    rootDir,
    argvRecord: join(root, "argv.json"),
    env: {
      ...process.env,
      PATH: [binDir, SAFE_PATH].join(":"),
      HOME: root,
      // HOME is a throwaway directory, so there is no ~/.gitconfig to inherit.
      GIT_AUTHOR_NAME: "geml test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "geml test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      LOGSEQ_DOTDIR: dotDir,
      LOGSEQ_ROOT_DIR: rootDir,
      RECORD_ARGV_PATH: join(root, "argv.json"),
      FAKE_EDN: FIXTURE_EDN,
      // Never inherit a real developer token into a fixture run.
      LOGSEQ_API_SERVER_TOKEN: "",
      LOGSEQ_APP_CLI: "",
    },
  };
}

/** The same installation, on a machine where git has no author configured. */
function withoutGitIdentity(site) {
  const env = { ...site.env };
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    delete env[k];
  }
  // Pointing at a missing file is not enough: git then invents an identity
  // from username@hostname and commits anyway. useConfigOnly is what a real
  // machine looks like when commits genuinely cannot be made.
  const cfg = join(site.root, "gitconfig-no-identity");
  writeFileSync(cfg, "[user]\n\tuseConfigOnly = true\n");
  env.GIT_CONFIG_GLOBAL = cfg;
  env.GIT_CONFIG_SYSTEM = join(site.root, "no-such-gitconfig");
  return env;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8", env });
}

function run() {
  test("geml-sync with NO arguments: vault from plugin settings, graph and signal found", () => {
    const site = installation({ settings: { vaultPath: null } });
    const vault = join(site.root, "vault");
    writeFileSync(
      join(site.dotDir, "settings", `${PLUGIN_ID}.json`),
      JSON.stringify({ vaultPath: vault })
    );
    try {
      const res = runCli(["--once"], site.env);
      assert.equal(res.status, 0, `expected a clean run, got:\n${res.stderr}`);
      assert.ok(existsSync(join(vault, "graph.geml")), "the vault from settings was not written");

      // The signal/status bridge must be found without --signal being typed.
      const status = join(site.dotDir, "storages", PLUGIN_ID, STATUS_FILE);
      assert.ok(existsSync(status), "status file was not written to the plugin storage dir");
      assert.equal(JSON.parse(readFileSync(status, "utf8")).graph, "Demo");

      // And it exported through the app CLI it found on PATH.
      const argv = JSON.parse(readFileSync(site.argvRecord, "utf8"));
      assert.deepEqual(argv.slice(0, 2), ["graph", "export"]);
      assert.equal(argv[argv.indexOf("--graph") + 1], "Demo");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("a vault directory as the single argument overrides the settings file", () => {
    const site = installation({ settings: { vaultPath: join("/should", "not", "be", "used") } });
    const vault = join(site.root, "explicit-vault");
    try {
      const res = runCli([vault, "--once"], site.env);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(existsSync(join(vault, "graph.geml")));
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("the legacy two-argument form still means <graph> <vault>", () => {
    const site = installation({ graphs: ["Demo", "Work"], openGraph: "Demo" });
    const vault = join(site.root, "legacy-vault");
    try {
      const res = runCli(["Work", vault, "--once"], site.env);
      assert.equal(res.status, 0, res.stderr);
      const argv = JSON.parse(readFileSync(site.argvRecord, "utf8"));
      assert.equal(
        argv[argv.indexOf("--graph") + 1],
        "Work",
        "an explicit graph name must beat the open-graph detection"
      );
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("a lone argument that is a graph name, not a path, is refused rather than made a folder", () => {
    const site = installation();
    try {
      const res = runCli(["Demo", "--once"], site.env);
      assert.equal(res.status, 2, "a bare graph name as the vault is almost certainly a mistake");
      assert.match(res.stderr, /Demo/);
      assert.match(res.stderr, /--graph|vault/i);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("no vault anywhere: says where to set it instead of inventing one", () => {
    const site = installation();
    try {
      const res = runCli(["--once"], site.env);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /vault/i);
      assert.match(res.stderr, /settings|Sync Vault with GEML/i);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("several graphs and none open: lists the candidates rather than picking one", () => {
    const site = installation({ graphs: ["Demo", "Work"], openGraph: null });
    const vault = join(site.root, "vault");
    try {
      const res = runCli([vault, "--once"], site.env);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Demo/);
      assert.match(res.stderr, /Work/);
      assert.match(res.stderr, /--graph/);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("a graph name that is not on disk is refused — the app CLI would CREATE it", () => {
    const site = installation({ graphs: ["Demo", "Work"], openGraph: "Demo" });
    const vault = join(site.root, "vault");
    try {
      for (const args of [["--graph", "Typo", vault], ["Typo", vault]]) {
        const res = runCli([...args, "--once"], site.env);
        assert.equal(res.status, 2, `"Typo" must not reach the exporter: ${res.stdout}`);
        assert.match(res.stderr, /Typo/);
        assert.match(res.stderr, /Demo/, "should list the graphs that do exist");
      }
      assert.ok(!existsSync(join(site.rootDir, "graphs", "Typo")), "must not create the graph");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("a plain directory is left plain — no repository appears uninvited", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    try {
      const res = runCli([vault, "--once"], site.env);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(existsSync(join(vault, "graph.geml")));
      assert.ok(
        !existsSync(join(vault, ".git")),
        "the vault may be inside Dropbox or iCloud; creating a repo there is not ours to decide"
      );
      assert.match(res.stdout + res.stderr, /git init|--git-commit/i, "should say how to get history");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("a directory that is already a repository gets its commit, unasked", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    mkdirSync(vault, { recursive: true });
    spawnSync("git", ["-C", vault, "init", "-q"], { encoding: "utf8" });
    try {
      const res = runCli([vault, "--once"], site.env);
      assert.equal(res.status, 0, res.stderr);
      const log = spawnSync("git", ["-C", vault, "log", "--oneline"], { encoding: "utf8" });
      assert.match(log.stdout, /sync graph/, `expected a sync commit, got:\n${log.stdout}`);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("--git-commit is the explicit ask, and only then is a repository created", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    try {
      const res = runCli([vault, "--once", "--git-commit"], site.env);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(existsSync(join(vault, ".git")), "--git-commit was asked for explicitly");
      const log = spawnSync("git", ["-C", vault, "log", "--oneline"], { encoding: "utf8" });
      assert.match(log.stdout, /sync graph/);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("pages removed from the graph are kept, and reported, unless --mirror says otherwise", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    try {
      assert.equal(runCli([vault, "--once"], site.env).status, 0);
      assert.ok(existsSync(join(vault, "pages", "page-alpha.geml")));

      // The graph loses the page. Default: the file stays.
      const shrunk = FIXTURE_EDN_MINUS_ALPHA;
      const keep = runCli([vault, "--once"], { ...site.env, FAKE_EDN: shrunk });
      assert.equal(keep.status, 0, keep.stderr);
      assert.ok(
        existsSync(join(vault, "pages", "page-alpha.geml")),
        "a deleted page must not vanish from a vault that has no history to recover it from"
      );
      assert.match(keep.stdout + keep.stderr, /orphan|absent/i, "the divergence has to be visible");

      // --mirror is how you ask for an exact copy instead.
      const mirror = runCli([vault, "--once", "--mirror"], { ...site.env, FAKE_EDN: shrunk });
      assert.equal(mirror.status, 0, mirror.stderr);
      assert.ok(
        !existsSync(join(vault, "pages", "page-alpha.geml")),
        "--mirror propagates the deletion"
      );
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("a git commit that fails is reported, never swallowed", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    // No identity anywhere: HOME is a throwaway dir with no .gitconfig, and the
    // GIT_* vars the other fixtures rely on are removed. `git commit` then
    // fails with "Author identity unknown" — a machine can genuinely be in
    // this state, and a sync that says "Synced" while committing nothing is
    // the worst possible report.
    const env = withoutGitIdentity(site);
    // A repository, so a commit is genuinely attempted — that is the only case
    // where "committed nothing" is a failure rather than a deliberate skip.
    mkdirSync(vault, { recursive: true });
    spawnSync("git", ["-C", vault, "init", "-q"], { encoding: "utf8" });
    try {
      const res = runCli([vault, "--once"], env);
      const out = res.stdout + res.stderr;
      assert.ok(existsSync(join(vault, "graph.geml")), "the vault itself must still be written");
      assert.match(out, /git/i, `the git failure was swallowed:\n${out}`);
      assert.match(out, /not committed|commit failed|identity/i, `no reason given:\n${out}`);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("doctor treats a missing git identity as a blocker only when it would commit", () => {
    const site = installation();
    const vaultRepo = join(site.root, "vault-repo");
    mkdirSync(vaultRepo, { recursive: true });
    spawnSync("git", ["-C", vaultRepo, "init", "-q"], { encoding: "utf8" });
    mkdirSync(join(site.dotDir, "settings"), { recursive: true });
    writeFileSync(
      join(site.dotDir, "settings", `${PLUGIN_ID}.json`),
      JSON.stringify({ vaultPath: vaultRepo })
    );
    const env = withoutGitIdentity(site);
    try {
      const blocked = runCli(["doctor"], env);
      assert.equal(blocked.status, 1, `doctor should not call this ready:\n${blocked.stdout}`);
      assert.match(blocked.stdout, /git/i);

      // ...and not care once the user has opted out of committing.
      const opted = runCli(["doctor", "--no-git-commit"], env);
      assert.equal(opted.status, 0, `--no-git-commit removes the requirement:\n${opted.stdout}`);

      // ...nor for a plain directory, which this run would not commit into.
      const plain = runCli(["doctor", join(site.root, "plain")], env);
      assert.equal(plain.status, 0, `a non-repository needs no git identity:\n${plain.stdout}`);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("--no-git-commit leaves the directory alone", () => {
    const site = installation();
    const vault = join(site.root, "plain-vault");
    try {
      const res = runCli([vault, "--once", "--no-git-commit"], site.env);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(existsSync(join(vault, "graph.geml")));
      assert.ok(!existsSync(join(vault, ".git")), "--no-git-commit must not create a repository");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("--markdown writes a second, lossy tree for humans and other tools", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    const md = join(site.root, "md");
    try {
      const res = runCli([vault, "--once", "--markdown", md], site.env);
      assert.equal(res.status, 0, res.stderr);

      const page = join(md, "pages", "page-alpha.md");
      assert.ok(existsSync(page), "expected a .md beside every .geml");
      assert.match(readFileSync(page, "utf8"), /First block/, "the block text has to survive");

      // The GEML vault stays the lossless one; markdown is an extra, not a move.
      assert.ok(existsSync(join(vault, "pages", "page-alpha.geml")));
      assert.ok(!existsSync(join(vault, "pages", "page-alpha.md")), "the two trees stay separate");
      assert.match(res.stdout, /lossy/i, "the run must say what this tree is not");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("doctor reports what it found and exits 0 when the setup is ready", () => {
    const site = installation({ settings: { vaultPath: join("/tmp", "somewhere") } });
    try {
      const res = runCli(["doctor"], site.env);
      assert.equal(res.status, 0, `doctor should pass on a complete setup:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /Demo/, "should name the graph it would sync");
      assert.match(res.stdout, /logseq/, "should name the app CLI it found");
      assert.match(res.stdout, /somewhere/, "should name the vault it would write to");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("doctor exits 1 and names the blocker when something is missing", () => {
    const site = installation();
    try {
      const res = runCli(["doctor"], { ...site.env, PATH: SAFE_PATH });
      assert.equal(res.status, 1, "a setup that cannot sync must not report success");
      const out = res.stdout + res.stderr;
      assert.match(out, /vault/i);
      assert.match(out, /CLI|Logseq/i);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("restore only rehearses until told otherwise", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    try {
      assert.equal(runCli([vault, "--once"], site.env).status, 0);
      rmSync(site.argvRecord + ".all", { force: true });

      const res = runCli(["restore", vault], site.env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /--yes/, "a dry run has to say how to make it real");
      assert.match(res.stdout, /Demo/, "and which graph it would write into");
      assert.ok(
        !existsSync(site.argvRecord + ".all"),
        "a rehearsal must not touch the graph at all"
      );
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("restore --yes backs the graph up before importing over it", () => {
    const site = installation();
    const vault = join(site.root, "vault");
    try {
      assert.equal(runCli([vault, "--once"], site.env).status, 0);
      rmSync(site.argvRecord + ".all", { force: true });

      const res = runCli(["restore", vault, "--yes"], site.env);
      assert.equal(res.status, 0, res.stderr);

      const calls = readFileSync(site.argvRecord + ".all", "utf8")
        .trim().split("\n").map((l) => JSON.parse(l));
      const backup = calls.findIndex((c) => c[0] === "graph" && c[1] === "backup");
      const imported = calls.findIndex((c) => c[0] === "graph" && c[1] === "import");
      assert.ok(backup >= 0, `no backup was taken: ${JSON.stringify(calls)}`);
      assert.ok(imported >= 0, `nothing was imported: ${JSON.stringify(calls)}`);
      assert.ok(backup < imported, "the backup is worthless after the import");
      assert.equal(calls[imported][calls[imported].indexOf("--graph") + 1], "Demo");
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  test("restore refuses a vault with no pages in it", () => {
    const site = installation();
    try {
      const res = runCli(["restore", join(site.root, "not-a-vault"), "--yes"], site.env);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /no page|empty|not a vault/i);
    } finally {
      rmSync(site.root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} zero-config tests passed.`);
}

if (process.platform === "win32") {
  console.log("# skipped zero-config tests: the fixture app CLI needs a POSIX shebang shim");
} else {
  run();
}
