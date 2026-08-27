// Tests for the incremental sync engine and Git workflow.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, addressedUnits, sliceUnit } from "../../../../geml-parser/dist/geml.js";
const lib = { parse, addressedUnits, sliceUnit };
import {
  readGemlFilesFromDisk,
  writeGemlFilesToDisk,
  gitAutoCommit,
  syncEdnToDisk,
  syncDiskToEdn,
  normalizeEol,
} from "../src/sync-engine.mjs";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok", name);
}

const FIXTURE_EDN = `
{:properties {:user.property/tag {:logseq.property/type :default}}
 :classes {}
 :pages-and-blocks
 [{:page {:block/title "Page Alpha"}
   :blocks [{:block/title "First block"
             :block/uuid #uuid "11111111-2222-3333-4444-555555555555"}]}
  {:page {:block/title "Page Beta"}
   :blocks [{:block/title "Second block"}]}]}
`;

async function run() {
  await test("incremental write: initial write creates all files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "logseq-sync-test-"));
    try {
      const files = new Map([
        ["pages/p1.geml", "=== text\nHello P1\n===\n"],
        ["pages/p2.geml", "=== text\nHello P2\n===\n"],
      ]);

      const res = writeGemlFilesToDisk(files, tmp);
      assert.equal(res.written.length, 2);
      assert.equal(res.unchanged.length, 0);
      assert.equal(res.deleted.length, 0);

      const readBack = readGemlFilesFromDisk(tmp);
      assert.equal(readBack.size, 2);
      assert.equal(readBack.get("pages/p1.geml"), files.get("pages/p1.geml"));
      assert.equal(readBack.get("pages/p2.geml"), files.get("pages/p2.geml"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("incremental write: identical rerun does not touch files (clean for git)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "logseq-sync-test-"));
    try {
      const files = new Map([
        ["pages/p1.geml", "=== text\nHello P1\n===\n"],
        ["pages/p2.geml", "=== text\nHello P2\n===\n"],
      ]);

      writeGemlFilesToDisk(files, tmp);
      const res2 = writeGemlFilesToDisk(files, tmp);
      assert.equal(res2.written.length, 0);
      assert.equal(res2.unchanged.length, 2);
      assert.equal(res2.deleted.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("incremental write: editing 1 page writes exactly that 1 file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "logseq-sync-test-"));
    try {
      const files = new Map([
        ["pages/p1.geml", "=== text\nHello P1\n===\n"],
        ["pages/p2.geml", "=== text\nHello P2\n===\n"],
      ]);
      writeGemlFilesToDisk(files, tmp);

      const filesUpdated = new Map([
        ["pages/p1.geml", "=== text\nHello P1 Updated\n===\n"],
        ["pages/p2.geml", "=== text\nHello P2\n===\n"],
      ]);

      const res = writeGemlFilesToDisk(filesUpdated, tmp);
      assert.deepEqual(res.written, ["pages/p1.geml"]);
      assert.deepEqual(res.unchanged, ["pages/p2.geml"]);
      assert.equal(res.deleted.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("incremental write: deleted page is reported as orphaned by default (non-destructive)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "logseq-sync-test-"));
    try {
      const files = new Map([
        ["pages/p1.geml", "=== text\nHello P1\n===\n"],
        ["pages/p2.geml", "=== text\nHello P2\n===\n"],
      ]);
      writeGemlFilesToDisk(files, tmp);

      // Page p2 is absent in the new export
      const filesWithDeleted = new Map([
        ["pages/p1.geml", "=== text\nHello P1\n===\n"],
      ]);

      // By default: report only, do not unlink
      const resSafe = writeGemlFilesToDisk(filesWithDeleted, tmp);
      assert.equal(resSafe.written.length, 0);
      assert.deepEqual(resSafe.orphaned, ["pages/p2.geml"]);
      assert.equal(resSafe.deleted.length, 0);
      assert.equal(existsSync(join(tmp, "pages/p2.geml")), true);

      // With explicit deleteOrphans: true
      const resDelete = writeGemlFilesToDisk(filesWithDeleted, tmp, { deleteOrphans: true });
      assert.deepEqual(resDelete.deleted, ["pages/p2.geml"]);
      assert.equal(existsSync(join(tmp, "pages/p2.geml")), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("full pipeline: syncEdnToDisk -> syncDiskToEdn round trip", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "logseq-sync-test-"));
    try {
      const exportRes = await syncEdnToDisk(FIXTURE_EDN, tmp);
      assert.ok(exportRes.written.length > 0);

      const ednBack = syncDiskToEdn(tmp, lib);
      assert.ok(ednBack.includes("Page Alpha"));
      assert.ok(ednBack.includes("Page Beta"));
      assert.ok(ednBack.includes("11111111-2222-3333-4444-555555555555"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("gitAutoCommit: commits changes in a git repository", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "logseq-sync-git-"));
    try {
      // Initialize a real git repo
      execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp, stdio: "ignore" });

      // First sync with autoCommit
      const res1 = await syncEdnToDisk(FIXTURE_EDN, tmp, {
        autoCommit: true,
        commitMessage: "initial sync",
      });

      assert.ok(res1.gitResult.committed);
      assert.equal(res1.gitResult.changes, true);

      // Second sync: no changes, working tree clean
      const res2 = await syncEdnToDisk(FIXTURE_EDN, tmp, {
        autoCommit: true,
        commitMessage: "second sync",
      });
      assert.equal(res2.written.length, 0);
      assert.equal(res2.gitResult, null); // No git commit triggered when zero files changed
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("git status incremental criterion: editing 1 block marks exactly 1 .geml file dirty in git", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-git-status-test-"));
    try {
      execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp, stdio: "ignore" });

      // 1. Initial full export + commit
      await syncEdnToDisk(FIXTURE_EDN, tmp, { autoCommit: true, commitMessage: "initial commit" });

      const cleanStatus = execFileSync("git", ["status", "--porcelain"], { cwd: tmp, encoding: "utf8" }).trim();
      assert.equal(cleanStatus, "", "Working tree should be clean after initial sync");

      // 2. Edit 1 block in Page Alpha
      const editedEdn = FIXTURE_EDN.replace("First block", "First block with an edit");
      const res = await syncEdnToDisk(editedEdn, tmp, { autoCommit: false });

      assert.deepEqual(res.written, ["pages/page-alpha.geml"]);
      assert.ok(res.unchanged.includes("pages/page-beta.geml"));
      assert.ok(res.unchanged.includes("graph.geml"));
      assert.ok(res.unchanged.includes("ontology.geml"));

      // 3. Judge directly by git status --porcelain (Criterion 7)
      const gitDiffLines = execFileSync("git", ["status", "--porcelain"], { cwd: tmp, encoding: "utf8" })
        .trim()
        .split("\n")
        .map((l) => l.trim());

      assert.equal(gitDiffLines.length, 1, "Exactly one file should be dirty under git status");
      assert.ok(gitDiffLines[0].endsWith("pages/page-alpha.geml"), `Expected pages/page-alpha.geml, got ${gitDiffLines[0]}`);

      // 4. Test adding a page updates #page-order in graph.geml (Criterion 6)
      execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "commit edit"], { cwd: tmp, stdio: "ignore" });

      const withNewPage = FIXTURE_EDN.replace(
        '[{:page {:block/title "Page Alpha"}',
        '[{:page {:block/title "Page Gamma"}\n   :blocks [{:block/title "Gamma Block"}]}\n  {:page {:block/title "Page Alpha"}'
      );
      const resNewPage = await syncEdnToDisk(withNewPage, tmp, { autoCommit: false });
      assert.ok(resNewPage.written.includes("pages/page-gamma.geml"));
      assert.ok(resNewPage.written.includes("graph.geml"), "graph.geml must be rewritten to update #page-order");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("autoCommit isolation: does NOT commit parent repo unrelated files (Issue 1)", async () => {
    const parentTmp = mkdtempSync(join(tmpdir(), "geml-parent-repo-"));
    try {
      // 1. Initialize a parent git repo
      execFileSync("git", ["init"], { cwd: parentTmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: parentTmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: parentTmp, stdio: "ignore" });

      // 2. User has an unrelated, uncommitted or staged file in the parent repo
      const unrelatedFile = join(parentTmp, "my-thesis.txt");
      writeFileSync(unrelatedFile, "my private uncommitted notes\n");

      // Stage the unrelated file to test extreme edge case
      execFileSync("git", ["add", "my-thesis.txt"], { cwd: parentTmp, stdio: "ignore" });

      // 3. Subdirectory used as sync target
      const syncTarget = join(parentTmp, "geml-notes");

      // 4. Run sync with autoCommit: true
      const syncRes = await syncEdnToDisk(FIXTURE_EDN, syncTarget, {
        autoCommit: true,
        commitMessage: "automated geml sync",
      });

      assert.ok(syncRes.gitResult.committed, "Sync should successfully commit");

      // 5. Inspect the latest commit to verify what files were committed
      const committedFiles = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
        cwd: parentTmp,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);

      // Every committed file MUST be inside geml-notes/
      for (const file of committedFiles) {
        assert.ok(
          file.startsWith("geml-notes/"),
          `Parent repo file "${file}" was improperly swept into the auto-commit!`
        );
      }
      assert.ok(!committedFiles.includes("my-thesis.txt"), "my-thesis.txt MUST NOT be in the commit!");

      // 6. Verify my-thesis.txt remains staged/present in working tree
      const remainingStatus = execFileSync("git", ["status", "--porcelain"], { cwd: parentTmp, encoding: "utf8" });
      assert.ok(remainingStatus.includes("my-thesis.txt"), "my-thesis.txt must remain staged in parent working tree");
    } finally {
      rmSync(parentTmp, { recursive: true, force: true });
    }
  });

  await test("empty EDN guard: syncEdnToDisk throws on empty or truncated input (Issue 4)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-guard-test-"));
    try {
      // 1. Initial write
      await syncEdnToDisk(FIXTURE_EDN, tmp);
      assert.ok(existsSync(join(tmp, "pages/page-alpha.geml")));

      // 2. Attempt sync with empty string
      await assert.rejects(
        async () => {
          await syncEdnToDisk("", tmp);
        },
        /empty or truncated/,
        "Must reject empty string"
      );

      // 3. Attempt sync with whitespace string
      await assert.rejects(
        async () => {
          await syncEdnToDisk("   \n\t  ", tmp);
        },
        /empty or truncated/,
        "Must reject whitespace-only string"
      );

      // 4. Attempt sync with 0 pages over existing graph without allowEmptyGraph
      const emptyGraphEdn = "{:properties {} :classes {} :pages-and-blocks []}";
      await assert.rejects(
        async () => {
          await syncEdnToDisk(emptyGraphEdn, tmp);
        },
        /Refusing to sync empty graph/,
        "Must refuse 0-page sync over non-empty directory"
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("deleteOrphans protection: user-authored files in target dir are NEVER deleted (Issue 5)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-user-file-test-"));
    try {
      // 1. Initial sync of fixture
      await syncEdnToDisk(FIXTURE_EDN, tmp);

      // 2. User writes their own file in the target directory
      const userFile = join(tmp, "my-custom-note.geml");
      writeFileSync(userFile, "=== text\nMy custom handwritten note\n===\n", "utf8");

      // 3. Second sync with deleteOrphans: true
      const res = await syncEdnToDisk(FIXTURE_EDN, tmp, { deleteOrphans: true });

      // 4. Verify user file is NOT deleted
      assert.ok(existsSync(userFile), "User-authored file must never be deleted by deleteOrphans!");
      assert.ok(res.orphaned.includes("my-custom-note.geml"), "User file is reported as orphaned but not deleted");
      assert.ok(!res.deleted.includes("my-custom-note.geml"), "User file must not be in deleted list");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test("normalizeEol handles CRLF and lone CR (Issue 9)", () => {
    assert.equal(normalizeEol("a\r\nb\rc\nd"), "a\nb\nc\nd");
  });

  console.log(`\n${passed} sync engine tests passed.`);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
