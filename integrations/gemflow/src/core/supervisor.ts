// The supervisor: what is allowed right now, with no host in sight.
//
// An adapter translates these answers into its host's API and translates the
// host's tool events back into this alphabet. Every gate DECISION lives here,
// so a host difference can only ever be a difference in mechanism, never in
// policy. test/purity.test.mjs pins that nothing here touches the file system.
import type { JsonValue } from "./schema.js";
import { outgoing, type State, type Statechart, type Transition } from "./statechart.js";
import { scopeIn } from "./policy.js";
import { guardHolds, hasExpirable, type Meta, type Refusal, type Snapshot } from "./snapshot.js";
import { resumeRun, startRun, type Run } from "./run.js";
import type { JournalMeta } from "./journal.js";
import { commandOf, personOnlyRefusal, switchesWorkItemOnly } from "./command-line.js";
import { decide, fencedRefusal, fencedRow, keysOf, usesOf, type Decision, type Dictionary, type Scope } from "./dictionary.js";
import { commandSignals, toolSignals, type CommandOutcome, type SignalValue, elapsedSignals } from "./signals.js";
import { moveSpec, setSpec, statusSpec, type ToolSpec } from "./tools.js";
import { renderContext } from "./prompt.js";
import { isOwnTool, verbOf } from "./verb-specs.js";
import type { HostTools } from "./host-tools.js";

/** The verbs this supervisor carries out (`invoke`); `status` is read elsewhere. */
export const VERBS: readonly string[] = ["move", "set"];

/** What the supervisor needs from its host: a journal sink, a clock, its tools and dictionary, optional hooks. */
export interface SupervisorHost {
  /** Append one journal block. Where it goes is the host's business. */
  append(block: string): void;
  /** The clock, as an ISO string. */
  now(): string;
  /** The state or the variables changed. Called after every accepted action. */
  changed?(): void;
  /** The tools this host runs commands and writes files with. */
  tools: HostTools;
  /** The workflow's tool dictionary as it stands. */
  dictionary: Dictionary;
  /** The work item's content fingerprint for this operation, when it could be read: `tool` evidence expires on a change. Read only when evidence is written or may expire: a host may make it a getter that reads it then. */
  readonly tree?: string;
  /** Whether a name is an existing local branch, for `git checkout <branch>` as a way out (switchesWorkItemOnly); absent, that form never is one. */
  isBranch?(name: string): boolean;
}

/** Why a transition is refused while a person holds the work item (spec §5.5). */
export const PAUSED_REASON = "the work item is paused; a person resumes it on the Gemflow board or with `gemflow resume`";

/** What a refusal adds: the way out that every state admits. */
export const WAY_OUT = "switching the work item is always allowed: git switch <branch>, git switch -c <branch>, git checkout -b <branch>, git worktree add <path>, cd <path>";

/** The verbs as a host that registers tools per state should see them for the state now (dsh). */
export interface Specs { status: ToolSpec; move: ToolSpec | null; set: ToolSpec | null }

/** A verb's outcome. `context`: the new stage text, when the caller keeps a context document and the verb changed the stage. */
export type Invoked =
  | { ok: true; result: Record<string, JsonValue>; context?: string }
  | { ok: false; reason: string };

/** A gate's answer to a call before it runs. */
export type Gate =
  /** `unknown`: keys no row takes, let through unclassified (spec §5.3). */
  | { kind: "allow"; uses: string[]; unknown?: string[] }
  | { kind: "refuse"; reason: string };

/** A refusal's text as the model should read it: the reason, then the detail. */
function refusalText(reason: string, diagnostics: readonly string[]): string {
  return diagnostics.length ? `${reason}\n${diagnostics.join("\n")}` : reason;
}

/** `{at, call}` for the journal; `call` is omitted rather than left undefined. */
export function metaFor(at: string, callId?: unknown): Meta {
  return callId === undefined ? { at } : { at, call: String(callId) };
}

/** The machine-judged, approval-free transition out of a state, when there is one. */
function autoEdge(sc: Statechart, stateId: string): Transition | undefined {
  return outgoing(sc, stateId).find((t) => t.judge === "machine" && !t.approval);
}

/**
 * Take the current state's machine-judged transition while its guard holds,
 * recording for each the actor whose change made it hold. The walk stops
 * where it would enter a state it has already been in during this call (the
 * one it began in included), so a cycle of such transitions cannot spin.
 *
 * `left` is the state a transition has just left, when this walk follows one
 * (a model's, a person's): the first automatic transition may not take the
 * workflow straight back to it, or a person who sent the workflow back could
 * never stay. Only the state just left is barred, and only for this change.
 */
