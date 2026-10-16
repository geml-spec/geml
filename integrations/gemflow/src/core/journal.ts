// The journal (spec §5.5): the work item's record of truth, a plain GEML
// document written by blind append — `#journal` says which item and workflow,
// every revision is a `data {#rev-N}` block, every refusal a `data
// {#refused-N}` block, every file the work wrote a `data {#wrote-N}` block. Rendering is text out; reading parses with @geml/geml.
import { parse, type Block } from "@geml/geml";
import { canonical, hashSnapshot, type By, type Cause, type Snapshot } from "./snapshot.js";
import { outgoing, type Statechart } from "./statechart.js";
import type { JsonValue } from "./schema.js";

export interface JournalMeta { item: string; workflow: string; workflowHash: string; created: string }
export interface Refused { n: number; rev: number; at: string; tool: string; call?: string; reason: string; diagnostics: string[]; key?: string }
/** A file the work item's work wrote, by its project path: what it made, for the board's products. Outside the hash chain, as refusals are. */
export interface Wrote { n: number; rev: number; at: string; tool: string; call?: string; path: string }
export interface Journal { meta: JournalMeta; snapshots: Snapshot[]; refusals: Refused[]; writes: Wrote[]; diagnostics: string[] }

const CAUSES: ReadonlySet<string> = new Set(["enter", "transition", "patch", "rollback", "expire", "pause", "resume"]);
const BYS: ReadonlySet<string> = new Set(["model", "signal", "human"]);

const block = (id: string, value: JsonValue): string => `=== data {#${id} format=json}\n${canonical(value)}\n===\n\n`;

export function renderJournalHead(meta: JournalMeta): string {
  return [
    "=== meta",
    'title = "gemflow journal"',
    "===",
    "",
    block("journal", { item: meta.item, workflow: meta.workflow, "workflow-hash": meta.workflowHash, created: meta.created }),
  ].join("\n");
}

/** A revision as its block: every field, in the canonical form. */
export function renderSnapshotBlock(s: Snapshot): string {
  return block(`rev-${s.rev}`, s as unknown as JsonValue);
}

export function renderRefusedBlock(r: Refused): string {
  const v: Record<string, JsonValue> = { rev: r.rev, at: r.at, tool: r.tool, reason: r.reason, diagnostics: r.diagnostics };
  if (r.call !== undefined) v["call"] = r.call;
  if (r.key !== undefined) v["key"] = r.key;
  return block(`refused-${r.n}`, v);
}

export function renderWroteBlock(w: Wrote): string {
  const v: Record<string, JsonValue> = { rev: w.rev, at: w.at, tool: w.tool, path: w.path };
  if (w.call !== undefined) v["call"] = w.call;
  return block(`wrote-${w.n}`, v);
}

type Typed = Extract<Block, { kind: "block" }>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readJournal(source: string): Journal {
  const doc = parse(source);
  const diagnostics: string[] = doc.diagnostics.filter((d) => d.severity === "error").map((d) => `line ${d.line}: ${d.message}`);
  const meta: JournalMeta = { item: "", workflow: "", workflowHash: "", created: "" };
  const snapshots: Snapshot[] = [];
  const refusals: Refused[] = [];
  const writes: Wrote[] = [];
  for (const b of doc.children) {
    if (b.kind !== "block" || b.type !== "data" || b.id === undefined) continue;
    const id = b.id;
    const blk = b as Typed;
    const label = `#${id}`;
    const body = blk.value;
    if (id === "journal") {
      if (!isObject(body)) { diagnostics.push(`${label}: not a JSON object`); continue; }
      meta.item = str(body["item"]) ?? "";
      meta.workflow = str(body["workflow"]) ?? "";
      meta.workflowHash = str(body["workflow-hash"]) ?? "";
      meta.created = str(body["created"]) ?? "";
      continue;
    }
    const rev = id.match(/^rev-(\d+)$/);
    const refused = id.match(/^refused-([1-9]\d*)$/);
    const wrote = id.match(/^wrote-([1-9]\d*)$/);
    if (!rev && !refused && !wrote) continue;
    if (!isObject(body)) { diagnostics.push(`${label}: not a JSON object`); continue; }
    if (rev) {
      const n = num(body["rev"]), state = str(body["state"]), cause = str(body["cause"]), hash = str(body["hash"]), at = str(body["at"]);
      if (n === undefined || n !== Number(rev[1]) || !state || !cause || !CAUSES.has(cause) || !hash || !at || !isObject(body["vars"])) {
        diagnostics.push(`${label}: missing or malformed fields`); continue;
      }
      const s: Snapshot = { rev: n, state, vars: body["vars"] as Record<string, JsonValue>, cause: cause as Cause, hash, at, parent: str(body["parent"]) ?? null };
      const call = str(body["call"]); if (call !== undefined) s.call = call;
      const from = str(body["from"]); if (from !== undefined) s.from = from;
      const restores = num(body["restores"]); if (restores !== undefined) s.restores = restores;
      const by = str(body["by"]);
      if (by !== undefined) {
        if (BYS.has(by)) s.by = by as By;
        else diagnostics.push(`${label}: by=${by} is not model, signal or human`);
      }
      const signal = str(body["signal"]); if (signal !== undefined) s.signal = signal;
      const tree = str(body["tree"]); if (tree !== undefined) s.tree = tree;
      snapshots.push(s);
    } else if (refused) {
      const r: Refused = {
        n: Number(refused[1]), rev: num(body["rev"]) ?? -1, at: str(body["at"]) ?? "", tool: str(body["tool"]) ?? "",
        reason: str(body["reason"]) ?? "", diagnostics: Array.isArray(body["diagnostics"]) ? (body["diagnostics"] as JsonValue[]).map(String) : [],
      };
      const call = str(body["call"]); if (call !== undefined) r.call = call;
      const key = str(body["key"]); if (key !== undefined) r.key = key;
      refusals.push(r);
    } else if (wrote) {
      const path = str(body["path"]), tool = str(body["tool"]), at = str(body["at"]), n = num(body["rev"]);
      if (!path || !tool || at === undefined || n === undefined) { diagnostics.push(`${label}: missing or malformed fields`); continue; }
      const w: Wrote = { n: Number(wrote[1]), rev: n, at, tool, path };
      const call = str(body["call"]); if (call !== undefined) w.call = call;
      writes.push(w);
    }
  }
  return { meta, snapshots, refusals, writes, diagnostics };
}

