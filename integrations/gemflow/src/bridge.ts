// The Node side of the Claude Code shell. `gemflow hook` reads one request
// (src/hosts/claude-code/protocol.ts) on stdin, runs it against the project's
// workspace, and writes one answer line. Each request opens the workspace
// afresh — a Workspace reads git's facts when it opens, and another process may
// have written the journal or the dictionary since the last request — and
// every answer carries a fresh ShellStatus: status, policy snapshot and
// context key, which the hooks module keeps for its fast path and its
// drawings. Nothing here throws to the caller: a journal that fails
// verification, a lock that stays held, a verb that kept conflicting with
// another process are error answers. An answer to a request that threw
// carries no shell — the throw says nothing about the workflow — so the hooks
// module keeps the policy it has and the band shows the error. A tool call is
// attributed to the checkout and work item it acts in (attribution.ts):
// `before`, `after` and `learn` start where the request's `cwd` says, and the
// shell they answer with is always the session's.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { globToRegExp } from "./core/unit.js";
import { Attribution } from "./attribution.js";
import { bindInDocument, readBacklog } from "./core/backlog.js";
import { CLAUDE_CODE_TOOLS } from "./core/host-tools.js";
import { PARSER_VERSION } from "@geml/geml";
import { guardText } from "@geml/geml/dist/statechart.js";
import { readFileSync } from "node:fs";
import { readJournal, renderJournalMarkdown, type Journal, type Wrote } from "./core/journal.js";
import { blockText } from "./core/blocks.js";
import { BACKLOG_DOC, CONTEXT_DOC, EXPORTS_DIR, FLOW_FILE, GEML_DIR } from "./core/layout.js";
import { TOOLS_FILE } from "./core/dictionary.js";
import { renderDictionary } from "./core/dictionary-file.js";
import { migrateLayout, projectDocOf, recordedPath, workflowAt } from "./project-home.js";
import { updateOutline, type OutlineEntry } from "./outline-store.js";
import { copyPath, artifactsDir, recordFile, recordLink, syncDocs, syncWritten } from "./artifacts-store.js";
import { isDocPath, isGemlPath, pageTitle, artifactsOfItem, type Artifact } from "./core/artifacts.js";
import { historyPathFor } from "@geml/geml";
import { prOf, type PrFact } from "./core/outline.js";
import { itemState } from "./core/item-state.js";
import { canonical, guardHolds, isPaused, type Snapshot } from "./core/snapshot.js";
import type { JsonValue } from "./core/schema.js";
import { outgoing, sourceLabel, varsBySource } from "./core/statechart.js";
import { waitsOnPerson } from "./core/turn.js";
import { readContextDoc } from "./core/stagehand.js";
import { exists, readText, withLock, writeAtomic } from "./host-fs.js";
import { branchesAhead, commitsOf, ghOncePerBranch, journalBaseOf, openPullRequests, pullRequestsByBranch, repoFacts, type GhFacts } from "./host-git.js";
import { SESSIONS_DIR } from "./core/session-log.js";
import type { HostInfo } from "./hosts/claude-code/env.js";
import { mediaTodoCount } from "./media-todo.js";
import { addWorkflow, bundledWorkflows, importWorkflow, projectWorkflows, suggestWorkflow, useWorkflow } from "./project.js";
import { timelineOf } from "./timeline.js";
import { flowPicture } from "./core/picture.js";
import { runVerb } from "./verbs.js";
import { dependsOf, fileUnitOf, itemProgress, loadWorkspace, openWorkspace, resolveWorkflow, sideFlows, workflowNameOf, type FlowCache, type Opened, type ShellView, type Workspace } from "./workspace.js";
import type { BoardData, BoardItem, BridgeRequest, BridgeResponse, Made, MadeEntry, Artifacts, ShellStatus, TimelineEntry, TodoCount } from "./hosts/claude-code/protocol.js";

type Answered = Extract<BridgeResponse, { ok: true }>;

/**
 * gh is asked live only where its facts can have changed: refresh, the board,
 * and after a git operation (ghFacts finds the binary through GEMFLOW_GH). Any
 * other request reuses the availability the last answer reported.
 */
function ghFor(req: BridgeRequest): (root: string, branch: string) => GhFacts {
  if (req.op === "refresh" || req.op === "board" || (req.op === "after" && req.gitOperation)) return ghOncePerBranch();
  const seen = req.gh ?? { available: true as const };
  return () => (seen.available ? { available: true } : { available: false, reason: seen.reason });
}

/** `<item>@<rev>` of the context document, or null when there is none to read. */
function contextKey(root: string): string | null {
  let text: string;
  try { text = readText(join(root, CONTEXT_DOC)); } catch { return null; }
  const doc = readContextDoc(text);
  return doc ? `${doc.item}@${doc.rev}` : null;
}

