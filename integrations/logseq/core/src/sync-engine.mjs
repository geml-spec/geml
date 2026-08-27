// Core Sync Engine for Logseq GEML
// Keeps a local folder of .geml files in sync with a Logseq DB graph,
// ensuring only changed files are written so Git diffs stay clean.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { ednToGemlFiles, gemlFilesToEdn } from "./mapping.mjs";

const MANIFEST_FILE = ".geml-manifest.json";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Read the sync manifest in either of its two shapes.
 * v1 was a sorted array of paths — enough to know which files the sync owns.
 * v2 ({ version: 2, files: { rel: sha256 } }) also records the content the
 * sync last wrote or saw, which is what lets two-way sync tell an external
 * edit from its own echo: a file whose hash matches the manifest is the
 * watcher's own last write, not something a person or agent changed.
 * @returns {{ known: boolean, hashed: boolean, files: Map<string, string|null> }}
 */
function readManifest(targetDir) {
  const manifestPath = join(targetDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { known: false, hashed: false, files: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (Array.isArray(parsed)) {
      return { known: true, hashed: false, files: new Map(parsed.map((p) => [p, null])) };
    }
    if (parsed && parsed.version === 2 && parsed.files && typeof parsed.files === "object") {
      return { known: true, hashed: true, files: new Map(Object.entries(parsed.files)) };
    }
  } catch {}
  return { known: false, hashed: false, files: new Map() };
}

/**
 * What changed in the vault since the sync last touched it — the read side of
 * the two-way bridge. Baselines come from the v2 manifest hashes; a v1
 * manifest (or none) knows which files exist but not what they held, so it
 * reports nothing rather than guessing: `baselineKnown: false` means "sync
 * once first".
 *
 * With `graphFiles` (the current export, as ednToGemlFiles returns it) the
 * vault-modified files are split further: one the GRAPH also moved since the
 * last sync is a `conflict` — importing it would clobber the graph's edit,
 * exporting over it would clobber the person's, so two-way sync does neither
 * and a person merges.
 * @param {string} targetDir
 * @param {{ graphFiles?: Map<string, string> }} [opts]
 * @returns {{ baselineKnown: boolean, modified: string[], added: string[], missing: string[], conflicts: string[] }}
 */
export function detectExternalEdits(targetDir, opts = {}) {
  const manifest = readManifest(targetDir);
  const onDisk = readGemlFilesFromDisk(targetDir);
  const modified = [];
  const added = [];
  const missing = [];
  const conflicts = [];
  if (!manifest.hashed) return { baselineKnown: false, modified, added, missing, conflicts };
  for (const [rel, hash] of manifest.files) {
    const content = onDisk.get(rel);
    if (content === undefined) missing.push(rel);
    else if (hash !== null && sha256(content) !== hash) {
      const graphContent = opts.graphFiles?.get(rel);
      const graphMoved =
        graphContent !== undefined && sha256(normalizeEol(graphContent)) !== hash;
      (graphMoved ? conflicts : modified).push(rel);
    }
  }
  for (const rel of onDisk.keys()) {
    if (!manifest.files.has(rel)) added.push(rel);
  }
  return {
    baselineKnown: true,
    modified: modified.sort(),
    added: added.sort(),
    missing: missing.sort(),
    conflicts: conflicts.sort(),
  };
}

/**
 * Normalize line endings to LF, handling CRLF (\r\n) and lone CR (\r).
 */
export function normalizeEol(str) {
  return typeof str === "string" ? str.replace(/\r\n?/g, "\n") : str;
}

/**
 * Atomically write a file via a temporary file in the same directory.
 */
export function atomicWriteFileSync(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${Date.now()}-${process.pid}-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

/**
 * Remove empty parent directories recursively up to stopDir.
 */
function cleanEmptyParents(dir, stopDir) {
  let current = resolve(dir);
  const stop = resolve(stopDir);
  while (current && current !== stop && current.startsWith(stop)) {
    try {
      const remaining = readdirSync(current);
      if (remaining.length === 0) {
        rmdirSync(current);
        current = dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Scan a directory recursively for all .geml files.
 * @param {string} dir Root directory to scan.
 * @param {string} [baseDir] Base directory for computing relative paths.
 * @returns {Map<string, string>} Map of relative path (POSIX style) -> file content (normalized LF).
 */
export function readGemlFilesFromDisk(dir, baseDir = dir) {
  const files = new Map();
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Ignore .git, node_modules, and hidden directories
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const subFiles = readGemlFilesFromDisk(fullPath, baseDir);
      for (const [rel, content] of subFiles) {
        files.set(rel, content);
      }
    } else if (entry.isFile() && entry.name.endsWith(".geml")) {
      const rel = relative(baseDir, fullPath).split(sep).join("/");
      files.set(rel, normalizeEol(readFileSync(fullPath, "utf8")));
    }
  }
  return files;
}

/**
 * Incrementally sync a Map of GEML files to disk.
 * Only writes files whose content has changed or do not yet exist.
 * Detects files on disk that are absent from the export (e.g. deleted pages or journals),
 * and reports them without destructive deletion by default.
 * 
 * Safety note: @logseq/cli 0.4.3 does not include journals in export-edn.
 * Manifest-based orphan tracking ensures user-authored files outside previous syncs are never deleted.
 * Destructive deletion requires explicit `opts.deleteOrphans === true`.
 * 
 * @param {Map<string, string>} gemlFiles Map of relative path (POSIX) -> gemlText.
 * @param {string} targetDir Local destination directory.
 * @param {object} [opts]
 * @param {boolean} [opts.deleteOrphans=false] Whether to delete previous-sync .geml files no longer in graph.
 * @param {string[]} [opts.preserve] Files NOT to overwrite even when the graph
 *   differs — the conflicted files of a two-way cycle. Their manifest entry
 *   keeps its previous hash, so they stay flagged until a person resolves them.
 * @returns {{ written: string[], orphaned: string[], unchanged: string[], deleted: string[], preserved: string[] }}
 */
export function writeGemlFilesToDisk(gemlFiles, targetDir, opts = {}) {
  const deleteOrphans = opts.deleteOrphans ?? false;
  const preserve = new Set(opts.preserve ?? []);
  const written = [];
  const unchanged = [];
  const orphaned = [];
  const deleted = [];
  const preserved = [];

  mkdirSync(targetDir, { recursive: true });
  const existingFiles = readGemlFilesFromDisk(targetDir);

  // Load previous sync manifest to know which files belong to sync vs user-authored files
  const manifestPath = join(targetDir, MANIFEST_FILE);
  const previous = readManifest(targetDir);
  const lastManifest = new Set(previous.files.keys());

  // Write new or updated files atomically with CRLF normalization
  for (const [rel, newContent] of gemlFiles) {
    const fullPath = join(targetDir, rel);
    const normNew = normalizeEol(newContent);
    const existingContent = existingFiles.get(rel);

    if (preserve.has(rel)) {
      if (existingContent !== normNew) preserved.push(rel);
      else unchanged.push(rel);
    } else if (existingContent === undefined || existingContent !== normNew) {
      atomicWriteFileSync(fullPath, normNew);
      written.push(rel);
    } else {
      unchanged.push(rel);
    }
  }

  // Detect files present on disk but absent from current graph export
  for (const [rel] of existingFiles) {
    if (!gemlFiles.has(rel)) {
      orphaned.push(rel);
      // Safe deletion: only delete if explicit AND file was generated by previous sync
      // User-authored files in targetDir not in manifest are NEVER deleted.
      if (deleteOrphans && lastManifest.has(rel)) {
        const fullPath = join(targetDir, rel);
        if (existsSync(fullPath)) {
          unlinkSync(fullPath);
          cleanEmptyParents(dirname(fullPath), targetDir);
          deleted.push(rel);
        }
      }
    }
  }

  // Save updated manifest of managed sync files: all current gemlFiles, plus
  // any existing files on disk that were in lastManifest and not deleted.
  // v2 records each file's content hash AS OF THIS SYNC — the baseline
  // detectExternalEdits() compares against, so the watcher's own writes never
  // read as someone else's edits.
  const currentManifest = new Set(gemlFiles.keys());
  for (const rel of lastManifest) {
    if (existingFiles.has(rel) && !deleted.includes(rel)) {
      currentManifest.add(rel);
    }
  }
  const manifestFiles = {};
  for (const rel of [...currentManifest].sort()) {
    if (preserved.includes(rel)) {
      // A conflicted file keeps its OLD baseline: recording what sits on disk
      // now would make the person's unmerged edit read as "already synced" on
      // the next cycle, and the conflict would be silently forgotten.
      manifestFiles[rel] = previous.files.get(rel) ?? null;
      continue;
    }
    const content = gemlFiles.has(rel) ? normalizeEol(gemlFiles.get(rel)) : existingFiles.get(rel);
    manifestFiles[rel] = content === undefined ? null : sha256(content);
  }
  atomicWriteFileSync(manifestPath, JSON.stringify({ version: 2, files: manifestFiles }, null, 1) + "\n");

  return { written, orphaned, unchanged, deleted, preserved };
}

/**
 * Execute Git commands to commit changes scoped strictly to the synced files.
 * Protects parent repository from having unrelated files swept into the commit.
 * 
 * @param {string} targetDir Directory where the sync target lives.
 * @param {string} commitMessage Commit message.
 * @param {string[]} pathsToCommit Relative paths within targetDir that were written or deleted.
 * @param {function} [gitRunner] Optional custom git runner `(args) => Promise<{ stdout, stderr, exitCode }>`.
 * @returns {Promise<{ committed: boolean, changes: boolean, output: string }>}
 */
export async function gitAutoCommit(targetDir, commitMessage = "logseq-geml sync", pathsToCommit = [], gitRunner = null) {
  const defaultRunner = async (args) => {
    try {
      const stdout = execFileSync("git", args, {
        cwd: targetDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err) {
      return {
        stdout: err.stdout ? String(err.stdout) : "",
        stderr: err.stderr ? String(err.stderr) : err.message,
        exitCode: err.status || 1,
      };
    }
  };

  const run = gitRunner || defaultRunner;

  // Check if targetDir is inside a git repository
  const revRes = await run(["rev-parse", "--show-toplevel"]);
  if (revRes.exitCode !== 0) {
    return {
      committed: false,
      changes: false,
      output: `Not a git repository: ${revRes.stderr.trim()}`,
    };
  }

  if (!pathsToCommit || pathsToCommit.length === 0) {
    return {
      committed: false,
      changes: false,
      output: "No synced paths to commit.",
    };
  }

  // Always include the manifest file in staged paths
  const allPaths = [...new Set([...pathsToCommit, MANIFEST_FILE])];

  // Stage ONLY the specified paths (never a bare git add -A)
  // Split into existing files vs deleted files
  const toAdd = allPaths.filter((p) => existsSync(join(targetDir, p)));
  const toRemove = allPaths.filter((p) => !existsSync(join(targetDir, p)));

  if (toAdd.length > 0) {
    const addRes = await run(["add", "--", ...toAdd]);
    if (addRes.exitCode !== 0) {
      return { committed: false, changes: true, output: `git add failed: ${addRes.stderr}` };
    }
  }

  if (toRemove.length > 0) {
    const rmRes = await run(["add", "-u", "--", ...toRemove]);
    if (rmRes.exitCode !== 0) {
      return { committed: false, changes: true, output: `git update index failed: ${rmRes.stderr}` };
    }
  }

  // Verify whether our target paths have staged changes
  const statusRes = await run(["status", "--porcelain", "--", ...allPaths]);
  if (statusRes.exitCode !== 0 || statusRes.stdout.trim().length === 0) {
    return {
      committed: false,
      changes: false,
      output: "No changes in target paths to commit.",
    };
  }

  // Commit with pathspec: commits ONLY changes matching our synced paths,
  // leaving any other staged or unstaged changes in parent repository untouched!
  const commitRes = await run(["commit", "-m", commitMessage, "--", ...allPaths]);
  if (commitRes.exitCode !== 0) {
    return {
      committed: false,
      changes: true,
      output: `git commit failed: ${commitRes.stderr}`,
    };
  }

  return {
    committed: true,
    changes: true,
    output: commitRes.stdout.trim(),
  };
}

/**
 * Full Sync Pipeline from EDN string to disk.
 * 
 * @param {string} ednText EDN string (from logseq export-edn).
 * @param {string} targetDir Destination folder.
 * @param {object} [opts]
 * @param {boolean} [opts.autoCommit=false]
 * @param {string} [opts.commitMessage]
 * @param {boolean} [opts.allowEmptyGraph=false] Refuse 0-page export over non-empty targetDir unless true.
 * @param {function} [opts.gitRunner]
 * @returns {Promise<{ written: string[], deleted: string[], orphaned: string[], unchanged: string[], gitResult?: any }>}
 */
export async function syncEdnToDisk(ednText, targetDir, opts = {}) {
  // Guard 1: Refuse empty or truncated EDN input
  if (!ednText || typeof ednText !== "string" || ednText.trim().length === 0) {
    throw new Error("EDN input is empty or truncated; refusing to sync to prevent data loss.");
  }

  const gemlFiles = ednToGemlFiles(ednText);

  // Guard 2: Refuse 0-page export if targetDir already has existing pages
  const pageCount = [...gemlFiles.keys()].filter((k) => k.startsWith("pages/") || k.startsWith("journals/")).length;
  const existingFiles = readGemlFilesFromDisk(targetDir);
  const existingPageCount = [...existingFiles.keys()].filter((k) => k.startsWith("pages/") || k.startsWith("journals/")).length;

  if (pageCount === 0 && existingPageCount > 0 && !opts.allowEmptyGraph) {
    throw new Error(
      `Refusing to sync empty graph (0 pages) over directory with existing pages (${existingPageCount} pages). Pass allowEmptyGraph: true to force.`
    );
  }

  const diffResult = writeGemlFilesToDisk(gemlFiles, targetDir, opts);

  // A parallel Markdown tree, for people and tools that read Markdown and
  // nothing else. Deliberately lossy and deliberately separate: the GEML tree
  // stays the one that round-trips. The converter is injected, so this module
  // keeps its single dependency.
  const markdownWritten = [];
  if (opts.markdownDir && typeof opts.gemlToMd === "function") {
    for (const [rel, content] of gemlFiles) {
      const mdRel = rel.replace(/\.geml$/, ".md");
      const full = join(opts.markdownDir, mdRel);
      let md;
      try {
        md = normalizeEol(opts.gemlToMd(content));
      } catch {
        continue; // one unconvertible document must not fail the sync
      }
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full) || readFileSync(full, "utf8") !== md) {
        atomicWriteFileSync(full, md);
        markdownWritten.push(mdRel);
      }
    }
  }

  let gitResult = null;
  const pathsModified = [...diffResult.written, ...diffResult.deleted];
  for (const rel of markdownWritten) {
    const abs = join(opts.markdownDir, rel);
    const insideVault = relative(targetDir, abs);
    if (insideVault && !insideVault.startsWith("..") && !isAbsolute(insideVault)) {
      pathsModified.push(insideVault);
    }
  }

  if (opts.autoCommit && pathsModified.length > 0) {
    const msg = opts.commitMessage || `logseq-geml: synced ${diffResult.written.length} modified, ${diffResult.deleted.length} deleted`;
    gitResult = await gitAutoCommit(targetDir, msg, pathsModified, opts.gitRunner);
  }

  return {
    ...diffResult,
    markdownWritten,
    gitResult,
  };
}

/**
 * Full Sync Pipeline from disk back to EDN string.
 *
 * @param {string} targetDir Local folder containing .geml files.
 * @param {object} lib Parser library containing { parse, addressedUnits, sliceUnit }.
 * @param {{ exclude?: string[] }} [opts] Files to leave OUT of the import —
 *   the conflicted files of a two-way cycle: absent from the EDN means the
 *   graph's version stays untouched (import merges by uuid, it never deletes).
 * @returns {string} EDN string ready for logseq import-edn.
 */
export function syncDiskToEdn(targetDir, lib, opts = {}) {
  const files = readGemlFilesFromDisk(targetDir);
  for (const rel of opts.exclude ?? []) files.delete(rel);
  return gemlFilesToEdn(files, lib);
}
