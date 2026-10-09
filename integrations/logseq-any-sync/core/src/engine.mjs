// The sync engine. It keeps a vault of GEML pages in step with an app through
// an adapter, and it does not know which app: the app is one more replica of
// each document. Its changes are recorded in the document's change graph
// (`.gemlhistory`) as changes by the adapter, local edits as changes by the
// vault, and the graph's replay decides the merged document — the edit later
// in its order wins where both sides touched one block, and that is reported.
//
// One object, one cycle:
//   1. local edits      — the page differs from its history: save them
//   2. the app's state  — when the app moved: record it after the change the
//                         app last held (`appHead`)
//   3. merge            — join the heads, write the merged page
//   4. push             — when the merged head is not what the app holds;
//                         a conflict (the app moved meanwhile) goes back to 2
//   5. read back        — record what the app now holds (ids it minted)
//   6. state, index, git

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "@geml/geml";
import { save, isCurrent, recordReplica, mergeHeads } from "@geml/geml/dist/history.js";
import * as V from "./vault.mjs";
import { exportMarkdown } from "./markdown.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const readText = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const historyOf = (file) => file.replace(/\.geml$/, ".gemlhistory");

/**
 * @typedef {object} Report
 * @property {string[]} pulled     pages that took the app's changes
 * @property {string[]} pushed     pages whose edits reached the app
 * @property {string[]} created    pages made from new app objects
 * @property {string[]} published  new vault pages created in the app
 * @property {{ file: string, why: string }[]} held  pages left alone, and why
 * @property {string[]} lost       edits that lost to a concurrent one (they stay in the history)
 * @property {{ file: string, ops: object[] }[]} planned  dry run: what would be sent
 * @property {string[]} written    vault-relative paths written
 */

/**
 * One sync cycle.
 * @param {{ vault: string, adapter: object, dryRun?: boolean, author?: string,
 *           commit?: boolean, markdownDir?: string, now?: () => Date }} o
 * @returns {Promise<Report>}
 */
export async function syncOnce(o) {
  const { vault, adapter } = o;
  const dry = !!o.dryRun;
  const author = o.author ?? "vault";
  const now = o.now ?? (() => new Date());
  const report = { pulled: [], pushed: [], created: [], published: [], held: [], lost: [], planned: [], written: [] };
  const state = V.readState(vault);
  const files = state.files;
  const byRef = new Map(Object.entries(files).map(([rel, e]) => [e.ref, rel]));
  const write = (rel, text) => { if (!dry) { V.atomicWrite(join(vault, rel), text); report.written.push(rel); } };
  const recorded = new Set(); // change ids recorded this cycle, to report only new losses

  // Which objects to look at: the ones the app moved, and the ones the vault moved.
  const listing = await adapter.changedSince(state.cursor || 0);
  const names = new Map(listing.changed.map((c) => [c.ref, c]));
  const todo = new Set(listing.changed.map((c) => c.ref));
  const local = [];
  for (const rel of V.pageFiles(vault)) {
    const e = files[rel];
    if (!e) { local.push(rel); continue; }
    const file = join(vault, rel);
    if (!existsSync(historyOf(file)) || !isCurrent(historyOf(file), file)) todo.add(e.ref);
  }
  for (const [rel, e] of Object.entries(files)) {
    if (!existsSync(join(vault, rel))) {
      report.held.push({ file: rel, why: "deleted in the vault — not deleted in the app; restore the file or remove its entry from .geml-sync.json" });
      todo.delete(e.ref);
    }
  }

  for (const ref of todo) {
    let rel = byRef.get(ref);
    const isNew = rel === undefined;
    if (isNew) rel = V.freePagePath(vault, names.get(ref)?.name ?? ref, Object.keys(files));
    const entry = files[rel] ?? { ref, state: {} };
    const r = await syncObject({ vault, adapter, rel, entry, dry, author, now, report, write, recorded, modifiedAt: names.get(ref)?.modifiedAt });
    if (r === "gone") continue;
    if (!dry) files[rel] = entry;
    if (isNew && r !== "held") report.created.push(rel);
  }

  for (const rel of local) {
    const r = await publish({ vault, adapter, rel, dry, author, now, report, write, recorded });
    if (r && !dry) files[rel] = r;
  }

  if (!dry) {
    state.cursor = Math.max(state.cursor || 0, listing.cursor || 0);
    V.writeState(vault, state);
    V.ensureIgnores(vault);
    const index = indexText(files);
    if (!existsSync(join(vault, V.INDEX_FILE)) || readText(join(vault, V.INDEX_FILE)) !== index) write(V.INDEX_FILE, index);
    if (o.markdownDir && report.written.length) {
      exportMarkdown(vault, o.markdownDir, report.written.filter((p) => p.startsWith(`${V.PAGES_DIR}/`) && p.endsWith(".geml")));
    }
    if (o.commit !== false && report.written.length) {
      const paths = [...report.written, ...report.written.filter((p) => p.endsWith(".geml") && p !== V.INDEX_FILE).map(historyOf), ".gitignore", ...assetPaths(vault, report.written)];
      report.git = V.gitCommit(vault, paths, `${adapter.name} sync: ${summary(report)}`);
    }
  }
  return report;
}

