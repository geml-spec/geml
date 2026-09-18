// The ledger: the run's record of truth, a geml-agent/v1 document written by
// blind append. Rendering is text out; reading parses with @geml/geml.
import { parse, type Block } from "@geml/geml";
import { canonical, hashSnapshot, type Cause, type Snapshot } from "./snapshot.js";
import { outgoing, type Statechart } from "./statechart.js";
import type { JsonValue } from "./schema.js";

export interface LedgerMeta { session: string; statechart: string; statechartHash: string; created: string }
export interface Refused { n: number; rev: number; at: string; tool: string; call?: string; reason: string; diagnostics: string[] }
export interface Ledger { meta: LedgerMeta; snapshots: Snapshot[]; refusals: Refused[]; diagnostics: string[] }

const CAUSES: ReadonlySet<string> = new Set(["enter", "transition", "patch", "rollback", "error-rollback"]);

/** Attribute value spelling: bare when it is a plain word, quoted otherwise. Numbers stay bare. */
function attr(v: string | number): string {
  if (typeof v === "number") return String(v);
  return /^[A-Za-z0-9_#-]+$/.test(v) ? v : JSON.stringify(v);
}

export function renderLedgerHead(meta: LedgerMeta): string {
  return [
    "=== meta",
    'title           = "geml-agent ledger"',
    'profile         = "geml-agent/v1"',
    `session         = ${JSON.stringify(meta.session)}`,
    `statechart      = ${JSON.stringify(meta.statechart)}`,
    `statechart-hash = ${JSON.stringify(meta.statechartHash)}`,
    `created         = ${JSON.stringify(meta.created)}`,
    "===",
    "",
    "",
  ].join("\n");
}

export function renderSnapshotBlock(s: Snapshot): string {
  const parts = [`#rev-${s.rev}`, `rev=${s.rev}`, `state=#${s.state}`, `cause=${s.cause}`];
  if (s.parent !== undefined) parts.push(`parent=${attr(s.parent)}`);
  parts.push(`hash=${attr(s.hash)}`, `at=${attr(s.at)}`);
  if (s.call !== undefined) parts.push(`call=${attr(s.call)}`);
  if (s.from !== undefined) parts.push(`from=#${s.from}`);
  if (s.restores !== undefined) parts.push(`restores=${s.restores}`);
  return `=== agent-snapshot {${parts.join(" ")}}\n${canonical(s.vars)}\n===\n\n`;
}

export function renderRefusedBlock(r: Refused): string {
  const parts = [`#refused-${r.n}`, `rev=${r.rev}`, `at=${attr(r.at)}`, `tool=${attr(r.tool)}`];
  if (r.call !== undefined) parts.push(`call=${attr(r.call)}`);
  const body = canonical({ reason: r.reason, diagnostics: r.diagnostics });
  return `=== agent-refused {${parts.join(" ")}}\n${body}\n===\n\n`;
}

type Typed = Extract<Block, { kind: "block" }>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function readLedger(source: string): Ledger {
  const doc = parse(source);
  const diagnostics: string[] = doc.diagnostics.filter((d) => d.severity === "error").map((d) => `line ${d.line}: ${d.message}`);
  const meta: LedgerMeta = { session: "", statechart: "", statechartHash: "", created: "" };
  const snapshots: Snapshot[] = [];
  const refusals: Refused[] = [];
  for (const b of doc.children) {
    if (b.kind !== "block") continue;
    const blk = b as Typed;
    if (blk.type === "meta" && blk.data) {
      meta.session = str(blk.data["session"]) ?? meta.session;
      meta.statechart = str(blk.data["statechart"]) ?? meta.statechart;
      meta.statechartHash = str(blk.data["statechart-hash"]) ?? meta.statechartHash;
      meta.created = str(blk.data["created"]) ?? meta.created;
      if (str(blk.data["profile"]) !== "geml-agent/v1") diagnostics.push("meta: profile is not geml-agent/v1");
      continue;
    }
    const label = `#${blk.id ?? "?"}`;
    let body: JsonValue;
    try { body = JSON.parse((blk.raw ?? []).join("\n")) as JsonValue; }
    catch { if (blk.type === "agent-snapshot" || blk.type === "agent-refused") diagnostics.push(`${label}: body is not JSON`); continue; }
    if (blk.type === "agent-snapshot") {
      const a = blk.attrs;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        diagnostics.push(`${label}: body is not a JSON object`); continue;
      }
      const rev = num(a["rev"]), state = str(a["state"]), cause = str(a["cause"]), hash = str(a["hash"]), at = str(a["at"]);
      if (rev === undefined || !state?.startsWith("#") || !cause || !CAUSES.has(cause) || !hash || !at) {
        diagnostics.push(`${label}: missing or malformed attributes`); continue;
      }
      const s: Snapshot = { v: 1, rev, state: state.slice(1), vars: body as Record<string, JsonValue>, cause: cause as Cause, hash, at };
      const parent = str(a["parent"]); if (parent !== undefined) s.parent = parent;
      const call = str(a["call"]); if (call !== undefined) s.call = call;
      const from = str(a["from"]); if (from !== undefined && from.startsWith("#")) s.from = from.slice(1);
      const restores = num(a["restores"]); if (restores !== undefined) s.restores = restores;
      snapshots.push(s);
    } else if (blk.type === "agent-refused") {
      const a = blk.attrs;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        diagnostics.push(`${label}: body is not a JSON object`); continue;
      }
      const rec = body as Record<string, JsonValue>;
      const r: Refused = {
        n: Number((blk.id ?? "refused-0").replace(/^refused-/, "")),
        rev: num(a["rev"]) ?? -1, at: str(a["at"]) ?? "", tool: str(a["tool"]) ?? "",
        reason: str(rec["reason"]) ?? "", diagnostics: Array.isArray(rec["diagnostics"]) ? (rec["diagnostics"] as JsonValue[]).map(String) : [],
      };
      const call = str(a["call"]); if (call !== undefined) r.call = call;
      refusals.push(r);
    }
  }
  return { meta, snapshots, refusals, diagnostics };
}