function takeAutoEdges(sc: Statechart, run: Run, actorFor: (edge: Transition) => Meta, append: (block: string) => void, left?: string): string[] {
  const entered: string[] = [];
  const seen = new Set<string>([run.snapshot.state]);
  for (;;) {
    const edge = autoEdge(sc, run.snapshot.state);
    if (!edge || !guardHolds(sc, edge, run.snapshot.vars) || seen.has(edge.to) || edge.to === left) break;
    seen.add(edge.to);
    const adv = run.transition(edge.to, actorFor(edge));
    append(adv.block);
    if (!adv.ok) break;
    entered.push(edge.to);
    left = undefined;
  }
  return entered;
}

export class Supervisor {
  readonly sc: Statechart;
  readonly run: Run;
  private readonly host: SupervisorHost;
  private notice = "";

  constructor(sc: Statechart, run: Run, host: SupervisorHost) {
    this.sc = sc;
    this.run = run;
    this.host = host;
  }

  get verbs(): readonly string[] {
    return VERBS;
  }

  /** The three verbs of spec §8.5, bare or as a host lists them (`isOwnTool`). */
  owns(toolName: string): boolean {
    return isOwnTool(toolName);
  }

  get snapshot(): Snapshot {
    return this.run.snapshot;
  }

  /** Whether a person holds the work item (spec §5.5). */
  get paused(): boolean {
    return this.run.paused;
  }

  state(): State | undefined {
    return this.sc.states.get(this.run.snapshot.state);
  }

  /** A line appended to every context snapshot — used when the workflow changed. */
  setNotice(text: string): void {
    this.notice = text;
  }

  /** The dictionary's reading of this state (spec §5.3). */
  private scope(): Scope {
    return scopeIn(this.sc, this.run.snapshot.state);
  }

  /** Why a command line is refused for a fenced use in this state, or undefined — for a host whose command the sh scanners cannot read (pwsh). */
  fencedRefusal(command: string): string | undefined {
    return fencedRefusal(this.host.dictionary, this.scope(), command);
  }

  /** The keys of a call on this host. */
  keys(toolName: string, input?: Record<string, unknown>): string[] {
    return keysOf(toolName, input, this.host.tools.run, this.host.tools.write);
  }

  /**
   * The gate before a call (spec §5.3). The rules that hold in every state
   * first: a person-only command is refused; a line that only switches the
   * work item is the way out of every state; the supervisor's own tools pass.
   * Then the fenced uses anywhere in a command line, and the dictionary's
   * decision on the call's keys. Deny-only by construction: nothing here
   * grants more than the dictionary does. A refusal is recorded.
   */
  gate(toolName: string, callId?: unknown, input?: Record<string, unknown>, waived: readonly string[] = []): Gate {
    if (this.owns(toolName)) return { kind: "allow", uses: [] };
    const scope = this.scope();
    const command = commandOf(input);
    if (command !== undefined) {
      const hard = personOnlyRefusal(command);
      if (hard) return { kind: "refuse", reason: this.refuse(toolName, hard, callId) };
      if (switchesWorkItemOnly(command, this.host.isBranch ? (name) => this.host.isBranch!(name) : undefined)) return { kind: "allow", uses: [] };
      // A person waived the fenced pattern for this one call (the board's "allow once"): the fence stands aside, nothing is learned.
      const row = fencedRow(this.host.dictionary, scope, command);
      const fenced = row !== undefined && !waived.includes(row.tool) ? fencedRefusal(this.host.dictionary, scope, command) : undefined;
      if (fenced) return { kind: "refuse", reason: this.refuse(toolName, `${fenced}; ${WAY_OUT}`, callId, row?.tool) };
    }
    const d: Decision = decide(this.host.dictionary, scope, this.keys(toolName, input).filter((k) => !waived.includes(k)));
    if (d.kind === "refuse") return { kind: "refuse", reason: this.refuse(toolName, `${d.reasons.join("; ")}; ${WAY_OUT}`, callId, d.keys[0]) };
    return { kind: "allow", uses: d.uses, ...(d.unknown.length > 0 ? { unknown: d.unknown } : {}) };
  }

  /** The gate as a reason to refuse, or undefined. */
  deny(toolName: string, callId?: unknown, input?: Record<string, unknown>): string | undefined {
    const g = this.gate(toolName, callId, input);
    return g.kind === "refuse" ? g.reason : undefined;
  }