/** The plugin's own version, read once: the bundle may start without a package.json beside it. */
const gemflowVersion = (() => {
  let read: string | undefined;
  return (): string => {
    if (read === undefined) {
      try { read = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? ""; } catch { read = ""; }
    }
    return read;
  };
})();

function localeOf(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

function shellOf(view: ShellView, root: string): ShellStatus {
  const locale = localeOf();
  const units = unitsOf(root, view);
  return { status: view.status, policy: view.policy, contextKey: contextKey(root), ...(locale !== undefined ? { locale } : {}), versions: { gemflow: gemflowVersion(), parser: PARSER_VERSION }, ...(units.length > 0 ? { units } : {}) };
}

/** The globs of the workflows whose work items are files: the default's (when it is one) and those beside it. */
function unitsOf(root: string, view: ShellView): string[] {
  const wf = resolveWorkflow(root);
  if ("error" in wf) return view.policy.unit.kind === "file" ? [view.policy.unit.glob] : [];
  const own = fileUnitOf(wf.path);
  return [...new Set([...(own !== undefined ? [own] : []), ...sideFlows(root, wf.path).map((f) => f.glob), ...(view.policy.unit.kind === "file" ? [view.policy.unit.glob] : [])])];
}

function problemShell(text: string, quiet: boolean): ShellStatus {
  return { status: null, policy: null, contextKey: null, problem: { text, quiet } };
}

/** The shell for a workspace that did not open: quiet when the project simply has no workflow. */
function notOpened(opened: Extract<Opened, { ok: false }>, root: string): ShellStatus {
  const shell = problemShell(opened.reason, opened.kind === "none");
  // No workflow: which bundled one fits this project, so the band can offer it.
  return opened.kind === "none" ? { ...shell, suggest: suggestWorkflow(root) } : shell;
}

function openFor(req: BridgeRequest): Opened {
  return openWorkspace({
    root: req.root, tools: CLAUDE_CODE_TOOLS, gh: ghFor(req),
    ...(req.lastFile !== undefined ? { lastFile: req.lastFile } : {}),
  });
}

/**
 * Who answers for a request's tool call: the session's workspace, and the
 * work items of the other checkouts and files the call reaches, opened as the
 * session's are, each journal started only when something is recorded in it.
 */
function attributionFor(req: BridgeRequest, ws: Workspace): Attribution {
  const gh = ghFor(req);
  return new Attribution(ws, (o) => {
    const opened = loadWorkspace({ tools: CLAUDE_CODE_TOOLS, gh, lazy: true, ...o });
    return opened.ok ? opened.ws : undefined;
  }, CLAUDE_CODE_TOOLS);
}

/** The shell after a change made beside the workspace (use, add). */
function shellAt(req: BridgeRequest): ShellStatus {
  const opened = openFor(req);
  return opened.ok ? shellOf(opened.ws.view(), req.root) : notOpened(opened, req.root);
}

/** Bind a to-do to the current work item: one cell of .geml/backlog.geml rewritten, under the backlog's lock. */
function bindHere(ws: Workspace, root: string, id: string): { ok: true } | { ok: false; reason: string } {
  const item = ws.item;
  if (item.kind !== "item") return { ok: false, reason: item.reason };
  const path = join(root, BACKLOG_DOC);
  if (!exists(path)) return { ok: false, reason: `no ${BACKLOG_DOC}` };
  return withLock(path, () => {
    const source = readText(path);
    const r = bindInDocument(source, id, item.id);
    if (!r.ok) return r;
    if (r.text !== source) writeAtomic(path, r.text);
    return { ok: true as const };
  });
}

/** A file name from a work item or a title: letters, digits, `.`, `_` and `-`; anything else becomes `-`. */
const fileSafe = (s: string): string => s.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "item";

/** The text with the project's and the home directory's absolute paths taken out, both separators. */
export function stripPaths(text: string, root: string): string {
  let out = text;
  for (const dir of [root, homedir()]) {
    const mark = dir === root ? "." : "~";
    for (const form of new Set([dir, dir.split("\\").join("/"), dir.split("/").join("\\")])) if (form !== "") out = out.split(form).join(mark);
  }
  return out;
}

type ExportReq = Extract<BridgeRequest, { op: "export" }>;

/**
 * The board's export (spec §8.2): a file under `.geml/exports/`. A journal as
 * it is, as a Markdown table or as JSON; the workflow, as a directory another
 * project imports (its file as `flow.geml`, the documents it keeps, the rows
 * of the dictionary it uses as `tools.geml`); or text the shell built. Answers the project-relative path and the text.
 */
function exportOf(ws: Workspace, root: string, req: ExportReq, now: string): { ok: true; path: string; text: string } | { ok: false; reason: string } {
  const dir = join(root, EXPORTS_DIR);
  const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const item = ws.item.kind === "item" ? fileSafe(ws.item.id) : "no-item";
  const given = req.name !== undefined ? fileSafe(basename(req.name.split("\\").join("/"))) : undefined;
  const ext = `.${req.format}`;
  const named = (fallback: string): string => {
    const name = given ?? fallback;
    return name.endsWith(ext) ? name : `${name}${ext}`;
  };
  const shown = (path: string): string => relative(root, path).split("\\").join("/");
  const write = (name: string, text: string): { ok: true; path: string; text: string } => {
    const out = req.strip === true ? stripPaths(text, root) : text;
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, name), out);
    return { ok: true, path: shown(join(dir, name)), text: out };
  };
  if (req.kind === "text") return write(named(`share-${item}-${stamp}`), req.text ?? "");
  if (req.kind === "journal") {
    const path = ws.journalPath;
    if (path === undefined || !exists(path)) return { ok: false, reason: ws.item.kind === "item" ? `${ws.item.id} has no journal yet` : ws.item.reason };
    const source = readText(path);
    const text = req.format === "geml" ? source : req.format === "md" ? renderJournalMarkdown(readJournal(source)) : JSON.stringify(readJournal(source), null, 2);
    return write(named(`journal-${item}-${stamp}`), text);
  }
  const name = given ?? `workflow-${fileSafe(ws.workflowName)}-${stamp}`;
  const target = join(dir, name);
  mkdirSync(dir, { recursive: true });
  const noHistory = (src: string): boolean => !/[\\/]\.gemlhistory([\\/]|$)/.test(src);
  const text = readText(ws.workflowPath);
  // A directory of the earlier layout goes as it is.
  if (basename(ws.workflowPath).toLowerCase() === FLOW_FILE) {
    cpSync(ws.workflowDir, target, { recursive: true, filter: noHistory });
    return { ok: true, path: shown(target), text };
  }
  writeAtomic(join(target, FLOW_FILE), text);
  const kept = join(ws.workflowDir, ws.workflowName);
  if (exists(kept)) cpSync(kept, join(target, ws.workflowName), { recursive: true, filter: noHistory });
  const uses = new Set([...ws.sc.states.values()].flatMap((st) => st.uses));
  writeAtomic(join(target, TOOLS_FILE), renderDictionary(ws.dictionary().rows.filter((r) => r.for === undefined || uses.has(r.for))));
  return { ok: true, path: shown(target), text };
}