function summary(r) {
  const parts = [];
  if (r.pulled.length) parts.push(`${r.pulled.length} pulled`);
  if (r.pushed.length) parts.push(`${r.pushed.length} pushed`);
  if (r.created.length) parts.push(`${r.created.length} new from the app`);
  if (r.published.length) parts.push(`${r.published.length} new in the app`);
  return parts.join(", ") || "index";
}

function assetPaths(vault, written) {
  const out = [];
  for (const rel of written) {
    if (!rel.endsWith(".geml")) continue;
    for (const m of readText(join(vault, rel)).matchAll(/\]\((\.\.\/)*assets\/([^)\s]+)\)/g)) out.push(`assets/${m[2]}`);
  }
  return out;
}

function indexText(files) {
  const csv = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, e]) => `${csv(rel)},${csv(e.ref)}`);
  return `=== meta\ntitle = "Synced pages"\n===\n\n=== table {#pages format=csv}\nfile,id\n${rows.join("\n")}${rows.length ? "\n" : ""}===\n`;
}

/** A page whose GEML does not parse is not sent anywhere. */
function brokenWhy(text) {
  const e = parse(text).diagnostics.find((d) => d.severity === "error");
  return e ? `does not parse: ${e.message}` : undefined;
}

function newLosses(lost, recorded) {
  return lost.filter((l) => [...recorded].some((id) => l.includes(id)));
}