  /** Record that the work wrote `path`, a project path: once per file per stage entry (Run.wrote). */
  recordWrite(toolName: string, path: string, callId?: unknown): void {
    const block = this.run.wrote(toolName, path, metaFor(this.host.now(), callId));
    if (block !== null) this.host.append(block);
  }

  /** Turn a call away: record it (with the key the gate judged, when it judged one), and say why. */
  refuse(toolName: string, reason: string, callId?: unknown, key?: string): string {
    this.host.append(this.run.refuse({ tool: toolName, reason, diagnostics: [], ...(key !== undefined ? { key } : {}) }, metaFor(this.host.now(), callId)));
    return reason;
  }

  /** The verbs for a host that registers tools per state; recomputed from the state, so `move`'s enum cannot drift from the transitions. */
  specs(): Specs {
    return { status: statusSpec(), move: moveSpec(this.sc, this.run.snapshot), set: setSpec(this.sc, this.run.snapshot) };
  }

  /** A model verb: the journal append, and the result. */
  invoke(name: string, args: Record<string, unknown>, meta: Meta): Invoked {
    const by: Meta = { ...meta, by: "model" };
    switch (verbOf(name)) {
      case "move": return this.doMove(args, by);
      case "set": return this.doSet(args, by);
      default: return { ok: false, reason: `gemflow does not own the tool ${name}` };
    }
  }

  private record(refusal: Refusal, meta: Meta): void {
    this.host.append(this.run.refuse(refusal, meta));
  }

  /** `move` takes a transition the model judges or one with no guard; a machine-judged one is taken on its own, one with approval by a person. */
  private doMove(args: Record<string, unknown>, meta: Meta): Invoked {
    const to = String(args["to"]);
    const edge = outgoing(this.sc, this.run.snapshot.state).find((t) => t.to === to);
    if (!edge) return { ok: false, reason: `no transition ${this.run.snapshot.state}→${to}` };
    let reason: string | undefined;
    if (this.run.paused) reason = `${edge.name}: ${PAUSED_REASON}`;
    else if (edge.approval) reason = `${edge.name} needs a person: they approve it on the Gemflow board or with \`gemflow advance ${to}\``;
    else if (edge.judge === "machine") reason = `${edge.name} is taken on its own when its guard holds (${edge.reads.join(", ")}); it is not yours to take`;
    if (reason !== undefined) {
      this.record({ tool: "move", reason, diagnostics: [] }, meta);
      return { ok: false, reason };
    }
    const advance = this.run.transition(to, meta);
    this.host.append(advance.block);
    if (!advance.ok) return { ok: false, reason: refusalText(advance.refusal.reason, advance.refusal.diagnostics) };
    const entered = this.autoAdvance(() => meta, advance.snapshot.from);
    this.host.changed?.();
    const end = this.run.snapshot;
    return { ok: true, result: { from: advance.snapshot.from ?? "", to, state: end.state, entered, rev: end.rev, hash: end.hash } };
  }