export function verifyLedger(ledger: Ledger, sc?: Statechart): string[] {
  const errors: string[] = [...ledger.diagnostics];
  if (ledger.snapshots.length === 0) {
    errors.push("the ledger holds no revision");
    return errors;
  }
  let prev: Snapshot | undefined;
  for (const s of ledger.snapshots) {
    const label = `#rev-${s.rev}`;
    const expectedRev = prev ? prev.rev + 1 : 0;
    if (s.rev !== expectedRev) errors.push(`${label}: rev is not contiguous (expected ${expectedRev})`);
    if (prev && s.parent !== prev.hash) errors.push(`${label}: parent does not equal the previous hash`);
    if (!prev && s.parent !== undefined) errors.push(`${label}: the first revision has no parent`);
    const recomputed = hashSnapshot({ v: 1, rev: s.rev, ...(s.parent !== undefined ? { parent: s.parent } : {}), state: s.state, vars: s.vars });
    if (recomputed !== s.hash) errors.push(`${label}: hash does not match its content`);
    if ((s.cause === "transition" || s.cause === "rollback" || s.cause === "error-rollback") && s.from === undefined) errors.push(`${label}: cause ${s.cause} needs from=`);
    if (s.cause === "rollback" || s.cause === "error-rollback") {
      if (s.restores === undefined || s.restores >= s.rev || !ledger.snapshots.some((x) => x.rev === s.restores)) errors.push(`${label}: restores must name an earlier revision`);
    }
    if (sc) {
      if (!sc.states.has(s.state)) errors.push(`${label}: state #${s.state} is not in the statechart`);
      if (s.cause === "transition" && s.from !== undefined && !outgoing(sc, s.from).some((t) => t.to === s.state)) {
        errors.push(`${label}: no transition #${s.from} → #${s.state} in the statechart`);
      }
    }
    prev = s;
  }
  return errors;
}