async function syncObject(c) {
  const { vault, adapter, rel, entry, dry, author, report, write, recorded } = c;
  const file = join(vault, rel);
  const hist = historyOf(file);
  const docName = basename(file);
  const ctx = { vaultDir: vault, pageDir: dirname(file), dryRun: dry, backup: (doc) => V.backup(vault, entry.ref, doc) };
  if (!dry) mkdirSync(dirname(file), { recursive: true });

  // 1. Local edits.
  if (existsSync(file)) {
    const why = brokenWhy(readText(file));
    if (why) { report.held.push({ file: rel, why }); return "held"; }
    if (!dry && (!existsSync(hist) || !isCurrent(hist, file))) {
      recorded.add(save({ gemlPath: file, historyPath: hist, summary: "edited in the vault", author, at: c.now() }).id);
    }
  }
  const expected = existsSync(file) ? sha(readText(file)) : undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    // 2. The app's state.
    let pulled;
    try { pulled = await adapter.read(entry.ref); } catch (e) {
      if (e.status === 404) { report.held.push({ file: rel, why: "the app no longer has this object" }); return "gone"; }
      throw e;
    }
    if (dry) {
      const g = adapter.toGeml(pulled.doc, entry.state ?? {}, ctx);
      const local = existsSync(file) ? readText(file) : undefined;
      if (local !== undefined && local !== g.text) {
        const p = await adapter.push(entry.ref, pulled, local, entry.state ?? {}, ctx);
        if (p.status === "dry-run") report.planned.push({ file: rel, ops: p.ops });
      }
      return "ok";
    }
    if (pulled.etag !== entry.version || !entry.appHead) {
      await adapter.fetchAssets?.(pulled.doc, vault);
      const g = adapter.toGeml(pulled.doc, entry.state ?? {}, ctx);
      entry.state = g.state;
      const r = recordReplica({ historyPath: hist, docName, base: entry.appHead, text: g.text, author: adapter.name, summary: `from ${adapter.name}`, at: c.modifiedAt ? new Date(c.modifiedAt) : c.now() });
      if (r.id) { entry.appHead = r.id; recorded.add(r.id); report.pulled.push(rel); }
      else if (!entry.appHead) entry.appHead = r.heads[0];
      entry.version = pulled.etag;
    }

    // 3. Merge, and write the merged page — unless someone wrote it meanwhile.
    const m = mergeHeads({ historyPath: hist, docName, author: "logseq-any-sync", at: c.now() });
    if (m.id) recorded.add(m.id);
    report.lost.push(...newLosses(m.lost, recorded));
    const current = existsSync(file) ? readText(file) : undefined;
    if (current !== m.text) {
      if (current !== undefined && sha(current) !== expected) { report.held.push({ file: rel, why: "edited while syncing — picked up next cycle" }); return "held"; }
      write(rel, m.text);
    }

    // 4. Push.
    if (m.head === entry.appHead) return "ok";
    const p = await adapter.push(entry.ref, pulled, m.text, entry.state ?? {}, ctx);
    if (p.status === "conflict") { entry.version = undefined; continue; }
    if (p.status === "nothing") { entry.appHead = m.head; return "ok"; }

    // 5. Read back what the app now holds.
    entry.state = p.state;
    entry.version = p.etag;
    await adapter.fetchAssets?.(p.doc, vault);
    const g2 = adapter.toGeml(p.doc, entry.state, ctx);
    entry.state = g2.state;
    const r2 = recordReplica({ historyPath: hist, docName, base: m.head, text: g2.text, author: adapter.name, summary: `ids from ${adapter.name}`, at: c.now() });
    entry.appHead = r2.id ?? m.head;
    if (r2.id) recorded.add(r2.id);
    report.pushed.push(rel);
    if (readText(file) === m.text && g2.text !== m.text) write(rel, g2.text);
    return "ok";
  }
  report.held.push({ file: rel, why: "the app kept changing while pushing — retried next cycle" });
  return "held";
}

/** A page the vault made: create it in the app. */
async function publish(c) {
  const { vault, adapter, rel, dry, author, report, write, recorded } = c;
  const file = join(vault, rel);
  const hist = historyOf(file);
  const text = readText(file);
  const why = brokenWhy(text);
  if (why) { report.held.push({ file: rel, why }); return undefined; }
  const ctx = { vaultDir: vault, pageDir: dirname(file), dryRun: dry };
  if (dry) {
    const r = await adapter.create(text, {}, ctx);
    report.planned.push({ file: rel, ops: [{ op: "create", doc: r.doc }] });
    return undefined;
  }
  const head = existsSync(hist) && isCurrent(hist, file)
    ? undefined
    : save({ gemlPath: file, historyPath: hist, summary: "new in the vault", author, at: c.now() }).id;
  if (head) recorded.add(head);
  const created = await adapter.create(text, {}, ctx);
  const base = mergeHeads({ historyPath: hist, docName: basename(file), at: c.now() }).head;
  await adapter.fetchAssets?.(created.doc, vault);
  const g = adapter.toGeml(created.doc, created.state, ctx);
  const r = recordReplica({ historyPath: hist, docName: basename(file), base, text: g.text, author: adapter.name, summary: `created in ${adapter.name}`, at: c.now() });
  if (readText(file) === text && g.text !== text) write(rel, g.text);
  report.published.push(rel);
  return { ref: created.ref, appHead: r.id ?? base, version: created.etag, state: g.state };
}