  private doSet(args: Record<string, unknown>, meta: Meta): Invoked {
    const patch: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(args)) if (value !== undefined) patch[key] = value as JsonValue;
    const advance = this.run.set(patch, meta);
    this.host.append(advance.block);
    if (!advance.ok) return { ok: false, reason: refusalText(advance.refusal.reason, advance.refusal.diagnostics) };
    // A guard reads the variables, so writing one can open a transition.
    const entered = this.autoAdvance(() => meta);
    this.host.changed?.();
    const end = this.run.snapshot;
    return { ok: true, result: { rev: end.rev, hash: end.hash, vars: end.vars, state: end.state, entered } };
  }

  /** A person's rollback (`gemflow rollback`): the recorded state only, never what a command already did. */
  rollback(target: number | "checkpoint", meta: Meta): { ok: true; rev: number; restores: number; state: string; entered: string[] } | { ok: false; reason: string } {
    const advance = this.run.rollback(target, { ...meta, by: "human" });
    this.host.append(advance.block);
    if (!advance.ok) return { ok: false, reason: refusalText(advance.refusal.reason, advance.refusal.diagnostics) };
    const entered = this.autoAdvance(() => ({ ...meta, by: "human" }));
    this.host.changed?.();
    const end = this.run.snapshot;
    return { ok: true, rev: end.rev, restores: advance.snapshot.restores ?? advance.snapshot.rev, state: end.state, entered };
  }

  /**
   * Evidence expiry, at the start of an operation: the `tool` variables whose
   * content changed since their evidence was written return to their defaults
   * in one revision; then the automatic transitions that hold are taken.
   * Nothing without the operation's content fingerprint.
   */
  expire(meta: Meta): { expired: boolean; entered: string[] } {
    // A work item in a final state is closed: what it bore when it got there stays.
    if (this.sc.states.get(this.run.snapshot.state)?.final === true) return { expired: false, entered: [] };
    // Nothing written on some content: nothing a change of it could expire, and the content is not read.
    if (!hasExpirable(this.sc, this.run.history)) return { expired: false, entered: [] };
    const tree = this.host.tree;
    const done = tree === undefined ? null : this.run.expire(tree, meta);
    if (done === null) return { expired: false, entered: [] };
    this.host.append(done.block);
    const signal = done.snapshot.signal as string;
    const entered = this.autoAdvance(() => ({ ...meta, by: "signal", signal }));
    this.host.changed?.();
    return { expired: true, entered };
  }

  /** Write each variable's value; then take automatic transitions while one holds. */
  /** The clock's evidence (spec §3.6): the `elapsed` variables as of `meta.at`; nothing in a final state, where the work item is closed. */
  elapse(meta: Meta): { wrote: string[]; entered: string[] } {
    if (this.sc.states.get(this.run.snapshot.state)?.final === true) return { wrote: [], entered: [] };
    return this.applySignals(elapsedSignals(this.sc, this.run.history, meta.at), meta);
  }

  applySignals(values: readonly SignalValue[], meta: Meta): { wrote: string[]; entered: string[] } {
    const wrote: string[] = [];
    for (const v of values) {
      const adv = this.run.signal(v.id, v.value, meta, this.host.tree);
      if (adv === null) continue;
      this.host.append(adv.block);
      if (adv.ok) wrote.push(v.id);
    }
    const entered = wrote.length === 0 ? [] : this.autoAdvance((edge) => ({ ...meta, by: "signal", signal: this.openedBy(wrote, edge) }));
    if (wrote.length > 0) this.host.changed?.();
    return { wrote, entered };
  }

  /** Which of the variables just written opened `edge`'s guard: the first the guard reads, else the last one written. */
  private openedBy(wrote: readonly string[], edge: Transition): string {
    return wrote.find((name) => edge.reads.includes(name)) ?? (wrote[wrote.length - 1] as string);
  }

  /** A call that ran a command line finished: its exit status is `tool` evidence for the uses its commands are bound to. */
  observeCommand(outcome: CommandOutcome, meta: Meta): { wrote: string[]; entered: string[] } {
    return this.applySignals(commandSignals(this.sc, this.host.dictionary, this.run.snapshot.state, outcome), meta);
  }

  /** Any other call finished: `ok` is `tool` evidence for the use its key is bound to. */
  observeCall(toolName: string, input: Record<string, unknown> | undefined, ok: boolean, meta: Meta): { wrote: string[]; entered: string[] } {
    if (this.owns(toolName)) return { wrote: [], entered: [] };
    const keys = this.keys(toolName, input);
    return this.applySignals(toolSignals(this.sc, this.host.dictionary, this.run.snapshot.state, keys, ok), meta);
  }

  /** The uses a call's keys are bound to, in this state. */
  usesOfCall(toolName: string, input?: Record<string, unknown>): string[] {
    return usesOf(this.host.dictionary, this.scope(), this.keys(toolName, input));
  }

  /** A person moved the workflow (board or terminal). Approval is the act itself; a guard written beside it must hold. */
  humanTransition(to: string, meta: Meta): { ok: true; entered: string[] } | { ok: false; reason: string } {
    if (!outgoing(this.sc, this.run.snapshot.state).some((t) => t.to === to)) {
      return { ok: false, reason: `no transition ${this.run.snapshot.state}→${to}` };
    }
    if (this.run.paused) return { ok: false, reason: PAUSED_REASON };
    const actor: Meta = { ...meta, by: "human" };
    const adv = this.run.transition(to, actor);
    this.host.append(adv.block);
    if (!adv.ok) return { ok: false, reason: refusalText(adv.refusal.reason, adv.refusal.diagnostics) };
    const entered = [to, ...this.autoAdvance(() => actor, adv.snapshot.from)];
    this.host.changed?.();
    return { ok: true, entered };
  }

  /** A person ticked or cleared a variable whose source is a person. */
  mark(name: string, checked: boolean, meta: Meta): { ok: true; wrote: string[]; entered: string[] } | { ok: false; reason: string } {
    const v = this.sc.vars.get(name);
    if (!v) return { ok: false, reason: `no variable "${name}" in the workflow` };
    if (v.source?.kind !== "human") return { ok: false, reason: v.source === undefined ? `${name} is the model's to set, not a person's to tick` : `${name} reads its value from ${v.source.kind === "tool" ? `the use ${v.source.use}` : v.source.kind}; only a variable whose source is "human" is ticked` };
    return { ok: true, ...this.applySignals([{ id: name, value: checked }], meta) };
  }

  /**
   * A person holds the work item (spec §5.5): evidence goes on being recorded,
   * but no transition is taken, the model's, a person's or the machine's, until
   * they let it go.
   */
  pause(meta: Meta): { ok: true } | { ok: false; reason: string } {
    const adv = this.run.hold(true, { ...meta, by: "human" });
    this.host.append(adv.block);
    if (!adv.ok) return { ok: false, reason: refusalText(adv.refusal.reason, adv.refusal.diagnostics) };
    this.host.changed?.();
    return { ok: true };
  }

  /** A person lets the work item go: the machine-judged transition that came to hold meanwhile is taken now, as theirs. */
  resume(meta: Meta): { ok: true; entered: string[] } | { ok: false; reason: string } {
    const actor: Meta = { ...meta, by: "human" };
    const adv = this.run.hold(false, actor);
    this.host.append(adv.block);
    if (!adv.ok) return { ok: false, reason: refusalText(adv.refusal.reason, adv.refusal.diagnostics) };
    const entered = this.autoAdvance(() => actor);
    this.host.changed?.();
    return { ok: true, entered };
  }

  /** Take the automatic transitions that hold from the current state, appending to the host's journal; `left` is the state a transition just left. Nothing while a person holds the item. */
  private autoAdvance(actorFor: (edge: Transition) => Meta, left?: string): string[] {
    if (this.run.paused) return [];
    return takeAutoEdges(this.sc, this.run, actorFor, (block) => this.host.append(block), left);
  }

  /** The state's own description. */
  instruction(): string {
    const s = this.state();
    return s === undefined ? "" : `${s.title}${s.description ? ` — ${s.description}` : ""}`;
  }

  /** The per-step snapshot, a few hundred bytes; while a person holds the item, a line saying so. */
  context(): string {
    const text = renderContext(this.sc, this.run.snapshot, this.host.dictionary);
    const held = this.run.paused ? `${text}\n[gemflow] paused: ${PAUSED_REASON}` : text;
    return this.notice ? `${held}\n${this.notice}` : held;
  }
}

