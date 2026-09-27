// The run's state: one immutable Snapshot per revision, hash-chained. The three
// verbs compute a candidate, validate it, and either return it or a Refusal —
// a refused change produces no snapshot, so the ledger never holds a bad one.
import { createHash } from "node:crypto";
import { defaultsOf, validate, type JsonValue } from "./schema.js";
import { allowedVars, outgoing, type Statechart } from "./statechart.js";

export type Cause = "enter" | "transition" | "patch" | "rollback" | "error-rollback";

export interface Snapshot {
  v: 1;
  rev: number;
  state: string;
  vars: Record<string, JsonValue>;
  cause: Cause;
  parent?: string;
  hash: string;
  at: string;
  call?: string;
  from?: string;
  restores?: number;
}
export interface Refusal { tool: "agent_transition" | "agent_set" | "agent_rollback"; reason: string; diagnostics: string[] }
export type Outcome = { ok: true; next: Snapshot } | { ok: false; refusal: Refusal };
export interface Meta { at: string; call?: string }

/**
 * Compare two strings by Unicode CODE POINT, not UTF-16 code unit. JS's `<`
 * (and `Array.sort`'s default) compares UTF-16 code units, so an astral
 * character's lead surrogate (e.g. U+1F600 encodes as 0xD83D 0xDE00) can sort
 * BELOW a BMP character with a higher code point (U+FF00 is 0xFF00) — the
 * comparison gets the order backwards for exactly the characters "sorted by
 * code point" exists to place correctly. Spreading a string iterates by code
 * point (surrogate pairs combine into one element), so comparing those
 * elements pairwise is correct where `<` on the raw strings is not.
 */
function compareByCodePoint(a: string, b: string): number {
  const as = [...a];
  const bs = [...b];
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const diff = as[i]!.codePointAt(0)! - bs[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return as.length - bs.length;
}

/** Canonical JSON: keys sorted by code point, no whitespace. The hashed form. */
export function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort(compareByCodePoint);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k] as JsonValue)).join(",") + "}";
}

export function hashSnapshot(s: { v: 1; rev: number; parent?: string; state: string; vars: Record<string, JsonValue> }): string {
  const payload = canonical({ v: s.v, rev: s.rev, parent: s.parent ?? null, state: s.state, vars: s.vars });
  return "sha256:" + createHash("sha256").update(payload, "utf8").digest("hex");
}

function seal(s: Omit<Snapshot, "hash">): Snapshot {
  const out: Snapshot = { ...s, hash: hashSnapshot({ v: 1, rev: s.rev, ...(s.parent !== undefined ? { parent: s.parent } : {}), state: s.state, vars: s.vars }) };
  return out;
}

function child(prev: Snapshot, meta: Meta, fields: Partial<Snapshot> & { state: string; vars: Record<string, JsonValue>; cause: Cause }): Snapshot {
  const base: Omit<Snapshot, "hash"> = { v: 1, rev: prev.rev + 1, parent: prev.hash, at: meta.at, ...fields };
  if (meta.call !== undefined) base.call = meta.call;
  return seal(base);
}

export function initialSnapshot(sc: Statechart, at: string): Snapshot {
  return seal({ v: 1, rev: 0, state: sc.initial, vars: sc.vars ? defaultsOf(sc.vars) : {}, cause: "enter", at });
}

/** `clear`: a fresh start recorded on the same chain. */
export function reenterSnapshot(sc: Statechart, prev: Snapshot, at: string): Snapshot {
  return child(prev, { at }, { state: sc.initial, vars: sc.vars ? defaultsOf(sc.vars) : {}, cause: "enter", from: prev.state });
}

const refuse = (tool: Refusal["tool"], reason: string, diagnostics: string[] = []): Outcome => ({ ok: false, refusal: { tool, reason, diagnostics } });

export function applyPatch(sc: Statechart, snap: Snapshot, patch: Record<string, JsonValue>, meta: Meta): Outcome {
  const state = sc.states.get(snap.state);
  if (!state) return refuse("agent_set", `current state #${snap.state} is not in the statechart`);
  const declared = new Set(Object.keys(sc.vars?.properties ?? {}));
  const allowed = new Set(allowedVars(sc, state));
  for (const k of Object.keys(patch)) {
    if (!declared.has(k)) return refuse("agent_set", `"${k}" is not a declared variable`);
    if (!allowed.has(k)) return refuse("agent_set", `"${k}" cannot be set in state #${state.id}`);
  }
  const merged: Record<string, JsonValue> = { ...snap.vars, ...patch };
  const diagnostics = sc.vars ? validate(sc.vars, merged) : [];
  if (diagnostics.length) return refuse("agent_set", `patch rejected by agent-vars schema`, diagnostics);
  return { ok: true, next: child(snap, meta, { state: snap.state, vars: merged, cause: "patch" }) };
}

export function applyTransition(sc: Statechart, snap: Snapshot, to: string, meta: Meta): Outcome {
  const t = outgoing(sc, snap.state).find((x) => x.to === to);
  if (!t) return refuse("agent_transition", `no transition from #${snap.state} to #${to}`);
  if (t.requires) {
    const diagnostics = validate(t.requires, snap.vars);
    if (diagnostics.length) return refuse("agent_transition", `transition #${t.id}: requires #${t.requiresId} failed`, diagnostics);
  }
  return { ok: true, next: child(snap, meta, { state: t.to, vars: snap.vars, cause: "transition", from: snap.state }) };
}

/** The revision at which the current state was entered: the last non-patch revision. */
export function checkpointRev(history: readonly Snapshot[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.cause !== "patch") return history[i]!.rev;
  }
  return 0;
}

export function applyRollback(sc: Statechart, history: readonly Snapshot[], target: number | "checkpoint", meta: Meta, cause: "rollback" | "error-rollback" = "rollback"): Outcome {
  const current = history[history.length - 1];
  if (!current) return refuse("agent_rollback", "no revision to roll back from");
  const rev = target === "checkpoint" ? checkpointRev(history) : target;
  const found = history.find((s) => s.rev === rev);
  if (!found) return refuse("agent_rollback", `revision ${rev} does not exist`);
  if (!sc.states.has(found.state)) return refuse("agent_rollback", `revision ${rev} is in state #${found.state}, which the statechart no longer has`);
  return { ok: true, next: child(current, meta, { state: found.state, vars: found.vars, cause, from: current.state, restores: rev }) };
}