/**
 * Every work item with a journal, every checkout's: the journals are shared.
 * An item started under another workflow than the default names it. An item
 * file's meta `title` names the item; the ways out a person may take now are
 * read off the journal's last revision, for the items under the current work
 * item's workflow (the statechart at hand).
 */
function listItems(ws: Workspace, root: string, workflowFile: string, prs?: ReadonlyMap<string, PrFact>): BoardItem[] {
  const dir = ws.journalsDir;
  if (!exists(dir)) return [];
  const wf = resolveWorkflow(root);
  const home = ws.journalBase;
  const defaultFile = "error" in wf ? undefined : recordedPath(root, home, wf.path);
  // A name a journal gives a workflow, as the file it is: the earlier layout's name of a workflow since moved is the same file.
  const fileOf = (recorded: string): string | undefined => (recorded === "" ? undefined : workflowAt(root, home, recorded));
  const same = (recorded: string, file: string | undefined): boolean => {
    const at = fileOf(recorded);
    return file !== undefined && at !== undefined && resolve(at) === resolve(file);
  };
  const out: BoardItem[] = [];
  const entries: OutlineEntry[] = [];
  const flows: FlowCache = new Map([[workflowFile, { sc: ws.sc, title: ws.title }]]);
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith(".geml")) continue;
    const full = join(e.parentPath, e.name);
    const journal = readJournal(readText(full));
    const last = journal.snapshots.at(-1);
    if (!last) continue;
    const under = journal.meta.workflow;
    const workflow = under !== "" && under !== defaultFile && !same(under, "error" in wf ? undefined : wf.path) ? workflowNameOf(root, fileOf(under) ?? under) : undefined;
    const id = relative(dir, full).split("\\").join("/").replace(/\.geml$/, "");
    // Its own flow: the one at hand, or the one its journal names — a matter beside a branch finds its file by the matter flow's glob.
    const recorded = (under === "" ? defaultFile : under) ?? "";
    const own = same(recorded, ws.workflowPath) ? workflowFile : recorded;
    const ownFile = own === workflowFile ? undefined : fileOf(own);
    const glob = own === workflowFile ? (ws.sc.unit.kind === "file" ? ws.sc.unit.glob : "") : ownFile !== undefined ? fileUnitOf(ownFile) ?? "" : "";
    const file = ws.fileOfItem(id, glob);
    const paused = isPaused(journal.snapshots);
    let title: string | undefined;
    let gist: string | undefined;
    let about: string | undefined;
    let by: string | undefined;
    let depends: string[] = [];
    if (file !== undefined) {
      try {
        const source = readText(join(root, file));
        title = itemState(source, "title");
        gist = gistOf(source);
        about = itemState(source, "about");
        by = itemState(source, "by");
        depends = dependsOf(source);
      } catch { title = undefined; }
    }
    const progress = itemProgress(root, ws.journalBase, id, flows, defaultFile ?? "");
    // Its own flow's statechart: the one at hand, or one read for it once this request.
    const flow = own === workflowFile ? { sc: ws.sc } : flows.get(own) ?? null;
    const sc = flow?.sc;
    const ways = sc !== undefined && !paused && sc.states.get(last.state)?.final !== true
      ? outgoing(sc, last.state).map((t) => ({ t, approval: t.approval, holds: guardHolds(sc, t, last.vars), judge: t.judge, reads: t.reads, toStart: t.to === sc.initial }))
      : [];
    const asks = sc !== undefined && waitsOnPerson(ways, sources(sc)) ? ways.filter((w) => w.approval && w.holds).map(({ t }) => ({
      to: t.to, label: t.label ?? sc.states.get(t.to)?.title ?? t.to, note: t.note, final: sc.states.get(t.to)?.final === true,
    })) : [];
    entries.push({
      id, kind: glob !== "" ? "file" : "branch", state: last.state, final: progress?.final === true || sc?.states.get(last.state)?.final === true,
      flow: own === workflowFile ? ws.workflowName : ownFile !== undefined ? workflowNameOf(root, ownFile) : "", stage: last.state,
      since: (progress?.since ?? journal.meta.created).slice(0, 10), last: last.at.slice(0, 10),
    });
    out.push({
      id, state: last.state, rev: last.rev, at: last.at, paused, ...(workflow !== undefined ? { workflow } : {}), ...(file !== undefined ? { file } : {}),
      ...(title !== undefined && title !== "" ? { title } : {}), ...(gist !== undefined ? { gist } : {}), ...(about ? { about } : {}), ...(by ? { by } : {}), ...(asks.length > 0 ? { asks } : {}),
      ...(progress?.flow !== undefined ? { flow: progress.flow } : {}), ...(progress?.stateTitle !== undefined ? { stateTitle: progress.stateTitle } : {}),
      ...(progress !== undefined ? { since: progress.since, wrote: progress.wrote.slice(0, 12) } : {}),
      ...(progress?.final === true ? { final: true as const } : {}), ...(depends.length > 0 ? { dependsOn: depends } : {}),
    });
  }
  // Where each ended up, by git: the outline in project.geml, brought in line.
  const outline = updateOutline(root, home, entries, prs);
  for (const i of out) {
    const row = outline.get(i.id);
    if (row === undefined) continue;
    const pr = prOf(row.pr);
    Object.assign(i, { end: row.state }, row.worktree !== "" ? { worktree: row.worktree } : {}, row.commits !== null ? { commits: row.commits } : {}, pr !== undefined ? { pr } : {});
  }
  // What each waits for, from the others' progress: one not done keeps it waiting — no way out is the person's meanwhile.
  const byId = new Map(out.map((i) => [i.id, i]));
  for (const i of out) {
    const ids = (i as BoardItem & { dependsOn?: string[] }).dependsOn;
    delete (i as BoardItem & { dependsOn?: string[] }).dependsOn;
    if (ids === undefined) continue;
    i.depends = ids.map((id) => {
      const other = byId.get(id);
      return { id, ...(other?.title !== undefined ? { title: other.title } : {}), done: other?.final === true, ...(other !== undefined ? { at: other.at } : {}) };
    });
    if (i.depends.some((d) => !d.done)) delete i.asks;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** An item file's first line of prose: its `#result` section's when it has one, else its text's after the meta; headings, comments and list marks left out. */
function gistOf(source: string): string | undefined {
  const text = source.replace(/\r\n?/g, "\n");
  const body = blockText(text, "result") ?? text.replace(/^=== meta\n[\s\S]*?\n===\n/, "");
  const line = body.split("\n").map((l) => l.trim()).find((l) => l !== "" && !/^(#|%%|===)/.test(l));
  return line?.replace(/^[-*+]\s+/, "");
}

/**
 * A new work item's file, at a person's word (the board's "记成事项"): a path
 * under the root that one of the flows' file units takes and that is not
 * there yet; its meta names it and says gemflow raised it.
 */
function newItem(root: string, path: string, title: string, text: string, units: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const rel = relative(root, resolve(root, path)).split("\\").join("/");
  if (rel.startsWith("../") || rel === "" || !units.some((glob) => globToRegExp(glob).test(rel))) return { ok: false, reason: `${path} is no work item's file of any flow here` };
  const full = join(root, rel);
  if (exists(full)) return { ok: false, reason: `${rel} is there already` };
  mkdirSync(dirname(full), { recursive: true });
  writeAtomic(full, `=== meta\ntitle = ${JSON.stringify(title)}\nby = "gemflow"\n===\n\n${text.replace(/\s+$/, "")}\n`);
  return { ok: true };
}

/** Where each variable with a source reads from, as a status reports it. */
function sources(sc: Workspace["sc"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of sc.vars.values()) if (v.source !== undefined) out[v.name] = sourceLabel(v.source);
  return out;
}

/** The most commits the board lists for a work item; the most read to count what its work changed. */
const COMMITS_SHOWN = 20;
const COMMITS_READ = 2000;

/** The files a journal says its work item wrote, the newest write of each, newest first. */
function writtenOf(journal: Journal): { path: string; rev: number; at: string; tool: string }[] {
  const latest = new Map<string, Wrote>();
  for (const w of journal.writes) { latest.delete(w.path); latest.set(w.path, w); }
  return [...latest.values()].reverse().map((w) => ({ path: w.path, rev: w.rev, at: w.at, tool: w.tool }));
}

/**
 * What the work item made, by kind (protocol.ts, Made): a version of each
 * file it wrote that git does not keep is copied first, and its documents in
 * git are written into the table; then the table's links, files and
 * pictures, the documents, and what its commits changed. Undefined when the
 * table cannot be read or written.
 */
function madeOf(home: string, root: string, item: string, written: readonly string[], ours: readonly { sha: string; at: string; files: string[] }[]): Made | undefined {
  try {
    syncWritten(root, home, item, written);
    const docs = new Map<string, { path: string; open: string; commits: number; at: string; sha: string }>();
    for (const c of ours) {
      for (const f of c.files) {
        if (!isDocPath(f)) continue;
        const d = docs.get(f);
        if (d !== undefined) d.commits += 1;
        else docs.set(f, { path: f, open: join(root, f), commits: 1, at: c.at, sha: c.sha });
      }
    }
    const rows = syncDocs(home, item, [...docs.values()].map((d) => ({ path: d.path, sha: d.sha, at: d.at })));
    const entry = (p: Artifact): MadeEntry => {
      const newest = p.versions[p.versions.length - 1] as Artifact["versions"][number];
      const own = p.kind === "link" ? newest.where : resolve(root, p.name);
      const copied = (where: string): boolean => where.startsWith("artifacts/");
      // A GEML document's versions share one copy, which holds the newest: the older are in its .gemlhistory.
      const versions = [...p.versions].reverse().map((v, i) => ({
        version: v.version, at: v.at, size: v.size,
        ...(copied(v.where) && (i === 0 || !isGemlPath(v.where)) ? { copy: copyPath(home, v.where) } : {}),
      }));
      const history = p.kind !== "link" && copied(newest.where) && isGemlPath(newest.where) ? historyPathFor(copyPath(home, newest.where)) : undefined;
      const open = p.kind === "link" || exists(own) ? own : versions[0]?.copy ?? own;
      return { kind: p.kind === "image" ? "image" : p.kind === "link" ? "link" : "file", name: p.name, open, versions, ...(history !== undefined && exists(history) ? { history } : {}) };
    };
    const made = artifactsOfItem(rows, item).filter((p) => p.kind !== "doc").map(entry);
    if (made.length === 0 && docs.size === 0 && ours.length === 0) return undefined;
    return {
      links: made.filter((p) => p.kind === "link"), files: made.filter((p) => p.kind === "file"), images: made.filter((p) => p.kind === "image"),
      docs: [...docs.values()].map(({ path, open, commits, at }) => ({ path, open, commits, at })),
      code: { commits: ours.length, files: new Set(ours.flatMap((c) => c.files)).size },
      folder: artifactsDir(home),
    };
  } catch {
    return undefined;
  }
}

/** What the current work item's work made (protocol.ts, Artifacts): from its journal, git, and its item file. */
function artifactsOf(ws: Workspace, root: string, journal: Journal): Artifacts | undefined {
  if (ws.item.kind !== "item") return undefined;
  const written = writtenOf(journal);
  const latest = new Set(written.map((w) => w.path));
  const file = ws.itemFile;
  const last = journal.snapshots.at(-1);
  const since = journal.snapshots[0]?.at ?? journal.meta.created;
  const until = last !== undefined && ws.sc.states.get(last.state)?.final === true ? last.at : undefined;
  const found = ws.sc.unit.kind === "branch"
    ? commitsOf(root, { ownBranch: true }, COMMITS_READ)
    : [
        ...commitsOf(root, { since, ...(until !== undefined ? { until } : {}) }, COMMITS_READ),
        ...(file !== undefined ? commitsOf(root, { since, paths: [file] }, COMMITS_SHOWN) : []),
      ];
  const touched = new Set([...latest, ...(file !== undefined ? [file] : [])]);
  const seen = new Set<string>();
  const all = found
    .filter((c) => { if (seen.has(c.sha)) return false; seen.add(c.sha); return true; })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((c) => ({ ...c, ours: ws.sc.unit.kind === "branch" || c.files.some((f) => touched.has(f)) }));
  const commits = all.slice(0, COMMITS_SHOWN);
  const made = madeOf(ws.journalBase, root, ws.item.id, [...latest].filter((p) => p !== file), all.filter((c) => c.ours));
  const source = file !== undefined && exists(join(root, file)) ? readText(join(root, file)) : undefined;
  const section = source !== undefined ? blockText(source, "result") : undefined;
  const result = section?.replace(/^#[^\n]*\n*/, "").trim();
  return {
    item: ws.item.id, ...(file !== undefined ? { file } : {}), ...(result !== undefined && result !== "" ? { result } : {}),
    written, commits, ...(made !== undefined ? { made } : {}),
  };
}

/** A turn's end: a version of each file the current work item wrote that git does not keep, when its content changed. */
function syncArtifacts(ws: Workspace, root: string): void {
  if (ws.item.kind !== "item" || ws.journalPath === undefined || !exists(ws.journalPath)) return;
  const file = ws.itemFile;
  try { syncWritten(root, ws.journalBase, ws.item.id, writtenOf(readJournal(readText(ws.journalPath))).map((w) => w.path).filter((p) => p !== file)); } catch { /* the next look copies it */ }
}

/** A artifact the model or a publish tool names, under the current work item: a link, or a file's version. Answers what was recorded, in words for the model. */
function recordArtifact(ws: Workspace, root: string, req: Extract<BridgeRequest, { op: "artifact" }>): { ok: true; text: string } | { ok: false; reason: string } {
  if (ws.item.kind !== "item") return { ok: false, reason: "there is no current work item to record it under" };
  const item = ws.item.id;
  const where = req.where.trim();
  if (where === "") return { ok: false, reason: "where is empty: give the link's address or the file's path" };
  if (req.kind === "link") {
    if (!/^https?:\/\//i.test(where)) return { ok: false, reason: "a link's where is its http(s) address" };
    let name = req.name?.trim() ?? "";
    if (name === "" && req.page !== undefined) { try { name = pageTitle(readText(resolve(root, req.page))) ?? ""; } catch { /* named by its address */ } }
    if (name === "" && req.page !== undefined) name = basename(req.page).replace(/\.[^.]*$/, "");
    recordLink(ws.journalBase, item, { name, url: where, ...(req.version !== undefined && req.version !== "" ? { version: req.version } : {}), at: new Date().toISOString() });
    return { ok: true, text: `Recorded the link under ${item}'s artifacts.` };
  }
  const row = recordFile(root, ws.journalBase, item, where, req.kind);
  return row !== undefined
    ? { ok: true, text: `Recorded ${row.name} (version ${row.version}) under ${item}'s artifacts.` }
    : { ok: true, text: "Nothing new to record: no file there, or this version is recorded already." };
}

function boardOf(ws: Workspace, root: string, view: ShellView): BoardData {
  const sc = ws.sc;
  const tree = ws.contentTree();
  const backlogPath = join(root, BACKLOG_DOC);
  const backlog = exists(backlogPath) ? readBacklog(readText(backlogPath)) : null;
  const guards = new Map(view.status.next.map((t) => [t.name, t.guard]));
  const items = listItems(ws, root, view.status.workflow.path);
  const journal = ws.journalPath !== undefined && exists(ws.journalPath) ? readJournal(readText(ws.journalPath)) : undefined;
  const timeline = journal !== undefined ? timelineOf(journal) : [];
  const artifacts = journal !== undefined ? artifactsOf(ws, root, journal) : undefined;
  const ci = ws.ciFailures();
  return {
    unit: sc.unit.kind,
    states: [...sc.states.values()].map((s) => ({ id: s.id, title: s.title, description: s.description, initial: s.id === sc.initial, final: s.final, uses: s.uses })),
    transitions: sc.transitions.map((t) => {
      const guard = guards.get(t.name) ?? (t.guard !== undefined ? guardText(t.guard) : undefined);
      return { name: t.name, from: t.from, to: t.to, judge: t.judge, approval: t.approval, ...(guard !== undefined ? { guard } : {}), note: t.note };
    }),
    fences: Object.entries(view.policy.fences).map(([use, states]) => ({ use, states })),
    tools: view.policy.rows,
    backlog: backlog ? { key: backlog.key, items: backlog.items } : null,
    items,
    timeline,
    clocks: varsBySource(sc, "elapsed").map((v) => ({ name: v.name, iso: v.source.iso, ms: v.source.ms })),
    ...(tree !== undefined ? { tree } : {}),
    picture: flowPicture({ sc, status: view.status, items, timeline }),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(ci !== undefined ? { ci: { head: ci.head, failed: ci.workflows } } : {}),
  };
}

/**
 * The work item's to-do count when its file is a geml-media entry (spec §7.2),
 * with the stage it was read in; null when it is no such entry or could not be
 * counted in time. Display only; it hashes the entry's assets, so only refresh
 * and board ask.
 */
function todoOf(ws: Workspace, root: string, view: ShellView): TodoCount | null {
  const file = ws.itemFile;
  const state = view.status.state?.id;
  if (ws.item.kind !== "item" || file === undefined || state === undefined) return null;
  const count = mediaTodoCount(root, file);
  return count === undefined ? null : { item: ws.item.id, state, count };
}

/**
 * The handoff of an after or verb answer whose work item is not the one whose
 * stage the main loop last read (`delivered`, `<item>@<rev>`): the line, and
 * the item's stage text — the new one when the request changed the stage, else
 * the one the context document holds. Otherwise the request's own stage text,
 * when it changed the stage.
 */
/** The machine and checkout the session runs on: what a person driving it from a phone needs to know. */
function hostOf(root: string): HostInfo {
  let user: string | undefined;
  try { user = userInfo().username; } catch { /* an account with no name */ }
  const branch = repoFacts(root).branch;
  return { name: hostname(), platform: process.platform, ...(user !== undefined && user !== "" ? { user } : {}), ...(branch !== undefined ? { branch } : {}) };
}

function handoffOf(delivered: string | undefined, ws: Workspace, view: ShellView, context: string | undefined): { handoff?: string; context?: string } {
  const own = context !== undefined ? { context } : {};
  const s = view.status;
  if (delivered === undefined || s.item.kind !== "item") return own;
  if (delivered.slice(0, Math.max(0, delivered.lastIndexOf("@"))) === s.item.id) return own;
  const text = context ?? ws.context();
  if (text === undefined) return own;
  const state = `#${s.state?.id ?? "?"}`;
  if (ws.startedJournal) return { handoff: `[gemflow] now on ${s.item.id} · ${state} (new work item)`, context: text };
  const vars = view.policy.relevant.map((name) => {
    const v = s.vars[name];
    return typeof v === "boolean" ? ` · ${name} ${v ? "✓" : "✗"}` : ` · ${name}=${JSON.stringify(v ?? null)}`;
  }).join("");
  return { handoff: `[gemflow] back on ${s.item.id} · ${state} · rev ${s.state?.rev ?? 0}${vars}`, context: text };
}

/** Move the earlier layout into the project's home (migrateLayout), what moved kept in the trash under one stamp; a move that fails leaves the earlier layout, which is still read. */
function moveEarlierLayout(root: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  try { migrateLayout(root, join(homedir(), ".gemflow", "trash", `${stamp}-layout`)); } catch { /* still read where it is */ }
}

/** One request, answered. A throw — from opening the workspace or from the op — becomes an error answer with no shell: the last good one stays. */
export async function handleRequest(req: BridgeRequest): Promise<BridgeResponse> {
  return answerRequest(req);
}

/** handleRequest, answered at once: every op is answered without waiting on anything but the files and git. */
export function answerRequest(req: BridgeRequest): BridgeResponse {
  try {
    return answer(req);
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).replace(/^gemflow: /, "");
    return { v: 1, ok: false, error: `gemflow: ${message}` };
  }
}

function answer(req: BridgeRequest): BridgeResponse {
  const root = req.root;
  if (req.op === "use") {
    const r = useWorkflow(root, req.workflow);
    // The default changes; a work item with a journal keeps its own workflow, which the shell names.
    return r.ok ? { v: 1, ok: true, shell: shellAt(req) } : { v: 1, ok: false, error: r.reason, shell: shellAt(req) };
  }
  if (req.op === "add") {
    const workflows = bundledWorkflows();
    const installed = projectWorkflows(root);
    if (req.workflow === undefined) return { v: 1, ok: true, shell: shellAt(req), workflows, installed };
    const activate = installed.length === 0 && projectDocOf(root) === undefined;
    const r = addWorkflow(root, req.workflow, { activate });
    if (!r.ok) return { v: 1, ok: false, error: r.reason, shell: shellAt(req) };
    return { v: 1, ok: true, shell: shellAt(req), workflows, installed: projectWorkflows(root), added: { name: r.name, activated: r.activated } };
  }
  if (req.op === "import") {
    const r = importWorkflow(root, req.path);
    if (!r.ok) return { v: 1, ok: false, error: r.reason, shell: shellAt(req) };
    return { v: 1, ok: true, shell: shellAt(req), workflows: bundledWorkflows(), installed: projectWorkflows(root), added: { name: r.name, activated: r.activated } };
  }
  if (req.op === "status" && req.migrate === true) moveEarlierLayout(root);
  const opened = openFor(req);
  if (!opened.ok) {
    const shell = notOpened(opened, req.root);
    const asks = req.op === "verb" || req.op === "mark" || req.op === "advance" || req.op === "bind" || req.op === "learn" || req.op === "pause" || req.op === "resume" || req.op === "rollback" || req.op === "export";
    return asks ? { v: 1, ok: false, error: opened.reason, shell } : { v: 1, ok: true, shell };
  }
  const ws = opened.ws;
  /** The answer: the view after the op, and the new stage text when the op changed the stage. */
  const ok = (view: ShellView, extra: Omit<Answered, "v" | "ok" | "shell" | "context"> = {}, context?: string): Answered =>
    ({ v: 1, ok: true, shell: shellOf(view, root), ...extra, ...(context !== undefined ? { context } : {}) });
  const failed = (reason: string): BridgeResponse => ({ v: 1, ok: false, error: reason, shell: shellOf(ws.view(), root) });
  switch (req.op) {
    case "status":
      // The shared session logs' directory too: a session's first prompt is written before the slower facts come.
      return ok(ws.view(), { sessions: join(journalBaseOf(root), GEML_DIR, SESSIONS_DIR) });
    case "refresh": {
      // The workspace opened for this request: git's facts it read are this moment's.
      const change = ws.refresh({ reread: false });
      const view = ws.view();
      return ok(view, { entered: change.entered, todo: todoOf(ws, root, view) }, change.context);
    }
    case "before": {
      const { view, refusal, recorded } = attributionFor(req, ws).before(req.tool, req.callId, req.input, resolve(root, req.cwd), req.waived);
      return ok(view ?? ws.view(), { ...(refusal !== undefined ? { refusal } : {}), recorded });
    }
    case "after": {
      const start = resolve(root, req.cwd);
      const r = attributionFor(req, ws).after({
        tool: req.tool, callId: req.callId, isError: req.isError, input: req.input, gitOperation: req.gitOperation,
        ...(req.exitCode !== undefined ? { exitCode: req.exitCode } : {}),
        ...(req.wrotePath !== undefined ? { wrotePath: req.wrotePath } : {}),
      }, start);
      const view = ws.view();
      const h = handoffOf(req.delivered, ws, view, r.context);
      return ok(view, { entered: r.entered, ...(r.routed !== undefined ? { routed: r.routed } : {}), ...(h.handoff !== undefined ? { handoff: h.handoff } : {}) }, h.context);
    }
    case "verb": {
      const a = runVerb(ws, req.name, req.args, req.callId);
      const view = ws.view();
      const h = handoffOf(req.delivered, ws, view, a.context);
      return ok(view, { text: a.text, ...(h.handoff !== undefined ? { handoff: h.handoff } : {}) }, h.context);
    }
    case "learn": {
      const took = attributionFor(req, ws).learn(req.lessons, req.tool, req.input, resolve(root, req.cwd));
      return took ? ok(ws.view()) : failed("the call acts in no work item's project; nothing to learn it for");
    }
    case "mark": {
      const r = ws.mark(req.variable, req.checked);
      return r.ok ? ok(ws.view(), { entered: r.entered }, r.context) : failed(r.reason);
    }
    case "advance": {
      const r = ws.advance(req.to);
      return r.ok ? ok(ws.view(), { entered: r.entered }, r.context) : failed(r.reason);
    }
    case "pause": {
      const r = ws.pause();
      return r.ok ? ok(ws.view()) : failed(r.reason);
    }
    case "resume": {
      const r = ws.resume();
      return r.ok ? ok(ws.view(), { entered: r.entered }, r.context) : failed(r.reason);
    }
    case "rollback": {
      const r = ws.rollback(req.rev);
      return r.ok ? ok(ws.view(), { entered: r.entered }, r.context) : failed(r.reason);
    }
    case "new-item": {
      const r = newItem(root, req.path, req.title, req.text, unitsOf(root, ws.view()));
      return r.ok ? ok(ws.view()) : failed(r.reason);
    }
    case "export": {
      const r = exportOf(ws, root, req, new Date().toISOString());
      return r.ok ? ok(ws.view(), { exported: { path: r.path, text: r.text } }) : failed(r.reason);
    }
    case "bind": {
      const r = bindHere(ws, root, req.id);
      return r.ok ? ok(ws.view()) : failed(r.reason);
    }
    // The repository as the band reads it: what is not pushed, which pull requests are green or failing.
    case "attention": {
      // gh is asked here, off the board's path: the outline learns which branches' pull requests were merged.
      const view = ws.view();
      const prs = pullRequestsByBranch(root);
      if (prs.size > 0) listItems(ws, root, view.status.workflow.path, prs);
      // The shared session logs: the main working tree's .geml/sessions/, whichever worktree this checkout is.
      return ok(view, { attention: { ahead: branchesAhead(root), prs: openPullRequests(root) }, host: hostOf(root), sessions: join(journalBaseOf(root), GEML_DIR, SESSIONS_DIR) });
    }
    case "artifacts": {
      syncArtifacts(ws, root);
      return ok(ws.view());
    }
    case "artifact": {
      const r = recordArtifact(ws, root, req);
      return r.ok ? ok(ws.view(), { text: r.text }) : failed(r.reason);
    }
    case "board": {
      // The workspace opened for this request: git's facts it read are this moment's.
      const change = ws.refresh({ reread: false });
      const view = ws.view();
      return ok(view, { entered: change.entered, board: boardOf(ws, root, view), todo: todoOf(ws, root, view) }, change.context);
    }
  }
}