export interface OpenOptions {
  sc: Statechart;
  /** The work item this run belongs to; goes in the journal head. */
  item: string;
  /** The workflow's path, for the journal head. */
  workflowFile: string;
  /** The journal as it stands, or null when there is none yet. */
  journalText: string | null;
  /** Why the session started. `clear` re-enters the initial state on the same chain. */
  source: string;
  now: string;
  /**
   * Where a fresh run starts: the state its work item says it stands in (a
   * file unit's item file, on a machine the journal never reached). Absent,
   * or a state the statechart does not have, the initial one.
   */
  startAt?: string;
}

export type Opened =
  | { ok: true; run: Run; head: string; blocks: string[]; notice: string; note?: string }
  | { ok: false; reason: string };

/**
 * Decide, without any I/O, what opening a run means: fresh or resumed, which
 * blocks the host must append, and whether the workflow moved underneath it.
 * The chain is verified before it is trusted — `resumeRun` does that.
 */
export function openRun(o: OpenOptions): Opened {
  const meta: JournalMeta = { item: o.item, workflow: o.workflowFile, workflowHash: o.sc.hash, created: o.now };
  const fresh = startRun(o.sc, meta, o.now, o.startAt !== undefined && o.sc.states.has(o.startAt) ? o.startAt : o.sc.initial);
  // Entering the initial state is a change like any other: an automatic transition whose guard already holds there is taken at once.
  const entry = { at: o.now };
  if (o.journalText === null) {
    const blocks = [fresh.block];
    takeAutoEdges(o.sc, fresh.run, () => entry, (block) => blocks.push(block));
    return { ok: true, run: fresh.run, head: fresh.head, blocks, notice: "" };
  }
  const resumed = resumeRun(o.sc, o.journalText);
  if (!resumed.ok) return { ok: false, reason: resumed.reason };
  const blocks: string[] = [];
  if (o.source === "clear") {
    blocks.push(resumed.run.reenter(o.now).block);
    takeAutoEdges(o.sc, resumed.run, () => entry, (block) => blocks.push(block));
  }
  return {
    ok: true, run: resumed.run, head: fresh.head, blocks,
    notice: resumed.note ? "[gemflow] the workflow changed since this run started; the current state still exists and the run continues." : "",
    ...(resumed.note ? { note: resumed.note } : {}),
  };
}