/** The journal as a Markdown revision table with per-step diffs, then its refusals and the files written (`gemflow export --to md`, the board's export). */
export function renderJournalMarkdown(journal: Journal): string {
  const lines = [`# gemflow journal — ${journal.meta.item}`, "", `workflow: \`${journal.meta.workflow}\` (${journal.meta.workflowHash})`, "", "| rev | at | cause | state | call | changes |", "|---|---|---|---|---|---|"];
  let prev: Record<string, JsonValue> = {};
  for (const s of journal.snapshots) {
    const changes: string[] = [];
    for (const k of [...new Set([...Object.keys(prev), ...Object.keys(s.vars)])].sort()) {
      const a = prev[k], b = s.vars[k];
      if (canonical(a ?? null) !== canonical(b ?? null) || (a === undefined) !== (b === undefined)) {
        changes.push(`${k}: ${a === undefined ? "∅" : canonical(a)} → ${b === undefined ? "∅" : canonical(b)}`);
      }
    }
    lines.push(`| ${s.rev} | ${s.at} | ${s.cause} | #${s.state} | ${s.call ?? ""} | ${changes.length ? changes.join("; ") : "—"} |`);
    prev = s.vars;
  }
  if (journal.refusals.length) {
    lines.push("", "## Refused", "");
    for (const r of journal.refusals) lines.push(`- rev ${r.rev} · ${r.tool}${r.call ? ` (${r.call})` : ""}: ${r.reason}${r.diagnostics.length ? " — " + r.diagnostics.join("; ") : ""}`);
  }
  if (journal.writes.length) {
    lines.push("", "## Written", "");
    for (const w of journal.writes) lines.push(`- rev ${w.rev} · ${w.tool}${w.call ? ` (${w.call})` : ""}: ${w.path}`);
  }
  return lines.join("\n");
}

/** The chain, each revision's hash and claims, and — given the statechart — that every transition is one of its transitions. */
export function verifyJournal(journal: Journal, sc?: Statechart): string[] {
  const errors: string[] = [...journal.diagnostics];
  if (journal.snapshots.length === 0) {
    errors.push("the journal holds no revision");
    return errors;
  }
  let prev: Snapshot | undefined;
  let held = false;
  for (const s of journal.snapshots) {
    const label = `#rev-${s.rev}`;
    const expectedRev = prev ? prev.rev + 1 : 0;
    if (s.rev !== expectedRev) errors.push(`${label}: rev is not contiguous (expected ${expectedRev})`);
    if (prev && s.parent !== prev.hash) errors.push(`${label}: parent does not equal the previous hash`);
    if (!prev && s.parent !== null) errors.push(`${label}: the first revision has no parent`);
    if (hashSnapshot(s) !== s.hash) errors.push(`${label}: hash does not match its content`);
    if ((s.cause === "transition" || s.cause === "rollback") && s.from === undefined) errors.push(`${label}: cause ${s.cause} needs from`);
    if (s.cause === "rollback" && (s.restores === undefined || s.restores >= s.rev || !journal.snapshots.some((x) => x.rev === s.restores))) errors.push(`${label}: restores must name an earlier revision`);
    if (s.by === "signal" && s.signal === undefined) errors.push(`${label}: by=signal needs signal`);
    if (s.signal !== undefined && s.by !== "signal") errors.push(`${label}: signal needs by=signal`);
    if (s.cause === "expire" && s.by !== "signal") errors.push(`${label}: cause expire needs by=signal`);
    if (s.cause === "pause" || s.cause === "resume") {
      if (s.by !== "human") errors.push(`${label}: cause ${s.cause} needs by=human`);
      if (prev && (s.state !== prev.state || canonical(s.vars) !== canonical(prev.vars))) errors.push(`${label}: cause ${s.cause} keeps the state and the variables`);
      if ((s.cause === "pause") === held) errors.push(`${label}: ${s.cause} while the work item is ${held ? "already paused" : "not paused"}`);
    }
    held = s.cause === "pause" ? true : s.cause === "resume" || s.cause === "enter" ? false : held;
    if (sc) {
      if (s.signal !== undefined && !sc.signalVars.has(s.signal)) errors.push(`${label}: signal ${s.signal} is not a variable with a source`);
      if (!sc.states.has(s.state)) errors.push(`${label}: state ${s.state} is not in the statechart`);
      if (s.cause === "transition" && s.from !== undefined && !outgoing(sc, s.from).some((t) => t.to === s.state)) {
        errors.push(`${label}: no transition ${s.from}→${s.state} in the statechart`);
      }
    }
    prev = s;
  }
  return errors;
}
