// Gemflow's Claude Code shell. This module runs with no Node and no DOM: from
// the latest policy snapshot it decides whether a tool call can matter to the
// workflow, and asks the bundled CLI (dist/gemflow.mjs: one JSON request on
// stdin, one JSON answer on stdout) only when it can. It never writes a
// project file — journals, .geml/context.geml, the dictionary, the backlog and
// the exports belong to the CLI, which writes them under locks. Gemflow fails
// open: when Node is missing, the bridge fails or times out, or an answer does
// not parse, the call goes through, nothing is recorded, and the band says
// what is wrong; a start that got no answer is tried again by a later tool
// call, prompt or /gemflow, at most once a minute. Each tool call carries the
// directory it starts in, and one that may act in another checkout (a
// worktree, another repository) always goes to the bridge, which attributes
// it to that checkout's work item; the band stays on the session's. A
// main-loop call carries the stage the main loop last read, so an answer on
// another work item (a branch switch, another episode) hands that item over
// in the result. A call no row of the dictionary takes goes through: whether
// it is safe is Claude Code's permission system's call, not the workflow's.
// The one question asked here, with $.ui.ask, is about a tool that is not its
// use's preferred one; the answer goes through the bridge into the dictionary.
//
// What the person sees (spec §8): the band above the prompt — the G mark, the
// words, the one or two actions the moment needs, the pending count — and the
// board's six tabs, each drawn from the pure modules under
// src/hosts/claude-code/ and run through `act`. The settings live in the
// plugin's store; the words follow the chosen language.
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { GemflowJson, GemflowTab } from '../types'
import { preferAnswer, preferQuestion } from '../dist/core/asking.js'
import type { Answered } from '../dist/core/asking.js'
import { CLAUDE_CODE_TOOLS } from '../dist/core/host-tools.js'
import { FLOW_TOOLS } from '../dist/core/verb-specs.js'
import type { VerbName } from '../dist/core/verb-specs.js'
import type { BoardAction, BoardTab, Dialog, JournalFilter, Pressable, ShareHow, ShareWhat } from '../dist/hosts/claude-code/actions.js'
import { answered, bandLine, leadOf, newsOf, NO_FACTS, NO_MEMORY, nowRows, pendingNote, pressablesFor, pressedOf, remember, standingOf } from '../dist/hosts/claude-code/attention.js'
import type { Queued } from '../dist/hosts/claude-code/attention.js'
import type { AttentionFacts, AttentionMemory } from '../dist/hosts/claude-code/attention.js'
import { envParts, remoteInPlay } from '../dist/hosts/claude-code/env.js'
import { appendEvents, currentTurn, decisionsContext, decisionsSince, logName, nextTurn, NOTE_TOOL, parseLog, SESSIONS_GITIGNORE, SESSIONS_PROMPT, summarize } from '../dist/core/session-log.js'
import type { SessionEvent, SessionSummary } from '../dist/core/session-log.js'
import type { AttachedClient, HostInfo } from '../dist/hosts/claude-code/env.js'
import { bandView, BRAND_RED, cellWidth, MARK, MARK_SVG, SEP, toneProps, truncate } from '../dist/hosts/claude-code/band.js'
import type { BandView, Segment, Tone } from '../dist/hosts/claude-code/band.js'
import { BOARD_ID, ciSuggestions, DIALOG_ID, glyphSvg, HOME_TAB, hostName, ICON_CHAR, ICON_SVG, ICON_TONE, inputAction, paneRows, TAB_IDS, tabs, toolSuggestions } from '../dist/hosts/claude-code/board.js'
import type { BoardRow, FlowEdgeRow, Glyph, Icon } from '../dist/hosts/claude-code/board.js'
import { boardFailure, boardText, COMMAND_HINT, commandText, parseCommand } from '../dist/hosts/claude-code/command.js'
import { afterNeeded, beforeDecision, checkoutProbe, isOwnTool, matchesUnit, paramsToFill } from '../dist/hosts/claude-code/fastpath.js'
import type { BeforeDecision, CallFacts } from '../dist/hosts/claude-code/fastpath.js'
import { inboxItems, othersWaiting, pendingList, shortReason } from '../dist/hosts/claude-code/inbox.js'
import type { InboxItem } from '../dist/hosts/claude-code/inbox.js'
import { BRIDGE_TIMEOUT_MS, decodeResponse, encodeRequest, SLOW_TIMEOUT_MS, unreadableText } from '../dist/hosts/claude-code/protocol.js'
import type { BoardData, BridgeOp, BridgeRequest, BridgeResponse, ShellStatus, TimelineEntry, TodoCount } from '../dist/hosts/claude-code/protocol.js'
import { bashExitCode, bridgeInput, contextOf, hasGitOperation, nodeMajor, toolArgs, touchedPath } from '../dist/hosts/claude-code/readers.js'
import { answerGist, promptLine, sessionExport } from '../dist/hosts/claude-code/sessions.js'
import type { PromptRecord } from '../dist/hosts/claude-code/sessions.js'
import { hhmm } from '../dist/hosts/claude-code/time.js'
import { dayKey, mergeBooks, noteUse, pruneBook, usageKeys, usesSince } from '../dist/hosts/claude-code/usage.js'
import type { UsageBook } from '../dist/hosts/claude-code/usage.js'
import { DEFAULT_SETTINGS, settingsFrom, withSetting } from '../dist/hosts/claude-code/settings.js'
import type { Settings } from '../dist/hosts/claude-code/settings.js'
import { statusShareText } from '../dist/hosts/claude-code/share.js'
import { LOCKUP_SVG } from '../dist/hosts/claude-code/brand.js'
import { RELEASE_NOTES, isNewer } from '../dist/hosts/claude-code/release-notes.js'
import { judgementLine, judgeOptions, judgeRequest, JUDGEMENT_MS, readJudgement } from '../dist/hosts/claude-code/judge.js'
import type { Judgement, JudgeOption } from '../dist/hosts/claude-code/judge.js'
import { langOf, wordsFor } from '../dist/hosts/claude-code/text.js'
import type { T } from '../dist/hosts/claude-code/text.js'

const shellAtom = atom({ plugin: 'gemflow', key: 'shell' } as const, null as GemflowJson)
const problemAtom = atom({ plugin: 'gemflow', key: 'problem' } as const, null as string | null)
const nodeAtom = atom({ plugin: 'gemflow', key: 'node' } as const, null as string | null)
const rootAtom = atom({ plugin: 'gemflow', key: 'root' } as const, null as string | null)
const deliveredAtom = atom({ plugin: 'gemflow', key: 'delivered' } as const, null as string | null)
const lastFileAtom = atom({ plugin: 'gemflow', key: 'lastFile' } as const, null as string | null)
const boardAtom = atom({ plugin: 'gemflow', key: 'board' } as const, null as GemflowJson)
const tabAtom = atom({ plugin: 'gemflow', key: 'tab' } as const, HOME_TAB as GemflowTab)
const doneOpenAtom = atom({ plugin: 'gemflow', key: 'doneOpen' } as const, false)
const flowStateAtom = atom({ plugin: 'gemflow', key: 'flowState' } as const, null as string | null)
const flowSwitchAtom = atom({ plugin: 'gemflow', key: 'flowSwitch' } as const, false)
const toolQueryAtom = atom({ plugin: 'gemflow', key: 'toolQuery' } as const, '')
const toolMenuAtom = atom({ plugin: 'gemflow', key: 'toolMenu' } as const, null as string | null)
const toolNamingAtom = atom({ plugin: 'gemflow', key: 'toolNaming' } as const, null as string | null)
const toolsOpenAtom = atom({ plugin: 'gemflow', key: 'toolsOpen' } as const, [] as GemflowJson)
/** The usage book as last stored (null before it is read), and what this session added since. */
const usageBookAtom = atom({ plugin: 'gemflow', key: 'usageBook' } as const, null as GemflowJson)
const usagePendingAtom = atom({ plugin: 'gemflow', key: 'usagePending' } as const, {} as GemflowJson)
const dismissedAtom = atom({ plugin: 'gemflow', key: 'dismissed' } as const, null as GemflowJson)
/** The last turn's judgement (Judgement), or null. */
const judgedAtom = atom({ plugin: 'gemflow', key: 'judged' } as const, null as GemflowJson)
/** The work item's to-do count as the last refresh or board answer carried it (spec §7.2); null when that work item is no media entry. */
const todoAtom = atom({ plugin: 'gemflow', key: 'todo' } as const, null as GemflowJson)
/** Why the last board request brought no board; null when it did. */
const boardProblemAtom = atom({ plugin: 'gemflow', key: 'boardProblem' } as const, null as string | null)
/** A tool or command this session would not register: kept for the whole session, unlike the bridge's problem. */
const setupAtom = atom({ plugin: 'gemflow', key: 'setup' } as const, null as string | null)
/** When the bridge was last started (Node found, the first status asked), in $.clock.now()'s milliseconds. */
const startedAtAtom = atom({ plugin: 'gemflow', key: 'startedAt' } as const, null as number | null)
const passesAtom = atom({ plugin: 'gemflow', key: 'passes' } as const, [] as GemflowJson)
const preferPassedAtom = atom({ plugin: 'gemflow', key: 'preferPassed' } as const, [] as GemflowJson)
const promptsAtom = atom({ plugin: 'gemflow', key: 'prompts' } as const, [] as GemflowJson)
const turnMenuAtom = atom({ plugin: 'gemflow', key: 'turnMenu' } as const, null as string | null)
const sessionFlowAtom = atom({ plugin: 'gemflow', key: 'sessionFlow' } as const, null as string | null)
const sessionRunsAtom = atom({ plugin: 'gemflow', key: 'sessionRuns' } as const, [] as GemflowJson)
const filterAtom = atom({ plugin: 'gemflow', key: 'filter' } as const, 'all')
const expandedAtom = atom({ plugin: 'gemflow', key: 'expanded' } as const, null as string | null)
const evidenceAtom = atom({ plugin: 'gemflow', key: 'evidence' } as const, null as string | null)
const dialogAtom = atom({ plugin: 'gemflow', key: 'dialog' } as const, null as string | null)
const settingsAtom = atom({ plugin: 'gemflow', key: 'settings' } as const, null as GemflowJson)
const latestAtom = atom({ plugin: 'gemflow', key: 'latest' } as const, null as GemflowJson)
const notifiedAtom = atom({ plugin: 'gemflow', key: 'notified' } as const, {} as GemflowJson)
const seenInboxAtom = atom({ plugin: 'gemflow', key: 'seenInbox' } as const, null as GemflowJson)
const localeAtom = atom({ plugin: 'gemflow', key: 'locale' } as const, null as string | null)
const workflowsAtom = atom({ plugin: 'gemflow', key: 'workflows' } as const, null as GemflowJson)
const shareAtom = atom({ plugin: 'gemflow', key: 'share' } as const, { what: 'status', how: 'copy', strip: true } as GemflowJson)
const versionAtom = atom({ plugin: 'gemflow', key: 'version' } as const, null as string | null)
/** The band's attention (attention.ts): the last reply, when it came, the prompt it answered, and what the band remembers. */
const attentionAtom = atom({ plugin: 'gemflow', key: 'attention' } as const, null as GemflowJson)
/** The repository as the bridge last read it for the band: branches ahead of their upstream, open pull requests. */
const factsAtom = atom({ plugin: 'gemflow', key: 'facts' } as const, null as GemflowJson)
/** The facts when the last reply ended: what changed since is news for the model. */
const factsAtReplyAtom = atom({ plugin: 'gemflow', key: 'factsAtReply' } as const, null as GemflowJson)
/** A command changed the plugin's own folder since it was loaded. */
const reloadAtom = atom({ plugin: 'gemflow', key: 'reload' } as const, false)
/** The machine and checkout the session runs on, as the bridge read them ({ name, platform, user, branch }). */
const hostAtom = atom({ plugin: 'gemflow', key: 'host' } as const, null as GemflowJson)
/** The clients attached to the session (session.attach): [{ clientId, surface }]. */
const clientsAtom = atom({ plugin: 'gemflow', key: 'clients' } as const, [] as GemflowJson)
/** Where the last prompt came from: composer (this machine), bridge (Remote Control), sdk. */
const originAtom = atom({ plugin: 'gemflow', key: 'origin' } as const, null as string | null)
/** The steps the person pressed that went into the session: queued until it is idle, then entered and being done until that turn ends. */
const queuedAtom = atom({ plugin: 'gemflow', key: 'queued' } as const, [] as GemflowJson)
/** The project's shared session logs: where they are, what they hold, the other session unfolded, the decisions already passed on, a commit in this turn. */
const sessionsDirAtom = atom({ plugin: 'gemflow', key: 'sessionsDir' } as const, null as string | null)
const projectSessionsAtom = atom({ plugin: 'gemflow', key: 'projectSessions' } as const, [] as GemflowJson)
const openSessionAtom = atom({ plugin: 'gemflow', key: 'openSession' } as const, null as string | null)
const decisionsSeenAtom = atom({ plugin: 'gemflow', key: 'decisionsSeen' } as const, null as string | null)
const committedAtom = atom({ plugin: 'gemflow', key: 'committed' } as const, false)
const readQueued = async ($: EngineInterface): Promise<Queued[]> => ((await read($, queuedAtom)) as unknown as Queued[] | null) ?? []
const setQueued = async ($: EngineInterface, f: (was: Queued[]) => Queued[]): Promise<void> => {
  await update($, queuedAtom, (was) => f(((was as unknown) as Queued[] | null) ?? []) as unknown as GemflowJson)
  $.ui.invalidate('ui.render')
}

/** A start that got no answer is tried again on a tool call or a prompt, at most this often. */
const START_RETRY_MS = 60_000
/** After a start that found no Node: sooner, since a first probe can fail on a cold machine. */
const NODE_RETRY_MS = 10_000
/** A probe's time: a first run of node.exe behind an antivirus, or off a cold disk, takes longer than a warm one. */
const PROBE_MS = 10_000
/** One desktop notification per refusal reason this often. */
const REFUSAL_NOTIFY_MS = 3 * 60_000
/** The prompts kept for the sessions tab. */
const PROMPTS_KEPT = 300
const STORE_SETTINGS = 'settings'
const REGISTRY = 'https://registry.npmjs.org/@geml/gemflow/latest'
const LINKS = { spec: 'https://github.com/geml-spec/geml/tree/main/integrations/gemflow/spec', repo: 'https://github.com/geml-spec/geml/tree/main/integrations/gemflow', feedback: 'https://github.com/geml-spec/geml/issues', changelog: 'https://github.com/geml-spec/geml/blob/main/CHANGELOG.md' }

/**
 * Whether a directory holds a `.git` entry, as `$.fs.stat` first answered for
 * it: the module's memory, for the session. A directory that becomes a
 * checkout later in the session (git init in a directory seen before) is not
 * looked at again.
 */
const gitEntries = new Map<string, boolean>()

/** An error's message, without the `gemflow: ` the engine puts before a refused `$` call of this plugin. */
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^gemflow: /, '')

const nowIso = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString()

async function readShell($: EngineInterface): Promise<ShellStatus | null> {
  return (await read($, shellAtom)) as unknown as ShellStatus | null
}
const readBoard = async ($: EngineInterface): Promise<BoardData | null> => (await read($, boardAtom)) as unknown as BoardData | null
const readPasses = async ($: EngineInterface): Promise<string[]> => ((await read($, passesAtom)) as unknown as string[] | null) ?? []
const readPrompts = async ($: EngineInterface): Promise<PromptRecord[]> => ((await read($, promptsAtom)) as unknown as PromptRecord[] | null) ?? []
const readSettings = async ($: EngineInterface): Promise<Settings> => settingsFrom(await read($, settingsAtom))

/** The words in the language chosen: the setting, else the CLI's locale, else the host's LANG. */
async function words($: EngineInterface): Promise<T> {
  const s = await readSettings($)
  const shell = await readShell($)
  return wordsFor(langOf(s.language, shell?.locale ?? (await read($, localeAtom)) ?? undefined))
}

/**
 * Node ≥ 22: on the session's PATH; else where a shell finds it — a login
 * shell on Unix (the app's own PATH may lack what the shell's profile adds),
 * `where` through cmd.exe on Windows; the one that is not this OS's fails at
 * once — else in the places the installers put it; or why there is none.
 * The first candidate that answers with a new enough version is the one.
 */
async function findNode($: EngineInterface): Promise<{ node: string } | { problem: string }> {
  const major = async (bin: string): Promise<number | undefined> => {
    try {
      const r = await $.process.run([bin, '--version'], { timeoutMs: PROBE_MS })
      return r.exitCode === 0 ? nodeMajor(r.stdout) : undefined
    } catch {
      return undefined
    }
  }
  const candidates: string[] = ['node']
  const offer = (p: string): void => { const q = p.trim(); if (q !== '' && !candidates.includes(q)) candidates.push(q) }
  for (const argv of [['/bin/sh', '-lc', 'command -v node'], ['cmd.exe', '/d', '/c', 'where node']]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: PROBE_MS })
      if (r.exitCode === 0) for (const line of r.stdout.split(/\r?\n/)) offer(line)
    } catch { /* not this OS, or no such shell */ }
  }
  // The installers' places: Windows (the installer, nvm-windows, Volta), then macOS (Homebrew, the installer) and Linux.
  // Each variable is named at its own call: the engine lists what a module reads, so the name must be a literal there.
  try { const v = await $.env.get('ProgramFiles'); if (v) offer(`${v}\\nodejs\\node.exe`) } catch { /* no env */ }
  try { const v = await $.env.get('LOCALAPPDATA'); if (v) { offer(`${v}\\Programs\\nodejs\\node.exe`); offer(`${v}\\Volta\\bin\\node.exe`) } } catch { /* no env */ }
  try { const v = await $.env.get('NVM_SYMLINK'); if (v) offer(`${v}\\node.exe`) } catch { /* no env */ }
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) offer(p)
  let seen: number | undefined
  for (const bin of candidates) {
    const m = await major(bin)
    if (m === undefined) continue
    if (m >= 22) return { node: bin }
    seen = seen === undefined ? m : Math.max(seen, m)
  }
  return { problem: seen !== undefined ? `gemflow：Node ${seen} 太旧，需要 Node ≥ 22` : 'gemflow：找不到 node — 请安装 Node ≥ 22' }
}

/** One request to the CLI. Undefined when the bridge is unavailable; the band then says why. */
async function bridge($: EngineInterface, op: BridgeOp, timeoutMs: number = BRIDGE_TIMEOUT_MS, onFile?: string): Promise<BridgeResponse | undefined> {
  const node = await read($, nodeAtom)
  const root = await read($, rootAtom)
  if (node === null || root === null) return undefined
  // `onFile`: this one request acts on that work item's file; the current one stays the shell's.
  const lastFile = onFile ?? (await read($, lastFileAtom))
  const gh = (await readShell($))?.status?.gh
  const request = { v: 1, root, ...(lastFile !== null ? { lastFile } : {}), ...(gh ? { gh } : {}), ...op } as BridgeRequest
  let out: { exitCode: number; stdout: string; stderr: string }
  try {
    out = await $.process.run([node, `${$.plugin.root}/dist/gemflow.mjs`, 'hook'], { cwd: root, stdin: encodeRequest(request), timeoutMs })
  } catch (err) {
    await update($, problemAtom, () => `gemflow：桥接没有应答（${reasonOf(err)}）`)
    return undefined
  }
  const res = decodeResponse(out.stdout)
  if (res === undefined) {
    await update($, problemAtom, () => unreadableText(out.exitCode, out.stderr, $.plugin.root))
    return undefined
  }
  // An answer without a shell is a request that failed (it threw, or the CLI could not read it): it says
  // nothing about the workflow, so the last shell and its policy stay and the band shows the error.
  const failed = !res.ok && res.shell === undefined ? res.error.replace(/^gemflow: /, '') : null
  // Each written only when it changed: every tool call asks the bridge, and a write redraws whatever read the value.
  const problem = failed !== null ? `gemflow：${failed}` : null
  if ((await read($, problemAtom)) !== problem) await update($, problemAtom, () => problem)
  const shell = res.shell
  if (shell !== undefined && JSON.stringify(shell) !== JSON.stringify(await read($, shellAtom))) await update($, shellAtom, () => shell as unknown as GemflowJson)
  // Refresh and board answers carry the to-do count; every other answer leaves the last one standing.
  if (res.ok && res.todo !== undefined) {
    const todo = res.todo
    await update($, todoAtom, () => todo as unknown as GemflowJson)
  }
  // The stage moved under a tool call, a verb or a catch-up, the dictionary learned, or a call was refused: the board is read again, after this hook.
  const refused = op.op === 'before' && res.ok && res.refusal !== undefined
  if (((op.op === 'after' || op.op === 'verb' || op.op === 'refresh') && movedStage(res)) || op.op === 'learn' || refused) await reloadBoardLater($)
  if (res.ok && (res.entered?.length ?? 0) > 0) await notifyStage($, res)
  return res
}

const movedStage = (res: BridgeResponse): boolean => res.ok && (res.context !== undefined || (res.entered?.length ?? 0) > 0)

/** Read the board again once the current hook is done. */
async function reloadBoardLater($: EngineInterface): Promise<void> {
  $.clock.after(0, () => {
    void loadBoard($)
  })
}

/**
 * A result with the new stage's text after it, for the model only — after the
 * handoff line when the answer is on another work item than the one the main
 * loop last read. On the main loop it is recorded as delivered; a subagent's
 * result reaches only the subagent, so the main thread's next prompt still
 * carries the stage. The stage text of another work item the call was
 * attributed to (the checkout a subagent works in) is the subagent's alone:
 * the main loop's stays the session's.
 */
async function withStage<X extends { result?: unknown; context?: readonly string[] }>($: EngineInterface, ran: X, res: BridgeResponse | undefined, agentId: unknown): Promise<X> {
  if (res === undefined || !res.ok) return ran
  const texts: string[] = []
  if (res.context !== undefined) {
    const key = res.shell.contextKey
    if (key !== null && agentId === undefined) await update($, deliveredAtom, () => key)
    texts.push(res.handoff !== undefined ? `${res.handoff}\n${res.context}` : res.context)
  }
  if (res.routed !== undefined && agentId !== undefined) texts.push(res.routed.context)
  return texts.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...texts] }
}

/** The directory the loop making a call stands in, read before the call runs; undefined when the engine does not say. */
async function callCwd($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.cwd()
  } catch {
    return undefined
  }
}

/** Whether a directory holds a `.git` entry — a worktree's file or a repository's directory — asked once per directory. */
async function hasGitEntry($: EngineInterface, dir: string): Promise<boolean> {
  const seen = gitEntries.get(dir)
  if (seen !== undefined) return seen
  let found: boolean
  try {
    await $.fs.stat(`${dir}/.git`)
    found = true
  } catch {
    found = false
  }
  gitEntries.set(dir, found)
  return found
}

/** Whether a call may act outside the session's checkout: checkoutProbe, then a `.git` entry between its directory and the root. */
async function actsElsewhere($: EngineInterface, call: CallFacts, cwd: string, root: string): Promise<boolean> {
  const probe = checkoutProbe(call, cwd, root)
  if (probe.elsewhere) return true
  for (const dir of probe.dirs) if (await hasGitEntry($, dir)) return true
  return false
}

/** What the main loop last read, `<item>@<rev>`, for a call of the main loop; null for a subagent's, which no handoff is for. */
async function deliveredFor($: EngineInterface, agentId: unknown): Promise<string | null> {
  return agentId === undefined ? read($, deliveredAtom) : null
}

/**
 * Ask the person about a tool that is not its use's preferred one (spec
 * §5.3, preferences): $.ui.ask puts the question to them whatever the
 * permission mode, and returns the option they chose. A dismissed question,
 * or one that could not be asked, lets the call through once: the module
 * fails open. Gemflow asks nothing else: whether a call no row takes is safe
 * to run is the host's permission system's call.
 */
async function askPerson($: EngineInterface, d: Extract<BeforeDecision, { kind: 'prefer' }>): Promise<Answered> {
  const q = preferQuestion(d.key, d.use, d.preferred)
  let chosen: string | undefined
  try {
    const answer: unknown = await ($.ui as unknown as { ask(question: string, options: string[]): Promise<unknown> }).ask(q.question, q.options)
    chosen = typeof answer === 'string' ? answer : undefined
  } catch {
    chosen = undefined
  }
  return preferAnswer(chosen, d.key, d.use, d.preferred)
}

/** One of the three model tools, answered by the bridge's verb op. */
async function serveVerb($: EngineInterface, name: VerbName, event: unknown): Promise<ToolCallResult> {
  const e = event as Record<string, unknown>
  await retryStart($)
  const callId = typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined
  const delivered = await deliveredFor($, e['agentId'])
  const res = await bridge($, { op: 'verb', name, args: toolArgs(e), ...(callId !== undefined ? { callId } : {}), ...(delivered !== null ? { delivered } : {}) })
  if (res === undefined) return { result: `gemflow is unavailable: ${(await read($, problemAtom)) ?? 'no workflow here'}` }
  if (!res.ok) return { result: `gemflow: ${res.error}` }
  if (e['agentId'] === undefined) await notePrompt($, (p) => ({ ...p, entered: [...p.entered, ...(res.entered ?? [])] }))
  return withStage($, { result: res.text ?? '' }, res, e['agentId'])
}

/** Read the board; null when it came, else why not (kept for the pane, which shows it). The inbox is told of new items. */
async function loadBoard($: EngineInterface): Promise<string | null> {
  const res = await bridge($, { op: 'board' }, SLOW_TIMEOUT_MS)
  const failure = boardFailure(res, await read($, problemAtom), await words($)) ?? null
  await update($, boardProblemAtom, () => failure)
  if (res !== undefined && res.ok && res.board !== undefined) {
    const board = res.board
    await update($, boardAtom, () => board as unknown as GemflowJson)
  }
  await notifyInbox($)
  return failure
}

// ---- what needs the person now (attention.ts) ---------------------------------------------

/** The last reply as the band keeps it. `consumed`: the person has answered it; its asks no longer lead. */
interface Attention { reply: string; replyAt: number; asked: string; memory: AttentionMemory; consumed: boolean }
const readAttention = async ($: EngineInterface): Promise<Attention | null> => (await read($, attentionAtom)) as unknown as Attention | null

/** The repository's facts for the band, with the reload a command made due. */
async function factsNow($: EngineInterface): Promise<AttentionFacts> {
  const f = ((await read($, factsAtom)) as unknown as AttentionFacts | null) ?? NO_FACTS
  return (await read($, reloadAtom)) ? { ...f, reload: true } : f
}

/** What the band and the board's 此刻 show now: the lead, the standing steps, the memory, the line. Reads only. */
async function attentionNow($: EngineInterface, t: T) {
  const a = await readAttention($)
  const facts = await factsNow($)
  const now = await $.clock.now()
  const reply = a !== null && !a.consumed ? a.reply : ''
  const memory = a?.memory ?? NO_MEMORY
  const standing = standingOf(reply, facts, now, t)
  const lead = a === null || a.consumed ? null : leadOf({ reply, standing, memory, t })
  const line = bandLine({ lead, standing, memory, reply, awayMs: a === null ? null : now - a.replyAt, ...(a !== null ? { asked: a.asked } : {}), t })
  return { attention: a, reply, standing, memory, lead, line }
}

/**
 * The person's prompt ends the band's moment: its memory moves on (what led, how long each step has waited, the asks
 * the prompt answers), and what changed in the repository since the reply is news for the model, so the person need
 * not say it. Answers the context lines to add.
 */
async function attentionOnPrompt($: EngineInterface, said: string): Promise<string[]> {
  try {
    const t = await words($)
    const now = await attentionNow($, t)
    const a = now.attention
    if (a === null) return []
    if (!a.consumed) {
      const memory = answered(remember(a.memory, { reply: a.reply, standing: now.standing, lead: now.lead }), said)
      await update($, attentionAtom, () => ({ ...a, memory, consumed: true }) as unknown as GemflowJson)
    }
    const news = newsOf((await read($, factsAtReplyAtom)) as unknown as AttentionFacts | null, await factsNow($), t)
    return news.length > 0 ? [`[gemflow] since your last reply: ${news.join('; ')}`] : []
  } catch {
    return []
  }
}

/** Where the session runs and who drives it (env.ts): the parts of one line, and whether a person may be away from the machine. */
async function envNow($: EngineInterface, t: T, surface?: string): Promise<{ parts: string[]; host: HostInfo | null; remote: boolean }> {
  const host = (await read($, hostAtom)) as unknown as HostInfo | null
  const clients = ((await read($, clientsAtom)) as unknown as AttachedClient[] | null) ?? []
  const origin = (await read($, originAtom)) ?? undefined
  const remote = remoteInPlay({ ...(surface !== undefined ? { surface } : {}), clients, ...(origin !== undefined ? { origin } : {}) })
  return { parts: envParts({ host, root: await read($, rootAtom), remote, t }), host, remote }
}

// ---- the project's shared session record (session-log.ts) -------------------------------

/** How this host names its logs. */
const OWN_HOST = 'claude-code'
/** How far back a session's first prompt hears the other sessions' decisions. */
const DECISIONS_BACK_MS = 3 * 24 * 60 * 60 * 1000

/** This session's log, the events `make` adds at its end (given the events so far, a session line first when there was none); nothing when the project has no record. */
async function appendOwn($: EngineInterface, make: (events: SessionEvent[]) => SessionEvent[]): Promise<SessionEvent[]> {
  try {
    const dir = await read($, sessionsDirAtom)
    if (dir === null) return []
    const id = await $.session.id()
    const path = `${dir}/${logName(OWN_HOST, id)}`
    let text = ''
    try { text = String(await $.fs.read(path)) } catch { text = '' }
    const events = parseLog(text)
    const head: SessionEvent[] = []
    if (!events.some((x) => x.t === 'session')) {
      const host = (await read($, hostAtom)) as unknown as HostInfo | null
      const root = await read($, rootAtom)
      head.push({ t: 'session', id, host: OWN_HOST, at: await nowIso($), ...(host?.branch !== undefined ? { branch: host.branch } : {}), ...(root !== null ? { checkout: root } : {}) })
      // The directory keeps itself out of git, whichever branch the main working tree is on.
      if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, SESSIONS_GITIGNORE)
    }
    const added = [...head, ...make([...events, ...head])]
    if (added.length > 0) await $.fs.write(path, appendEvents(text, added))
    return [...events, ...added]
  } catch { return [] }
}

/** Logs read again only when they changed: by name, the size and time they were read at. */
const logsRead = new Map<string, { size: number; mtimeMs: number; summary: SessionSummary | undefined }>()

/** Every session's log in the project's record, read into the session tab's state (answers left out: the tab shows the decisions). */
async function loadProjectSessions($: EngineInterface): Promise<SessionSummary[]> {
  const dir = await read($, sessionsDirAtom)
  if (dir === null) return []
  let entries: { name: string; kind: string; size: number; mtimeMs: number }[]
  try { entries = [...(await $.fs.list(dir))] } catch { return [] }
  const sessions: SessionSummary[] = []
  for (const en of entries) {
    if (en.kind !== 'file' || !en.name.endsWith('.jsonl')) continue
    const known = logsRead.get(en.name)
    let summary = known !== undefined && known.size === en.size && known.mtimeMs === en.mtimeMs ? known.summary : undefined
    if (summary === undefined) {
      try { summary = summarize(parseLog(String(await $.fs.read(`${dir}/${en.name}`)))) } catch { summary = undefined }
      if (summary !== undefined) summary = { ...summary, turns: summary.turns.map(({ answer: _answer, ...turn }) => turn) }
      logsRead.set(en.name, { size: en.size, mtimeMs: en.mtimeMs, summary })
    }
    if (summary !== undefined) sessions.push(summary)
  }
  if (JSON.stringify(sessions) !== JSON.stringify(await read($, projectSessionsAtom))) await update($, projectSessionsAtom, () => sessions as unknown as GemflowJson)
  return sessions
}

/** A person's prompt: into this session's log as the next turn; the other sessions' decisions it has not heard come back as the line beside it. */
async function sessionsOnPrompt($: EngineInterface, text: string): Promise<string[]> {
  const at = await nowIso($)
  await appendOwn($, (events) => [{ t: 'prompt', turn: nextTurn(events), at, text }])
  const sessions = await loadProjectSessions($)
  if (sessions.length === 0) return []
  const seen = await read($, decisionsSeenAtom)
  const since = seen ?? new Date(Date.parse(at) - DECISIONS_BACK_MS).toISOString()
  const fresh = decisionsSince(sessions, await $.session.id(), since)
  await update($, decisionsSeenAtom, () => at)
  if (fresh.length === 0) return []
  return [decisionsContext(fresh, (d) => `${hostName(d.host)}${d.branch !== undefined ? ` · ${d.branch}` : ''}，${hhmm(d.at)}`)]
}

/** The model's note: the decisions into this session's log, under the turn under way. */
async function noteDecisions($: EngineInterface, event: unknown): Promise<ToolCallResult> {
  const args = toolArgs(event as Record<string, unknown>)
  const given = Array.isArray(args['decisions']) ? (args['decisions'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  if (given.length === 0) return { result: 'Nothing recorded: decisions is a list of short sentences.' }
  if ((await read($, sessionsDirAtom)) === null) return { result: 'Nothing recorded: this project has no shared session record yet (gemflow has not read the repository).' }
  const at = await nowIso($)
  const events = await appendOwn($, (so) => given.map((text): SessionEvent => ({ t: 'decision', turn: currentTurn(so), at, text })))
  if (events.length === 0) return { result: 'Nothing recorded: the session record could not be written.' }
  await loadProjectSessions($)
  return { result: `Recorded ${given.length} decision${given.length === 1 ? '' : 's'}; the project's other sessions will see ${given.length === 1 ? 'it' : 'them'}.` }
}

/** A turn's end: its answer into this session's log, and the commits a command in it made. */
async function sessionsOnAnswer($: EngineInterface, answer: string): Promise<void> {
  const at = await nowIso($)
  const committed = await read($, committedAtom)
  if (committed) await update($, committedAtom, () => false)
  let commits: { sha: string; at: string; subject: string }[] = []
  const root = await read($, rootAtom)
  const events = await appendOwn($, (so) => [{ t: 'answer', turn: currentTurn(so), at, text: answer }])
  const asked = [...events].reverse().find((x): x is Extract<SessionEvent, { t: 'prompt' }> => x.t === 'prompt')
  if (committed && root !== null && asked !== undefined) {
    try {
      const r = await $.process.run(['git', '-C', root, 'log', `--since=${asked.at}`, '--format=%H%x09%cI%x09%s', 'HEAD'], { timeoutMs: BRIDGE_TIMEOUT_MS })
      if (r.exitCode === 0) commits = r.stdout.split(/\r?\n/).filter((l) => l !== '').map((l) => { const [sha = '', when = at, ...rest] = l.split('\t'); return { sha, at: when, subject: rest.join('\t') } })
    } catch { commits = [] }
  }
  if (commits.length > 0) {
    const branch = ((await read($, hostAtom)) as unknown as HostInfo | null)?.branch
    await appendOwn($, (so) => commits.filter((c) => !so.some((x) => x.t === 'commit' && x.sha === c.sha)).map((c): SessionEvent => ({ t: 'commit', turn: currentTurn(so), at: c.at, sha: c.sha, subject: c.subject, ...(branch !== undefined ? { branch } : {}) })))
  }
  await loadProjectSessions($)
}

/** A file this session wrote: into its log once. */
async function sessionsOnFile($: EngineInterface, path: string): Promise<void> {
  const at = await nowIso($)
  const branch = ((await read($, hostAtom)) as unknown as HostInfo | null)?.branch
  await appendOwn($, (so) => (so.some((x) => x.t === 'file' && x.path === path) ? [] : [{ t: 'file', turn: currentTurn(so), at, path, ...(branch !== undefined ? { branch } : {}) }]))
}

/** Ask the bridge what the repository says (pushed or not, pull requests green or failing); the band redraws when it changed. */
async function loadFacts($: EngineInterface): Promise<void> {
  const res = await bridge($, { op: 'attention' }, SLOW_TIMEOUT_MS)
  if (res === undefined || !res.ok || res.attention === undefined) return
  const dir = res.sessions
  if (dir !== undefined && dir !== (await read($, sessionsDirAtom))) {
    await update($, sessionsDirAtom, () => dir)
    await loadProjectSessions($)
  }
  const host = res.host
  if (host !== undefined && JSON.stringify(host) !== JSON.stringify(await read($, hostAtom))) {
    await update($, hostAtom, () => host as unknown as GemflowJson)
    $.ui.invalidate('ui.render')
  }
  const facts = res.attention
  if (JSON.stringify(facts) === JSON.stringify(await read($, factsAtom))) return
  await update($, factsAtom, () => facts as unknown as GemflowJson)
  $.ui.invalidate('ui.render')
}

/** Node, then the first status; the time is kept so a start that got no answer is tried again, at most once a minute. */
async function startBridge($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, startedAtAtom, () => now)
  if ((await read($, nodeAtom)) === null) {
    const found = await findNode($)
    if ('problem' in found) {
      await update($, problemAtom, () => found.problem)
      return
    }
    await update($, nodeAtom, () => found.node)
  }
  const res = await bridge($, { op: 'status' })
  if (res === undefined) return
  // git and gh can take seconds: catch up outside the start the first prompt waits on, and read the board the inbox is built from.
  $.clock.after(0, () => {
    void bridge($, { op: 'refresh' }, SLOW_TIMEOUT_MS).then(() => loadBoard($))
  })
}

/** The top of the checkout a directory is in, by git, asked once per directory; undefined when it is in none or git cannot say. */
const checkouts = new Map<string, string | undefined>()
async function checkoutOf($: EngineInterface, dir: string): Promise<string | undefined> {
  if (checkouts.has(dir)) return checkouts.get(dir)
  let top: string | undefined
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: BRIDGE_TIMEOUT_MS })
    const line = r.stdout.trim()
    top = r.exitCode === 0 && line !== '' ? line : undefined
  } catch {
    top = undefined
  }
  checkouts.set(dir, top)
  return top
}

/** A path as compared: forward slashes, and a Windows drive's path in one case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => { const s = p.split('\\').join('/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s }
  return norm(a) === norm(b)
}

/**
 * The session moved to another checkout (a directory added or switched to, a
 * worktree entered): the root follows it, and what was read for the old one
 * is dropped and read again there. A directory in no checkout leaves the root.
 */
async function followCwd($: EngineInterface): Promise<void> {
  const cwd = await callCwd($)
  if (cwd === undefined) return
  const to = await checkoutOf($, cwd)
  if (to === undefined) return
  const root = await read($, rootAtom)
  // The root is the checkout's top, where .geml/ is: a session started in a subdirectory moves up to it too.
  if (root !== null && samePath(root, to)) return
  // The old checkout's counts are stored under it; the new one reads its own.
  try { await storeUsage($) } catch { /* kept for the session */ }
  await update($, rootAtom, () => to)
  await update($, usageBookAtom, () => null)
  await update($, usagePendingAtom, () => ({}) as GemflowJson)
  await update($, dismissedAtom, () => null)
  await loadStored($)
  await update($, shellAtom, () => null)
  await update($, boardAtom, () => null)
  await update($, boardProblemAtom, () => null)
  await update($, problemAtom, () => null)
  await update($, todoAtom, () => null)
  await update($, deliveredAtom, () => null)
  await update($, lastFileAtom, () => null)
  await update($, passesAtom, () => [] as unknown as GemflowJson)
  await update($, workflowsAtom, () => null)
  await startBridge($)
}

/** After a start that got no shell (no Node, no answer), a tool call or a prompt starts again — at most once a minute. */
async function retryStart($: EngineInterface): Promise<void> {
  if ((await read($, rootAtom)) === null || (await read($, shellAtom)) !== null) return
  const last = await read($, startedAtAtom)
  const wait = (await read($, nodeAtom)) === null ? NODE_RETRY_MS : START_RETRY_MS
  if (last !== null && (await $.clock.now()) - last < wait) return
  await startBridge($)
}

/** Register one tool or command; a refusal is noted for the band, and the start goes on. */
async function registerOne($: EngineInterface, name: string, register: () => Promise<unknown>): Promise<void> {
  try {
    await register()
  } catch (err) {
    const reason = reasonOf(err)
    await update($, setupAtom, (was) => `${was ?? 'gemflow：没有注册上'} ${name}（${reason}）`)
  }
}

// ---- how often each tool ran ------------------------------------------------------------

/** How many days of use the store keeps, and how many the tools tab counts. */
const USAGE_DAYS_KEPT = 7
const USAGE_DAYS_SHOWN = 2

/** The usage book: the stored one, read once a session, with what this session added since. */
async function usageBook($: EngineInterface): Promise<UsageBook> {
  // Read only: a drawing may call this, and drawing writes no state. The store's book is read in when the root is set (loadStored).
  const stored = ((await read($, usageBookAtom)) as unknown as UsageBook | null) ?? {}
  return mergeBooks(stored, ((await read($, usagePendingAtom)) as unknown as UsageBook | null) ?? {})
}

/** What the store keeps for this checkout — the usage book, the suggestions put away — read in once its root is set. */
async function loadStored($: EngineInterface): Promise<void> {
  const root = (await read($, rootAtom)) ?? ''
  let book: UsageBook = {}
  let dismissed: string[] = []
  try { book = ((await $.store.get(`usage:${root}`)) as unknown as UsageBook | null) ?? {} } catch { book = {} }
  try { dismissed = ((await $.store.get(`dismissed:${root}`)) as unknown as string[] | null) ?? [] } catch { dismissed = [] }
  await update($, usageBookAtom, () => book as unknown as GemflowJson)
  await update($, dismissedAtom, () => dismissed as unknown as GemflowJson)
}

/** How many sessions' prompts the store keeps, and how much of each prompt's text. */
const PROMPT_SESSIONS_KEPT = 8
const PROMPT_TEXT_KEPT = 2000

/** This session's prompts into the store (under its id), the oldest sessions' let go; a store that refuses leaves the session's own. */
async function storePrompts($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.id()
    const prompts = (await readPrompts($)).map((p) => (p.text.length > PROMPT_TEXT_KEPT ? { ...p, text: p.text.slice(0, PROMPT_TEXT_KEPT) } : p))
    await $.store.set(`prompts:${id}`, prompts)
    const was = await $.store.get('prompts:sessions')
    const order = [...(Array.isArray(was) ? (was as string[]).filter((x) => x !== id) : []), id]
    for (const old of order.slice(0, -PROMPT_SESSIONS_KEPT)) await $.store.delete(`prompts:${old}`)
    await $.store.set('prompts:sessions', order.slice(-PROMPT_SESSIONS_KEPT))
  } catch { /* the session's own state still holds them */ }
}

/** At a load with no prompts held (the app restarted under a resumed session), the ones the store kept for it. */
async function restorePrompts($: EngineInterface): Promise<void> {
  if ((await readPrompts($)).length > 0) return
  try {
    const kept = await $.store.get(`prompts:${await $.session.id()}`)
    if (Array.isArray(kept) && kept.length > 0) await update($, promptsAtom, () => kept as unknown as GemflowJson)
  } catch { /* none kept */ }
}

/** One call noted in this session's book; a failure to count never stands in the call's way. */
async function noteUsage($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<void> {
  try {
    const keys = usageKeys(tool, input)
    const day = dayKey(await nowIso($))
    await update($, usagePendingAtom, (was) => noteUse((((was as unknown) as UsageBook | null) ?? {}), day, keys) as unknown as GemflowJson)
  } catch { /* the count is a nicety */ }
}

/** These two days' counts, by key. */
async function usageNow($: EngineInterface): Promise<Record<string, number>> {
  return usesSince(await usageBook($), await nowIso($), USAGE_DAYS_SHOWN)
}

/**
 * The usage a drawing shows: the stored book alone. What this session's calls add joins it when the turn ends
 * (storeUsage), so a tool call, which notes its use, redraws neither the band nor the board.
 */
async function usageDrawn($: EngineInterface): Promise<Record<string, number>> {
  return usesSince(((await read($, usageBookAtom)) as unknown as UsageBook | null) ?? {}, await nowIso($), USAGE_DAYS_SHOWN)
}

/** What this session added goes into the store, merged with what other sessions stored meanwhile. */
async function storeUsage($: EngineInterface): Promise<void> {
  const pending = ((await read($, usagePendingAtom)) as unknown as UsageBook | null) ?? {}
  if (Object.keys(pending).length === 0) return
  const key = `usage:${(await read($, rootAtom)) ?? ''}`
  try {
    const stored = ((await $.store.get(key)) as unknown as UsageBook | null) ?? {}
    const next = pruneBook(mergeBooks(stored, pending), USAGE_DAYS_KEPT)
    await $.store.set(key, next as unknown as GemflowJson)
    await update($, usageBookAtom, () => next as unknown as GemflowJson)
    await update($, usagePendingAtom, () => ({}) as GemflowJson)
  } catch { /* a read-only store: the session keeps its own */ }
}

/** The suggestions put away in this project. */
async function dismissedOf($: EngineInterface): Promise<string[]> {
  // Read only, like usageBook: loadStored put the store's list here.
  return ((await read($, dismissedAtom)) as unknown as string[] | null) ?? []
}

// ---- each turn's judgement ---------------------------------------------------------------

/** What waits on the person, as the band and the board list it. */
async function pendingNow($: EngineInterface, t: T): Promise<InboxItem[]> {
  const shell = await readShell($)
  const board = await readBoard($)
  const item = shell?.status?.item
  return pendingList(await inboxOf($, t), [...othersWaiting(board, item?.kind === 'item' ? item.id : undefined, t), ...(board !== null ? [...toolSuggestions(board, await usageDrawn($), await dismissedOf($), t), ...ciSuggestions(board, shell?.units ?? [], await dismissedOf($), t)] : [])])
}

/** Take a judged option: a way out (and how to take it back: the revision before), or a work item to come back to. Nothing is said: the person's prompt said it. */
async function takeOption($: EngineInterface, option: JudgeOption): Promise<Judgement['undo'] | undefined> {
  const a = option.action
  if (a.op === 'advance') {
    const before = a.file === undefined ? (await readShell($))?.status?.state?.rev : (await readBoard($))?.items.find((i) => i.file === a.file)?.rev
    const res = await bridge($, { op: 'advance', to: a.to }, BRIDGE_TIMEOUT_MS, a.file)
    await loadBoard($)
    if (res !== undefined && !res.ok) $.ui.toast(`gemflow：${res.error.replace(/^gemflow: /, '')}`)
    return res?.ok === true && before !== undefined ? { ...(a.file !== undefined ? { file: a.file } : {}), rev: before } : undefined
  }
  if (a.op === 'switch-file') {
    await update($, lastFileAtom, () => a.file)
    await bridge($, { op: 'status' })
    await loadBoard($)
  }
  return undefined
}

/**
 * The turn's judgement (typing is pressing a button): whether the person's
 * prompt picks one of the options waiting on them. A small model reads them,
 * the last answer's first sentence and the prompt; a sure pick is taken and
 * shown with an undo, an unsure one is asked on the band. Run after the
 * prompt is on its way: the model's turn does not wait for it.
 */
async function judgeTurn($: EngineInterface, said: string, lastAnswer: string): Promise<void> {
  const t = await words($)
  const options = judgeOptions(await pendingNow($, t))
  if (options.length === 0) { await update($, judgedAtom, () => null); return }
  const ask = judgeRequest(options, lastAnswer, said)
  const r = await $.model.complete({ model: 'haiku', system: ask.system, prompt: ask.prompt, maxTokens: 200, effort: 'low', timeoutMs: 20_000 })
  const found = r.isAnswered ? readJudgement(r.text, options) : undefined
  if (found === undefined) { await update($, judgedAtom, () => null); return }
  const undo = found.sure ? await takeOption($, found.option) : undefined
  const judged: Judgement = { at: await nowIso($), said: promptLine(said, 60), option: found.option, ...(found.alternatives.length > 0 ? { alternatives: found.alternatives } : {}), sure: found.sure, why: found.why, taken: found.sure, ...(undo !== undefined ? { undo } : {}) }
  await update($, judgedAtom, () => judged as unknown as GemflowJson)
}

// ---- the inbox, the digest and the notifications -------------------------------

/** The inbox as it stands: the shell, the board's timeline, the questions nobody answered, the bridge's problem. */
async function inboxOf($: EngineInterface, t?: T): Promise<InboxItem[]> {
  const board = await readBoard($)
  return inboxItems({
    shell: await readShell($), timeline: board?.timeline ?? [],
    problem: await read($, problemAtom), now: await nowIso($), t: t ?? (await words($)),
  })
}

/** Tell the desktop of inbox items it has not seen, when the settings say so; a bridge problem is not news. */
async function notifyInbox($: EngineInterface): Promise<void> {
  const t = await words($)
  const items = (await inboxOf($, t)).filter((i) => i.kind !== 'broken')
  const seen = (await read($, seenInboxAtom)) as unknown as string[] | null
  const keys = items.map((i) => i.key)
  await update($, seenInboxAtom, () => keys as unknown as GemflowJson)
  if (seen === null) return
  const fresh = items.filter((i) => !seen.includes(i.key))
  if (fresh.length === 0 || !(await readSettings($)).notify.inbox) return
  const first = fresh[0] as InboxItem
  const head = first.kind === 'approve' ? (first.closes === true ? t('等你验收：{0}', first.title) : t('等你定：{0}', first.title)) : `${first.verb} ${first.title}`.trim()
  const text = [head, ...first.detail.slice(0, 1)].join('\n')
  try { await $.ui.notify(text, { title: 'Gemflow' }) } catch { /* no channel */ }
}

/** A refusal: one notification per reason every few minutes, when the settings say so. */
async function notifyRefusal($: EngineInterface, tool: string, reason: string): Promise<void> {
  if (!(await readSettings($)).notify.refusal) return
  const short = shortReason(reason)
  const now = await $.clock.now()
  const notified = ((await read($, notifiedAtom)) as unknown as Record<string, string> | null) ?? {}
  const last = Date.parse(notified[short] ?? '')
  if (Number.isFinite(last) && now - last < REFUSAL_NOTIFY_MS) return
  await update($, notifiedAtom, () => ({ ...notified, [short]: new Date(now).toISOString() }) as unknown as GemflowJson)
  const t = await words($)
  try { await $.ui.notify(t('拦下了 {0}：{1}', tool, short), { title: 'Gemflow' }) } catch { /* no channel */ }
}

/** A stage change, when the settings say so. */
async function notifyStage($: EngineInterface, res: Extract<BridgeResponse, { ok: true }>): Promise<void> {
  if (!(await readSettings($)).notify.stage) return
  const item = res.shell.status?.item
  const t = await words($)
  try { await $.ui.notify(t('{0} 进了 #{1}', item?.kind === 'item' ? item.id : 'Gemflow', (res.entered ?? []).join(' → ')), { title: 'Gemflow' }) } catch { /* no channel */ }
}

/** The last prompt's record changed by `fn`: what the turn after it did. */
async function notePrompt($: EngineInterface, fn: (p: PromptRecord) => PromptRecord): Promise<void> {
  await update($, promptsAtom, (was) => {
    const list = [...(((was as unknown) as PromptRecord[] | null) ?? [])]
    const last = list[list.length - 1]
    if (last === undefined) return was
    list[list.length - 1] = fn(last)
    return list as unknown as GemflowJson
  })
}

// ---- the actions -------------------------------------------------------------------

const VERB_FAILED = { result: 'gemflow failed; the line above the prompt says why' }

const PANE_TITLE = 'Gemflow'

/** The marketplace the plugin was installed from, read off its path; absent for a `--plugin-dir` plugin. */
function marketplaceOf(root: string): string | undefined {
  return root.split('\\').join('/').match(/\/plugins\/(?:cache|marketplaces)\/([^/]+)\//)?.[1]
}

async function openBoard($: EngineInterface, tab?: BoardTab): Promise<{ isPlaced: boolean; reason?: string }> {
  if (tab !== undefined) await update($, tabAtom, () => tab)
  if ((await readBoard($)) === null) await loadBoard($)
  return $.ui.open({ id: BOARD_ID, title: PANE_TITLE })
}

/** The newest published version, asked once per session. */
async function checkLatest($: EngineInterface): Promise<void> {
  if ((await read($, latestAtom)) !== null) return
  try {
    const r = await $.http.fetch(REGISTRY)
    const version = r.ok ? (JSON.parse(r.text) as { version?: unknown }).version : undefined
    await update($, latestAtom, () => (typeof version === 'string' ? { version } : { error: `HTTP ${r.status}` }) as unknown as GemflowJson)
  } catch (err) {
    const error = reasonOf(err)
    await update($, latestAtom, () => ({ error }) as unknown as GemflowJson)
  }
}

/** The bundled and the installed workflows, for the settings dialog. */
async function loadWorkflows($: EngineInterface): Promise<void> {
  const res = await bridge($, { op: 'add' }, SLOW_TIMEOUT_MS)
  if (res !== undefined && res.ok) {
    const value = { bundled: res.workflows ?? [], installed: res.installed ?? [] }
    await update($, workflowsAtom, () => value as unknown as GemflowJson)
  }
}

async function openDialog($: EngineInterface, dialog: Dialog | null): Promise<void> {
  await update($, dialogAtom, () => dialog)
  if (dialog === null) {
    await $.ui.close({ id: DIALOG_ID })
    return
  }
  const t = await words($)
  const title = dialog === 'settings' ? t('设置') : dialog === 'upgrade' ? t('升级') : dialog === 'about' ? t('关于') : t('分享')
  await $.ui.open({ id: DIALOG_ID, title, focus: true, closeOnEscape: true, holdToasts: true })
  if (dialog === 'settings') void loadWorkflows($)
  if (dialog === 'upgrade' || dialog === 'about') void checkLatest($)
}

/** An export: through the bridge, which writes under .geml/exports/; the path is toasted, the text comes back. */
async function exportText($: EngineInterface, kind: 'journal' | 'workflow' | 'text', format: 'geml' | 'md' | 'json', extra: { name?: string; text?: string; strip?: boolean } = {}): Promise<string | undefined> {
  const t = await words($)
  const res = await bridge($, { op: 'export', kind, format, ...extra }, SLOW_TIMEOUT_MS)
  if (res === undefined) return undefined
  if (!res.ok) { $.ui.toast(`gemflow：${res.error.replace(/^gemflow: /, '')}`); return undefined }
  if (res.exported !== undefined) $.ui.toast(t('已写入 {0}', res.exported.path))
  return res.exported?.text
}

async function sessionText($: EngineInterface, format: 'geml' | 'md' | 'json'): Promise<{ text: string; name: string } | undefined> {
  const t = await words($)
  const prompts = await readPrompts($)
  if (prompts.length === 0) { $.ui.toast(t('没有可导出的内容')); return undefined }
  let session = 'session'
  try { session = await $.session.id() } catch { /* headless */ }
  return { text: sessionExport(prompts, format, session, t), name: `session-${session.slice(0, 8)}` }
}

async function share($: EngineInterface, what: ShareWhat, how: ShareHow, strip: boolean, surface?: string): Promise<void> {
  const t = await words($)
  const copy = async (text: string): Promise<void> => {
    const r = await $.ui.copy({ text, ...(surface !== undefined ? { surface: surface as never } : {}) })
    $.ui.toast(r.isCopied ? t('已复制') : `gemflow：${r.reason}`)
  }
  let text: string | undefined
  if (what === 'status') {
    text = await shareStatus($, t)
    if (how === 'file') text = await exportText($, 'text', 'md', { name: 'status', text, strip })
  } else if (what === 'session') {
    const s = await sessionText($, how === 'copy' ? 'md' : 'geml')
    if (s === undefined) return
    text = how === 'copy' ? s.text : await exportText($, 'text', 'geml', { name: s.name, text: s.text, strip })
  } else text = await exportText($, what, what === 'journal' ? (how === 'copy' ? 'md' : 'geml') : 'geml', { strip })
  if (text === undefined || text === '') { if (text === '') $.ui.toast(t('没有可导出的内容')); return }
  if (how === 'copy') await copy(text)
  else if (how === 'pr') {
    const root = await read($, rootAtom)
    try {
      const r = await $.process.run(['gh', 'pr', 'comment', '--body', text], { cwd: root ?? undefined, timeoutMs: SLOW_TIMEOUT_MS })
      $.ui.toast(r.exitCode === 0 ? r.stdout.trim() || 'gh: ok' : `gh: ${r.stderr.trim() || r.stdout.trim()}`)
    } catch (err) { $.ui.toast(`gh: ${reasonOf(err)}`) }
  }
}

/** A press on the band or the board: what it does. */
async function act($: EngineInterface, action: BoardAction, surface?: string): Promise<void> {
  const t = await words($)
  const root = await read($, rootAtom)
  const through = async (op: BridgeOp, timeout = BRIDGE_TIMEOUT_MS): Promise<BridgeResponse | undefined> => {
    const res = await bridge($, op, timeout)
    if (res !== undefined && !res.ok) $.ui.toast(`gemflow：${res.error.replace(/^gemflow: /, '')}`)
    return res
  }
  switch (action.op) {
    // A person's option: taken on its own work item, then said into the conversation in their words, so the model hears what they chose.
    case 'advance': {
      const res = await bridge($, { op: 'advance', to: action.to }, BRIDGE_TIMEOUT_MS, action.file)
      if (res !== undefined && !res.ok) $.ui.toast(`gemflow：${res.error.replace(/^gemflow: /, '')}`)
      await loadBoard($)
      if (res?.ok === true && action.say !== undefined) await $.prompt.submit({ text: action.say, asUser: true })
      return
    }
    case 'mark': await through({ op: 'mark', variable: action.variable, checked: action.checked }); await loadBoard($); return
    case 'bind': await through({ op: 'bind', id: action.id }); await loadBoard($); return
    case 'pause': await through({ op: 'pause' }); await loadBoard($); return
    case 'resume': await through({ op: 'resume' }); await loadBoard($); return
    case 'refresh': await loadBoard($); return
    case 'learn':
      await through({ op: 'learn', lessons: action.lessons, tool: '', input: {}, cwd: root ?? '' })
      await update($, toolMenuAtom, () => null)
      await update($, toolNamingAtom, () => null)
      await loadBoard($)
      return
    case 'pass-once':
      await update($, passesAtom, (was) => [...new Set([...((((was as unknown) as string[] | null) ?? [])), ...action.keys])] as unknown as GemflowJson)
      $.ui.toast(t('放行一次'))
      return
    case 'retry': await startBridge($); await loadBoard($); return
    case 'tab': await update($, tabAtom, () => action.tab); return
    case 'filter': await update($, filterAtom, () => action.filter); return
    case 'expand': await update($, expandedAtom, () => action.entry); return
    case 'evidence': await update($, evidenceAtom, () => action.entry); return
    // Going back is the person's, asked once more: the recorded state changes, nothing that was done is undone.
    case 'rollback': {
      const state = (await readBoard($))?.timeline.find((e) => e.kind === 'snapshot' && e.rev === action.rev)
      const where = state !== undefined && state.kind === 'snapshot' ? state.state : '?'
      let answer: string
      try { answer = await $.ui.ask(t('回到第 {0} 条修订（{1}）？只改记下的阶段和变量，已经做了的事不会撤销。', action.rev, where), [t('回到这里'), t('取消')]) } catch { return }
      if (answer !== t('回到这里')) return
      await update($, expandedAtom, () => null)
      await through({ op: 'rollback', rev: action.rev })
      await loadBoard($)
      return
    }
    case 'fold': await update($, doneOpenAtom, () => action.open); return
    case 'tool-menu': await update($, toolMenuAtom, () => action.key); await update($, toolNamingAtom, () => null); return
    case 'tool-name': await update($, toolNamingAtom, () => action.key); return
    case 'tool-search': await update($, toolQueryAtom, () => action.query); return
    case 'tool-fold': await update($, toolsOpenAtom, (was) => {
      const list = new Set((((was as unknown) as string[] | null) ?? []))
      if (action.open) list.add(action.group); else list.delete(action.group)
      return [...list] as unknown as GemflowJson
    }); return
    case 'check-update': await update($, latestAtom, () => null); await checkLatest($); return
    case 'new-item': {
      const res = await through({ op: 'new-item', path: action.path, title: action.title, text: action.text })
      if (res?.ok === true) {
        $.ui.toast(t('已记成事项'))
        if (action.dismiss !== undefined) await act($, { op: 'dismiss', key: action.dismiss }, surface)
      }
      await loadBoard($)
      return
    }
    case 'judge-yes': {
      const j = (await read($, judgedAtom)) as unknown as Judgement | null
      if (j === null || j.taken) return
      const undo = await takeOption($, j.option)
      await update($, judgedAtom, () => ({ ...j, taken: true, ...(undo !== undefined ? { undo } : {}) }) as unknown as GemflowJson)
      return
    }
    case 'judge-pick': {
      const j = (await read($, judgedAtom)) as unknown as Judgement | null
      const pick = j?.alternatives?.[action.n - 1]
      if (j === null || j.taken || pick === undefined) return
      const undo = await takeOption($, pick)
      await update($, judgedAtom, () => ({ ...j, option: pick, alternatives: [], taken: true, ...(undo !== undefined ? { undo } : {}) }) as unknown as GemflowJson)
      return
    }
    case 'judge-no': await update($, judgedAtom, () => null); return
    case 'judge-undo': {
      const j = (await read($, judgedAtom)) as unknown as Judgement | null
      await update($, judgedAtom, () => null)
      if (j?.undo === undefined) return
      const res = await bridge($, { op: 'rollback', rev: j.undo.rev }, BRIDGE_TIMEOUT_MS, j.undo.file)
      await loadBoard($)
      $.ui.toast(res?.ok === true ? t('已撤销') : `gemflow：${res !== undefined && !res.ok ? res.error.replace(/^gemflow: /, '') : t('撤销')}`)
      return
    }
    case 'dismiss': {
      const next = [...new Set([...(await dismissedOf($)), action.key])]
      await update($, dismissedAtom, () => next as unknown as GemflowJson)
      try { await $.store.set(`dismissed:${root ?? ''}`, next as unknown as GemflowJson) } catch { /* the session keeps its own */ }
      return
    }
    case 'flow-state': await update($, flowStateAtom, () => action.id); return
    case 'flow-switch': {
      await update($, flowSwitchAtom, () => action.open)
      if (action.open && (await read($, workflowsAtom)) === null) await loadWorkflows($)
      return
    }
    case 'export':
      if (action.kind === 'session') {
        const s = await sessionText($, action.format)
        if (s === undefined) return
        await exportText($, 'text', action.format, { name: s.name, text: s.text })
        if (action.format === 'geml') await exportText($, 'journal', 'geml', { name: `${s.name}-journal` })
      } else await exportText($, action.kind, action.format)
      return
    case 'dialog': await openDialog($, action.dialog); return
    case 'open-board': {
      const opened = await openBoard($, action.tab)
      if (!opened.isPlaced) $.ui.toast(boardText(opened.reason))
      return
    }
    case 'use': await through({ op: 'use', workflow: action.workflow }, SLOW_TIMEOUT_MS); await loadWorkflows($); await loadBoard($); return
    case 'add': {
      const res = await through({ op: 'add', workflow: action.workflow }, SLOW_TIMEOUT_MS)
      if (res?.ok && res.added !== undefined) $.ui.toast(t('已添加 {0}', res.added.name))
      await loadWorkflows($); await loadBoard($)
      return
    }
    case 'import': {
      const res = await through({ op: 'import', path: action.path }, SLOW_TIMEOUT_MS)
      if (res?.ok && res.added !== undefined) $.ui.toast(t('已导入 {0}', res.added.name))
      await loadWorkflows($); await loadBoard($)
      return
    }
    case 'setting': {
      const next = withSetting(await readSettings($), action.key, action.value)
      await update($, settingsAtom, () => next as unknown as GemflowJson)
      try { await $.store.set(STORE_SETTINGS, next) } catch { /* read-only store */ }
      return
    }
    // The plugin's own prompt does not pass its own prompt.submit hook: the band's moment ends here.
    case 'say': {
      await setQueued($, (q) => [...q.filter((x) => x.text !== action.text), { text: action.text, entered: false }])
      await attentionOnPrompt($, action.text)
      try {
        await $.prompt.submit({ text: action.text, asUser: true })
      } catch (err) {
        await setQueued($, (q) => q.filter((x) => x.text !== action.text))
        throw err
      }
      await setQueued($, (q) => q.map((x) => (x.text === action.text ? { ...x, entered: true } : x)))
      return
    }
    // A slash command, run as typed once the session is idle; where the engine will not run it, it waits in the prompt box for Enter.
    case 'command': {
      const typed = `/${action.command}`
      await setQueued($, (q) => [...q.filter((x) => x.text !== typed), { text: typed, entered: false }])
      try {
        await $.command.run({ command: action.command })
      } catch {
        const filled = await $.prompt.fill({ text: typed }).catch(() => undefined)
        $.ui.toast(filled?.isFilled === true ? t('回车执行 {0}', typed) : `gemflow：${typed}`)
      }
      await setQueued($, (q) => q.filter((x) => x.text !== typed))
      return
    }
    case 'copy': {
      const r = await $.ui.copy({ text: action.text, ...(surface !== undefined ? { surface: surface as never } : {}) })
      $.ui.toast(r.isCopied ? t('已复制') : `gemflow：${r.reason}`)
      return
    }
    case 'switch-file': {
      await update($, lastFileAtom, () => action.file)
      const res = await through({ op: 'status' })
      await loadBoard($)
      // Coming back to a work item is the person's word too: the model hears which one.
      if (res?.ok === true && action.say !== undefined) await $.prompt.submit({ text: action.say, asUser: true })
      return
    }
    case 'turn-menu': await update($, turnMenuAtom, () => action.id); return
    case 'session-open': await update($, openSessionAtom, () => action.id); return
    case 'use-decision': {
      const filled = await $.prompt.fill({ text: `${t('参照 {0}：{1}', action.from, action.text)}\n`, mode: 'insert' }).catch(() => undefined)
      if (filled?.isFilled !== true) $.ui.toast(t('放不进输入框'))
      return
    }
    case 'session-flow': await update($, sessionFlowAtom, () => action.flow); return
    case 'session-run': await update($, sessionRunsAtom, (was) => {
      const list = new Set((((was as unknown) as string[] | null) ?? []))
      if (action.open) list.add(action.id); else list.delete(action.id)
      return [...list] as unknown as GemflowJson
    }); return
    // The conversation scrolls to the prompt's row, by the id the host gave it (session.append); a press is the person's own input, which is when a transcript row may move.
    case 'locate': {
      await update($, turnMenuAtom, () => null)
      const p = (await readPrompts($)).find((x) => x.id === action.id)
      if (p?.uuid === undefined) { $.ui.toast(t('这条 prompt 在对话里的位置还不知道')); return }
      let deny: string | undefined
      try { deny = (await $.ui.scroll({ to: { requestId: p.uuid }, block: 'start' })).deny } catch (err) { deny = reasonOf(err) }
      if (deny !== undefined) $.ui.toast(t('对话没有滚到那一处：{0}', deny))
      return
    }
    // Moving turns out of the session is the split-session skill's work, done by the model in a turn of its own: the person says yes here, the prompt names the turn by its time and first line and the skill's script by its path.
    case 'split':
    case 'remove': {
      await update($, turnMenuAtom, () => null)
      const p = (await readPrompts($)).find((x) => x.id === action.id)
      if (p === undefined) return
      const question = action.op === 'split' ? t('原会话先备份再改写，由模型按 split-session skill 做。把这条和它之后的轮次拆到新会话（最后一轮留下）？') : t('原会话先备份再改写，由模型按 split-session skill 做。把这一轮拆到一个单独的新会话（内容不丢）？')
      const yes = action.op === 'split' ? t('拆分') : t('删除')
      let answer: string
      try { answer = await $.ui.ask(question, [yes, t('取消')]) } catch { return }
      if (answer !== yes) return
      const script = `${$.plugin.root}/skills/split-session/split-session.mjs`
      const line = promptLine(p.text, 60)
      const text = action.op === 'split'
        ? t('用 gemflow:split-session skill（脚本 {0}）：先 list，找到 {1} 发的「{2}」那一轮，把它和之后的轮次（最后一轮除外）拆到新会话，标题概括这些轮的内容；拆完再 list 核对，然后汇报。', script, hhmm(p.at), line)
        : t('用 gemflow:split-session skill（脚本 {0}）：先 list，找到 {1} 发的「{2}」那一轮，只把这一轮拆到新会话，标题概括它的内容；拆完再 list 核对，然后汇报。', script, hhmm(p.at), line)
      await $.prompt.submit({ text })
      $.ui.toast(t('已交给模型，结果看对话'))
      return
    }
    case 'share': await share($, action.what, action.how, action.strip, surface); return
    default: return
  }
}

/** A press runs its action; a failure is one toast, never a crash of the drawing. */
function press($: EngineInterface, action: BoardAction): (e: { surface: string }) => void {
  return (e) => {
    // A transcript row moves only while the plugin answers the person's own input: 跳转 asks for the scroll first,
    // before anything is awaited, the prompt's row at the top of the window.
    if (action.op === 'locate' && action.uuid !== undefined) {
      const moving = $.ui.scroll({ to: { requestId: action.uuid }, block: 'start' })
      void moving.then(async (r) => { if (r.deny !== undefined) $.ui.toast((await words($))('对话没有滚到那一处：{0}', r.deny)) }).catch(async (err: unknown) => $.ui.toast((await words($))('对话没有滚到那一处：{0}', reasonOf(err))))
      void update($, turnMenuAtom, () => null).catch(() => undefined)
      return
    }
    void act($, action, e.surface).catch((err: unknown) => $.ui.toast(`gemflow：${reasonOf(err)}`))
  }
}

// ---- the drawings ---------------------------------------------------------------------

/** The elements, loosely typed: the pane is drawn on every surface, and only some have Input or Link. */
type Els = { Box: any; Text: any; Button: any; Link?: any; Input?: any; Svg?: any }

/** The surface's elements, with no Svg on the terminal: its table answers one, drawn as an empty box, where a character reads better. */
function elementsOf($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]): Els {
  const els = $.ui.resolve(e) as unknown as Els
  return (e as { surface?: string }).surface === 'terminal' ? { ...els, Svg: undefined } : els
}

/** A card's icon: a line drawing where the surface draws pictures, its character in the icon's colour elsewhere. */
function drawIcon(els: Els, k: Icon): unknown {
  const { Svg, Text } = els
  return Svg !== undefined ? <Svg source={ICON_SVG[k]} alt={k} width={14} height={14} /> : <Text {...toneProps(ICON_TONE[k])}>{ICON_CHAR[k]}</Text>
}

/**
 * The blank label of a button laid over an icon: two ideographic spaces, the icon's width and the room around it. A
 * desktop draws the label as HTML, where a run of plain spaces collapses to nothing: the button shrank to its padding
 * at the box's left edge, in front of the icon, and a press on the icon itself missed.
 */
const HIT = '　　'

/** A blank label as wide as `cells` columns, in ideographic spaces (two columns each), which HTML does not collapse. */
function blankOf(cells: number): string {
  return '　'.repeat(Math.max(1, Math.ceil(cells / 2)))
}

/** A glyph where the surface draws pictures; nothing elsewhere, where the words beside it say what it would. */
function drawGlyph(els: Els, g: Glyph, tone: Tone | 'active' = 'dim', size = 15): unknown {
  const { Svg } = els
  return Svg !== undefined ? <Svg source={glyphSvg(g, tone)} alt={g} width={size} height={size} /> : null
}

/**
 * An icon that is a press by itself (the dialogs): a Button holds only words, so a blank one is laid over the icon,
 * named by the label; the label shows under the pointer. Where the surface draws no pictures, the label as a button.
 */
function iconButton($: EngineInterface, els: Els, b: Pressable, g: Glyph, o: { tone?: Tone | 'active'; from?: 'left' | 'right'; size?: number } = {}): unknown {
  const { Box, Button, Text, Svg } = els
  if (Svg === undefined) return <Button key={b.key} plain dimColor label={b.label} onPress={press($, b.action)} />
  const edge = o.from === 'left' ? { left: 0 } : { right: 0 }
  return (
    <Box key={`${b.key}-icon`} flexShrink={0} alignItems="center" paddingX={1}>
      {drawGlyph(els, g, o.tone ?? 'dim', o.size ?? 18)}
      <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
        <Button key={b.key} plain label={HIT} onPress={press($, b.action)} />
      </Box>
      <Box position="absolute" top={1} {...edge} width={cellWidth(b.label) + 2} paddingX={1} display="none" hover={{ display: 'flex' }} backgroundColor="inverseText">
        <Text wrap="truncate-end">{b.label}</Text>
      </Box>
    </Box>
  )
}

/** The prototype's greys, with alpha so they read on a light and a dark ground: a rule, a heading, a band behind a row. */
const RULE = '#8a898666'
const HEADING = '#8a8986'
const SHADE = '#8a89861a'
const SELECTED = '#2a6fdb24'
function hairline(els: Els, key: string, columns: number): unknown {
  const { Text, Svg } = els
  return Svg !== undefined ? <Text key={key} color={RULE} wrap="truncate">{'─'.repeat(Math.max(1, columns - 2))}</Text> : null
}

/**
 * The rows in the prototype's grouping: a run of work items sits in one rounded box, a rule between them; any other
 * row as it is. Only where the surface draws pictures; the terminal's rows stand alone.
 */
function drawRows($: EngineInterface, els: Els, rows: BoardRow[], columns: number): unknown[] {
  if (els.Svg === undefined) return rows.map((r, i) => drawRow($, els, r, i))
  const { Box, Text } = els
  const out: unknown[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as BoardRow
    if (r.kind === 'turn' || r.kind === 'menu') {
      const run: Extract<BoardRow, { kind: 'turn' | 'menu' }>[] = []
      while (i < rows.length && ((rows[i] as BoardRow).kind === 'turn' || (rows[i] as BoardRow).kind === 'menu')) run.push(rows[i++] as Extract<BoardRow, { kind: 'turn' | 'menu' }>)
      i--
      out.push(
        <Box key={`turns-${r.key}`} flexDirection="column">
          {run.flatMap((x, n) => n === 0 || x.kind === 'menu' ? [drawRow($, els, x, n)] : [<Text key={`sep-${x.key}`} color={RULE} wrap="truncate">{'─'.repeat(Math.max(1, columns - 2))}</Text>, drawRow($, els, x, n)])}
        </Box>,
      )
      continue
    }
    if (r.kind !== 'entry') { out.push(drawRow($, els, r, i)); continue }
    const run: Extract<BoardRow, { kind: 'entry' }>[] = []
    while (i < rows.length && (rows[i] as BoardRow).kind === 'entry') run.push(rows[i++] as Extract<BoardRow, { kind: 'entry' }>)
    i--
    out.push(
      <Box key={`list-${r.key}`} flexDirection="column" borderStyle="round" borderColor={RULE} paddingX={1}>
        {run.flatMap((x, n) => n === 0 ? [drawRow($, els, x, n)] : [<Text key={`sep-${x.key}`} color={RULE} wrap="truncate">{'─'.repeat(Math.max(1, columns - 6))}</Text>, drawRow($, els, x, n)])}
      </Box>,
    )
  }
  return out
}

function drawRow($: EngineInterface, els: Els, row: BoardRow, i: number): unknown {
  const { Box, Text, Button, Link, Input } = els
  switch (row.kind) {
    case 'section': return (
      <Box key={row.key} gap={1} marginTop={i > 0 ? 1 : 0}>
        {els.Svg !== undefined ? <Text color={HEADING} bold>{row.text}</Text> : <Text dimColor bold>{row.text}</Text>}
        {row.count !== undefined && <Text dimColor>{String(row.count)}</Text>}
        {row.fold !== undefined && <Box flexGrow={1} />}
        {row.fold !== undefined && <Button key={row.fold.key} plain label={row.fold.label} onPress={press($, row.fold.action)} />}
      </Box>
    )
    case 'card': return (
      <Box key={row.key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box gap={1}>
          {drawIcon(els, row.icon)}
          {row.verb !== '' && <Text dimColor>{row.verb}</Text>}
          <Text bold wrap="truncate-end">{row.title}</Text>
          {row.tag !== undefined && row.tag !== '' && <Text dimColor>{row.tag}</Text>}
        </Box>
        {row.detail.map((d, n) => <Text key={`d${n}`} dimColor wrap="truncate-end">{d}</Text>)}
        {row.actions.length > 0 && (
          <Box gap={1}>
            {row.actions.map((b) => <Button key={b.key} label={b.label} {...(b.primary ? { variant: 'primary' } : {})} onPress={press($, b.action)} />)}
          </Box>
        )}
      </Box>
    )
    case 'entry': return (
      <Box key={row.key} gap={2} paddingX={els.Svg !== undefined ? 0 : 1}>
        {row.action !== undefined
          ? <Button key={`go-${row.key}`} plain label={row.title} onPress={press($, row.action)} />
          : <Text {...toneProps(row.tone)} wrap="truncate-end">{row.title}</Text>}
        <Box flexGrow={1} />
        {row.tag !== '' && <Text dimColor>{row.tag}</Text>}
      </Box>
    )
    case 'text': return <Text key={`r${i}`} {...toneProps(row.tone)}>{row.text}</Text>
    case 'button': return <Button key={row.key} plain label={row.label} {...(row.primary ? { variant: 'primary' } : {})} onPress={press($, row.action)} />
    case 'buttons': return (
      <Box key={`b${i}`} gap={2}>
        {row.items.map((b) => <Button key={b.key} label={b.label} {...(b.primary ? { variant: 'primary' } : {})} onPress={press($, b.action)} />)}
      </Box>
    )
    case 'link': return Link !== undefined ? <Link key={row.key} href={row.href} label={row.label} /> : <Text key={row.key} dimColor>{row.label}: {row.href}</Text>
    // A search is read as typed; any other field when submitted.
    case 'input': {
      const run = (value: string): void => { const a = inputAction(row.field, value, row.target); if (a !== undefined) void act($, a).catch((err: unknown) => $.ui.toast(`gemflow：${reasonOf(err)}`)) }
      if (Input === undefined) return <Text key={row.key} dimColor>{row.placeholder}</Text>
      return row.field === 'tool-search'
        ? <Input key={row.key} placeholder={row.placeholder} {...(row.value !== undefined ? { value: row.value } : {})} onInput={(value: string) => run(value)} onSubmit={run} />
        : <Input key={row.key} placeholder={row.placeholder} onSubmit={run} />
    }
    // A tool in one line: its name as the press that opens its menu, its use, what it looks like, how often it ran.
    case 'tool': return (
      <Box key={row.key} gap={2} paddingX={1}>
        {row.action !== undefined ? <Button key={`open-${row.key}`} plain label={row.name} onPress={press($, row.action)} /> : <Text {...toneProps(row.tone)}>{row.name}</Text>}
        <Text dimColor>{row.use}</Text>
        {row.guess !== '' && <Text {...toneProps('warning')}>{row.guess}</Text>}
        <Box flexGrow={1} />
        <Text {...toneProps(row.tone === 'normal' ? 'dim' : row.tone)}>{row.count}</Text>
      </Box>
    )
    // The flow picture: the parser's drawing where the surface draws pictures, the boxes and ways out in elements elsewhere.
    case 'flow': return els.Svg !== undefined && row.svg !== '' ? <els.Svg key={row.key} source={row.svg} alt="flow" /> : drawFlow($, els, row)
    case 'image': return els.Svg !== undefined
      ? <els.Svg key={row.key} source={row.svg} alt={row.alt} {...(row.width !== undefined ? { width: row.width } : {})} />
      : <Text key={row.key} bold>{row.alt}</Text>
    // A work item's way through its flow, in one line: the passed states ticked, the current one in the accent.
    case 'steps': return (
      <Box key={row.key} gap={1} flexWrap="wrap">
        {row.steps.map((s, n) => <Text key={`s${n}`} {...(s.current ? { color: BRAND_RED, bold: true } : s.passed ? {} : { dimColor: true })}>{`${n > 0 ? '→ ' : ''}${s.title}${s.passed ? ' ✓' : ''}`}</Text>)}
      </Box>
    )
    case 'heading': return (
      <Box key={row.key} gap={1}>
        <Text bold>{row.text}</Text>
        {row.sub !== '' && <Text dimColor>{row.sub}</Text>}
        {row.action !== undefined && <Box flexGrow={1} />}
        {row.action !== undefined && <Button key={row.action.key} plain label={row.action.label} onPress={press($, row.action.action)} />}
      </Box>
    )
    // Something that happened, in one line: its time, its kind, what, why, which turn; its evidence under it when shown.
    case 'event': return (
      <Box key={row.key} flexDirection="column">
        <Box gap={1}>
          {drawGlyph(els, row.glyph, row.tone === 'normal' ? 'dim' : row.tone, 14)}
          <Text dimColor>{row.at}</Text>
          <Text {...toneProps(row.tone === 'normal' ? 'dim' : row.tone)}>{row.label}</Text>
          <Button key={`open-${row.key}`} plain label={row.text} onPress={press($, row.action)} />
          {row.why !== '' && <Text dimColor wrap="truncate-end">{row.why}</Text>}
          {row.turn !== '' && <Text dimColor wrap="truncate-end">{row.turn}</Text>}
        </Box>
        {row.open && row.detail.map((d, n) => <Text key={`d${n}`} dimColor wrap="truncate-end">{`      ${d}`}</Text>)}
      </Box>
    )
    // A prompt in one line: its time, its first line as the press that opens its menu, what its turn did.
    case 'turn': return els.Svg !== undefined ? (
      <Box key={row.key} gap={2} paddingX={1} {...(row.open ? { backgroundColor: SELECTED } : { hover: { backgroundColor: SHADE } })}>
        <Box width={Math.max(5, cellWidth(row.at))} flexShrink={0}><Text dimColor>{row.at}</Text></Box>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Button key={`open-${row.key}`} plain label={row.text} onPress={press($, row.action)} />
          {row.did !== '' && <Text dimColor wrap="truncate-end">{row.did}</Text>}
        </Box>
      </Box>
    ) : (
      <Box key={row.key} flexDirection="column">
        <Box gap={1}>
          <Text dimColor>{row.at}</Text>
          <Button key={`open-${row.key}`} plain label={row.text} onPress={press($, row.action)} />
        </Box>
        {row.did !== '' && <Text dimColor wrap="truncate-end">{`      ${row.did}`}</Text>}
      </Box>
    )
    // A row's menu: a small card under the row, the entry that destroys in the error colour, the one that closes dim.
    case 'menu': return els.Svg !== undefined ? (
      <Box key={row.key} flexDirection="column" borderStyle="round" borderColor={RULE} marginLeft={8} width={20} paddingX={1}>
        {row.items.map((b) => <Button key={b.key} plain onPress={press($, b.action)}><Text {...(b.tone === 'danger' ? { color: 'error' } : b.tone === 'quiet' ? { dimColor: true } : {})}>{b.label}</Text></Button>)}
      </Box>
    ) : (
      <Box key={row.key} gap={2}>
        {row.items.map((b) => <Button key={b.key} label={b.label} onPress={press($, b.action)} />)}
      </Box>
    )
  }
}

/**
 * The flow picture (spec §8.2) in the pane's own elements, on every surface:
 * each rank a row of state boxes (the current one in the accent, a final one
 * double-framed, the start marked, a badge for the items standing there),
 * and under it the ways out of its states, one line each — a way out a
 * person may take now is a numbered button, its number the hotkey; the
 * transition last taken is in the success colour; one that needs approval in
 * the warning colour; the rest dim, a machine-judged condition marked ✓ or ✗.
 */
function drawFlow($: EngineInterface, els: Els, row: Extract<BoardRow, { kind: 'flow' }>): unknown {
  const { Box, Text, Button } = els
  const arrow = (e: FlowEdgeRow): string => (e.kind === 'self' ? '↻' : e.kind === 'forward' ? '↓' : e.back ? '↩' : '↷')
  return (
    <Box key={row.key} flexDirection="column">
      {row.ranks.map((rank, r) => {
        const many = rank.length > 1
        return (
          <Box key={`rank${r}`} flexDirection="column">
            <Box gap={1} flexWrap="wrap">
              {rank.map((s) => (
                <Box key={s.id} borderStyle={s.final ? 'double' : 'round'} {...(s.current ? { borderColor: BRAND_RED } : { borderDimColor: true })} paddingX={1}>
                  <Text {...(s.current ? { color: BRAND_RED, bold: true } : {})}>{`${s.initial ? '● ' : ''}${s.current ? '▶ ' : ''}${s.title}`}</Text>
                  {s.count > 0 && <Text dimColor>{` ${s.count}`}</Text>}
                </Box>
              ))}
            </Box>
            {rank.flatMap((s) => row.edges.filter((e) => e.from === s.id)).map((e) => {
              const mark = e.holds === true ? ' ✓' : e.holds === false ? ' ✗' : ''
              const label = `${arrow(e)} ${many ? `#${e.from} ` : ''}→ #${e.to}  ${e.text}${mark}`
              if (e.press !== undefined) return <Button key={`advance-${e.name}`} plain {...(e.press.n <= 9 ? { hotkey: String(e.press.n) } : {})} label={label} onPress={press($, e.press.action)} />
              return <Text key={`edge-${e.name}`} {...toneProps(e.taken ? 'success' : e.approval && e.holds !== false ? 'warning' : 'dim')}>{`    ${label}`}</Text>
            })}
          </Box>
        )
      })}
    </Box>
  )
}

/** The board's header: the mark, the name, the version and a newer one when told; the dialogs; the work item, its stage and flow, and its hold. */
interface Header {
  version: string;
  newer?: string;
  dialogs: Pressable[];
  name?: string;
  stage?: string;
  flow?: string;
  /** Why there is no work item, when there is none. */
  reason?: string;
  hold?: Pressable;
}

async function headerRows($: EngineInterface, t: T): Promise<Header> {
  const shell = await readShell($)
  const s = shell?.status ?? null
  const version = shell?.versions?.gemflow ?? (await read($, versionAtom)) ?? ''
  const latest = (await read($, latestAtom)) as unknown as { version?: string } | null
  const newer = (await readSettings($)).notify.update && latest?.version !== undefined && version !== '' && isNewer(latest.version, version) ? latest.version : undefined
  const dialogs: Pressable[] = (['share', 'settings', 'upgrade', 'about'] as const).map((d) => ({ key: `dialog-${d}`, label: d === 'share' ? t('分享') : d === 'settings' ? t('设置') : d === 'upgrade' ? t('升级') : t('关于'), action: { op: 'dialog', dialog: d } }))
  const head: Header = { version, dialogs, ...(newer !== undefined ? { newer } : {}) }
  if (s !== null && s.item.kind === 'item') {
    const hold: Pressable = s.paused ? { key: 'resume', label: t('继续'), primary: true, action: { op: 'resume' } } : { key: 'pause', label: t('⏸ 暂停'), action: { op: 'pause' } }
    return { ...head, name: s.title ?? s.item.id, ...(s.state !== undefined ? { stage: s.paused ? `${s.state.title} · ${t('已暂停')}` : s.state.title } : {}), flow: s.workflow.title, hold }
  }
  if (s !== null && s.item.kind === 'inactive') return { ...head, reason: s.item.reason }
  return head
}

/** The settings, upgrade, about and share dialogs as rows. */
async function dialogRows($: EngineInterface, t: T, dialog: Dialog, columns: number): Promise<BoardRow[]> {
  const text = (s: string, tone: Tone = 'normal'): BoardRow => ({ kind: 'text', text: truncate(s, columns), tone })
  const section = (key: string, s: string): BoardRow => ({ kind: 'section', key, text: s })
  const toggle = (label: string, key: string, on: boolean): Pressable => ({ key: `set-${key}`, label: `${on ? '[x]' : '[ ]'} ${label}`, action: { op: 'setting', key, value: !on } })
  const rows: BoardRow[] = []
  const shell = await readShell($)
  const version = shell?.versions?.gemflow ?? (await read($, versionAtom)) ?? '?'
  if (dialog === 'settings') {
    const s = await readSettings($)
    rows.push(section('notify', t('桌面提醒')),
      { kind: 'buttons', items: [toggle(t('有事等你定或验收时'), 'notify.inbox', s.notify.inbox)] },
      { kind: 'buttons', items: [toggle(t('模型被拦时'), 'notify.refusal', s.notify.refusal)] }, text(`    ${t('同一原因 3 分钟内只提一次')}`, 'dim'),
      { kind: 'buttons', items: [toggle(t('阶段变更时'), 'notify.stage', s.notify.stage)] })
    rows.push(section('judge', t('判定')), { kind: 'buttons', items: [toggle(t('每一轮判定：打字就是按按钮'), 'judge.enabled', s.judge.enabled)] }, text(t('你发的话像是在选待处理里的某一项时，替你按下（有把握）或先问一句（没把握）；用一个小模型判断。'), 'dim'))
    const system = langOf('system', shell?.locale ?? (await read($, localeAtom)) ?? undefined)
    const names: Record<string, string> = { zh: '中文', en: 'English', ja: '日本語' }
    rows.push(section('language', t('语言')), { kind: 'buttons', items: ([['system', t('跟随系统（{0}）', names[system] ?? system)], ['zh', '中文'], ['en', 'English'], ['ja', '日本語']] as const).map(([v, label]): Pressable => ({ key: `lang-${v}`, label, ...(s.language === v ? { primary: true } : {}), action: { op: 'setting', key: 'language', value: v } })) })
    rows.push(text(t('状态带、看板、提醒的文字跟着换；流程自己的标题和说明保持作者写的语言。'), 'dim'))
    rows.push(text(t('流程在「流程」页换和调整，工具在「工具」页归类，都写回仓库里的文件。'), 'dim'))
  } else if (dialog === 'upgrade') {
    const latest = (await read($, latestAtom)) as unknown as { version?: string; error?: string } | null
    rows.push({ kind: 'heading', key: 'version', text: t('当前 {0}', version), sub: '' })
    if (latest === null) rows.push(text('…', 'dim'))
    else if (latest.version !== undefined) rows.push(isNewer(latest.version, version) ? text(t('● 可更新 {0}', latest.version), 'warning') : latest.version === version ? text(t('已是最新'), 'success') : text(t('已发布 {0}', latest.version), 'dim'))
    else rows.push(text(t('无法检查更新：{0}', latest.error ?? '?'), 'dim'))
    const market = marketplaceOf($.plugin.root)
    const command = `claude plugin update gemflow${market !== undefined ? `@${market}` : ''}`
    rows.push({ kind: 'buttons', items: [
      { key: 'check-update', label: t('检查更新'), action: { op: 'check-update' } },
      ...(latest?.version !== undefined && isNewer(latest.version, version) ? [{ key: 'copy-update', label: `${t('更新')}: ${command}`, primary: true, action: { op: 'copy', text: command } } as Pressable] : []),
    ] })
    if (RELEASE_NOTES.version === version) {
      rows.push(section('notes', t('这一版有什么')))
      for (const line of RELEASE_NOTES.lines) rows.push(text(`· ${t(line)}`))
    }
    rows.push({ kind: 'link', key: 'link-changelog', href: LINKS.changelog, label: t('完整 CHANGELOG') })
    if (market !== undefined) rows.push(text(t('装在 marketplace {0}', market), 'dim'))
    rows.push(text(t('更新后下一个会话生效；本会话不受影响'), 'dim'))
    rows.push({ kind: 'buttons', items: [toggle(t('有新版本时在看板上提示'), 'notify.update', (await readSettings($)).notify.update)] })
  } else if (dialog === 'about') {
    rows.push({ kind: 'image', key: 'lockup', svg: LOCKUP_SVG, alt: 'Gemflow', width: 180 })
    rows.push(text(t('写下一条提示词之前，要看的都在一处：在做什么、等你定什么、做出了什么。流程用 GEML 写，可以换、可以调，也可以导入自己的。')))
    rows.push(text(t('插件 @geml/gemflow {0}', version), 'dim'), text(t('解析器 @geml/geml {0}', shell?.versions?.parser ?? '?'), 'dim'))
    rows.push(text(t('流程格式 geml-statechart/v1'), 'dim'), text(t('许可 MIT'), 'dim'))
    rows.push({ kind: 'link', key: 'link-spec', href: LINKS.spec, label: t('规范与文档') }, { kind: 'link', key: 'link-repo', href: LINKS.repo, label: t('仓库') }, { kind: 'link', key: 'link-feedback', href: LINKS.feedback, label: t('反馈') })
  } else {
    const choice = ((await read($, shareAtom)) as unknown as { what: ShareWhat; how: ShareHow; strip: boolean } | null) ?? { what: 'status', how: 'copy', strip: true }
    const s = shell?.status
    if (s?.item.kind === 'item') rows.push({ kind: 'heading', key: 'share-title', text: t('分享 {0}', s.title ?? s.item.id), sub: '' })
    const whats: [ShareWhat, string, string][] = [
      ['status', t('现在在哪'), t('工作项走到哪、等你定和验收的事、最近的产物')],
      ['journal', t('这个工作项的记录'), t('每次阶段变更、凭据、产物、被拦，带哈希链，对方能校验')],
      ['session', t('本会话'), t('提示词和那一轮做了什么；工具调用的输出不带')],
      ['workflow', t('流程与工具词典'), t('flow.geml、tools.geml、guide.geml，给别的项目用')],
    ]
    rows.push(section('what', t('分享什么')))
    for (const [what, label, note] of whats) rows.push({ kind: 'button', key: `what-${what}`, label: `${choice.what === what ? '(•)' : '( )'} ${label}  ${note}`, action: { op: 'share-pick', what } as unknown as BoardAction })
    rows.push(section('how', t('怎么给')), { kind: 'buttons', items: ([['copy', t('复制文字')], ['file', t('存成文件')], ['pr', t('PR 评论')]] as const).map(([how, label]): Pressable => ({ key: `how-${how}`, label, ...(choice.how === how ? { primary: true } : {}), action: { op: 'share-pick', how } as unknown as BoardAction })) })
    if (choice.what === 'status') {
      for (const line of (await shareStatus($, t)).split('\n')) if (line !== '') rows.push(text(`  ${line}`, 'dim'))
    }
    rows.push({ kind: 'buttons', items: [{ key: 'strip', label: `${choice.strip ? '[x]' : '[ ]'} ${t('去掉命令行里的绝对路径')}`, action: { op: 'share-pick', strip: !choice.strip } as unknown as BoardAction }] })
    rows.push({ kind: 'buttons', items: [
      { key: 'share-cancel', label: t('取消'), action: { op: 'dialog', dialog: null } },
      { key: 'share-go', label: choice.how === 'copy' ? t('复制') : choice.how === 'file' ? t('存成文件') : t('发 PR 评论'), primary: true, action: { op: 'share', what: choice.what, how: choice.how, strip: choice.strip } },
    ] })
  }
  return rows
}

/** Where the work stands, as the share dialog says it: the same pending list as the band's, and what the work made. */
async function shareStatus($: EngineInterface, t: T): Promise<string> {
  const shell = await readShell($)
  const board = await readBoard($)
  const item = shell?.status?.item
  const pending = pendingList(await inboxOf($, t), [...othersWaiting(board, item?.kind === 'item' ? item.id : undefined, t), ...(board !== null ? toolSuggestions(board, await usageNow($), await dismissedOf($), t) : [])])
  return statusShareText(shell, pending, board?.products, t)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await update($, rootAtom, () => e.cwd)
    await update($, setupAtom, () => null)
    await loadStored($)
    await restorePrompts($)
    for (const t of FLOW_TOOLS) {
      await registerOne($, t.name, () => $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false }))
    }
    await registerOne($, NOTE_TOOL.name, () => $.tool.register({ name: NOTE_TOOL.name, description: NOTE_TOOL.description, inputSchema: NOTE_TOOL.inputSchema as unknown as Record<string, unknown>, isDeferred: false }))
    await registerOne($, '/gemflow', () => $.command.register({ name: 'gemflow', description: 'Gemflow：当前阶段、看板、暂停与继续、切换或添加流程', argumentHint: COMMAND_HINT }))
    // The settings, from the store; the host's language; the plugin's version.
    try {
      const stored = await $.store.get(STORE_SETTINGS)
      await update($, settingsAtom, () => settingsFrom(stored) as unknown as GemflowJson)
    } catch { await update($, settingsAtom, () => DEFAULT_SETTINGS as unknown as GemflowJson) }
    try { const lang = await $.env.get('LANG'); if (lang !== undefined) await update($, localeAtom, () => lang) } catch { /* no env */ }
    try {
      const manifest = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))) as { version?: unknown }
      if (typeof manifest.version === 'string') { const v = manifest.version; await update($, versionAtom, () => v) }
    } catch { /* no manifest */ }
    await startBridge($)
    // A load is a reload: nothing is due. The repository's facts now and every two minutes; the band every minute, so a
    // person away from the keyboard comes back to "你离开了 …" without having to type first.
    await update($, reloadAtom, () => false)
    await update($, queuedAtom, () => [])
    $.clock.after(0, () => { void loadFacts($) })
    $.clock.every(120_000, () => { void loadFacts($) })
    $.clock.every(60_000, () => { $.ui.invalidate('ui.render'); void loadProjectSessions($) })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The clients driving the session (the desktop app, a phone over Remote Control): kept for the environment line.
  on('session.attach', async ($, e, next) => {
    const done = await next(e)
    try {
      await update($, clientsAtom, (was) => [...(((was as unknown) as AttachedClient[] | null) ?? []).filter((c) => c.clientId !== e.clientId), { clientId: e.clientId, surface: e.surface }] as unknown as GemflowJson)
      $.ui.invalidate('ui.render')
    } catch { /* the roster stays */ }
    return done
  }).catch(($, e, next) => next(e))
  on('session.detach', async ($, e, next) => {
    const done = await next(e)
    try {
      await update($, clientsAtom, (was) => (((was as unknown) as AttachedClient[] | null) ?? []).filter((c) => c.clientId !== e.clientId) as unknown as GemflowJson)
      $.ui.invalidate('ui.render')
    } catch { /* the roster stays */ }
    return done
  }).catch(($, e, next) => next(e))

  // A /clear ends the conversation the model read the stage in: the next prompt delivers it again. What ran is stored.
  on('session.end', async ($, e, next) => {
    await update($, deliveredAtom, () => null)
    try { await storeUsage($) } catch { /* kept for the session */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every tool call. A broken gemflow never blocks one: where next already ran, next(e) replays its result.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    // How often each tool is used: every call is noted under its day as it starts, by the key the dictionary would give it, gemflow's own too.
    await noteUsage($, tool, toolArgs(e as unknown as Record<string, unknown>))
    if (isOwnTool(tool) || tool === `mcp__gemflow__${NOTE_TOOL.name}`) return next(e)
    await retryStart($)
    if (e.agentId === undefined) await notePrompt($, (p) => ({ ...p, tools: p.tools + 1 }))
    const input = toolArgs(e as unknown as Record<string, unknown>)
    const call = { tool, input }
    const policy = (await readShell($))?.policy ?? null
    const root = await read($, rootAtom)
    // Where the call starts, read before it runs: a `cd` in its own command line has not moved the loop yet.
    const cwd = policy !== null ? await callCwd($) : undefined
    const elsewhere = cwd !== undefined && root !== null && (await actsElsewhere($, call, cwd, root))
    // An engine that cannot say where the call starts: at the root, as the session did.
    const from = cwd ?? root ?? ''
    const passes = await readPasses($)
    let consulted = false
    let decision = beforeDecision(policy, call, elsewhere, passes)
    // A question about the preferred tool is asked here, once a session for a row; the answer goes through the bridge into the dictionary, and the CLI then judges and records.
    const passed = ((await read($, preferPassedAtom)) as unknown as string[] | null) ?? []
    if (decision.kind === 'prefer' && passed.includes(decision.key)) decision = { kind: 'pass' }
    if (decision.kind === 'prefer') {
      const asked = decision
      const answered = await askPerson($, asked)
      if (answered.kind === 'pass') await update($, preferPassedAtom, (was) => [...new Set([...((((was as unknown) as string[] | null) ?? [])), asked.key])] as unknown as GemflowJson)
      if (answered.kind === 'deny') return { deny: `gemflow: ${answered.reason}` }
      if (answered.kind === 'learn') {
        await bridge($, { op: 'learn', lessons: answered.lessons, tool, input: bridgeInput(input), cwd: from })
        decision = { kind: 'consult' }
      } else decision = { kind: 'pass' }
    }
    if (decision.kind === 'consult') {
      const waived = decision.waived
      const before = { op: 'before' as const, tool, callId: e.tool_use_id, input: bridgeInput(input), cwd: from, ...(waived !== undefined ? { waived } : {}) }
      const res = await bridge($, before)
      if (res !== undefined && res.ok && res.refusal !== undefined) {
        if (e.agentId === undefined) await notePrompt($, (p) => ({ ...p, refusals: p.refusals + 1 }))
        await notifyRefusal($, tool, res.refusal)
        return { deny: `gemflow: ${res.refusal}` }
      }
      // The waiver was spent on this call.
      if (waived !== undefined && res !== undefined && res.ok) await update($, passesAtom, (was) => ((((was as unknown) as string[] | null) ?? []).filter((k) => !waived.includes(k))) as unknown as GemflowJson)
      consulted = res !== undefined && res.ok && res.recorded === true
    }
    // A tool with default parameters in the dictionary: the ones the model left out are filled in.
    const fill = paramsToFill(policy, call)
    const ran = await next(fill === undefined ? e : { ...e, ...fill })
    if (ran.deny !== undefined) return ran
    const wrotePath = touchedPath(tool, input, root ?? '')
    // A file written in another checkout is that checkout's work item, never the session's current one.
    if (!elsewhere && wrotePath !== undefined && matchesUnit(policy, wrotePath, (await readShell($))?.units ?? [])) await update($, lastFileAtom, () => wrotePath)
    if (wrotePath !== undefined && ran.isError !== true) { const path = wrotePath; $.clock.after(0, () => { void sessionsOnFile($, path) }) }
    const exitCode = CLAUDE_CODE_TOOLS.run.includes(tool) ? bashExitCode(ran) : undefined
    const outcome = {
      isError: ran.isError === true,
      gitOperation: hasGitOperation(ran),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(wrotePath !== undefined ? { wrotePath } : {}),
    }
    if (!afterNeeded(policy, call, { ...outcome, consulted }, elsewhere)) return ran
    const delivered = await deliveredFor($, e.agentId)
    const before = (await readShell($))?.status?.vars ?? {}
    const res = await bridge($, { op: 'after', tool, callId: e.tool_use_id, input: bridgeInput(input), ...outcome, cwd: from, ...(delivered !== null ? { delivered } : {}) })
    if (res !== undefined && res.ok && e.agentId === undefined) {
      const after = res.shell.status?.vars ?? {}
      const signals = Object.keys(after).filter((k) => after[k] === true && before[k] !== true)
      const entered = res.entered ?? []
      if (signals.length > 0 || entered.length > 0) await notePrompt($, (p) => ({ ...p, signals: [...p.signals, ...signals], entered: [...p.entered, ...entered] }))
    }
    return withStage($, ran, res, e.agentId)
  }).catch(($, e, next) => next(e))

  // The three tools. Each hook is a function literal: the engine reads hooks statically and refuses one that is a call's result.
  on('tool.call', { tool: 'mcp__gemflow__status' }, ($, e) => serveVerb($, 'status', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__move' }, ($, e) => serveVerb($, 'move', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__set' }, ($, e) => serveVerb($, 'set', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__note' }, ($, e) => noteDecisions($, e)).catch(() => ({ result: 'gemflow could not record that' }))

  // The model is told once about the project's other sessions and the note tool.
  on('prompt.compose', async ($, e, next) => {
    const done = await next(e)
    return { ...done, sections: [...done.sections, { id: 'gemflow:sessions', text: SESSIONS_PROMPT, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // A main-loop turn's end: the first sentence of its answer goes on its prompt's row, as what the turn did.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      try { await setQueued($, (q) => q.filter((x) => !x.entered)) } catch { /* shown till the next */ }
      $.clock.after(0, () => { void storePrompts($) })
      if (!e.isAborted) { const answer = e.answer; $.clock.after(0, () => { void sessionsOnAnswer($, answer) }) }
      try { await storeUsage($) } catch { /* kept for the next turn */ }
      try {
        const did = answerGist(e.answer)
        if (did !== undefined) await notePrompt($, (p) => (p.did === undefined ? { ...p, did } : p))
      } catch { /* the row stays without it */ }
      if (!e.isAborted) {
        try {
          const prompts = await readPrompts($)
          const was = await readAttention($)
          const kept: Attention = { reply: e.answer, replyAt: await $.clock.now(), asked: prompts[prompts.length - 1]?.text ?? '', memory: was?.memory ?? NO_MEMORY, consumed: false }
          await update($, attentionAtom, () => kept as unknown as GemflowJson)
          const facts = await read($, factsAtom)
          await update($, factsAtReplyAtom, () => facts)
          $.clock.after(0, () => { void loadFacts($) })
        } catch { /* the band keeps the last reply */ }
      }
    }
    return done
  })

  // The person's prompt is recorded for the sessions tab; the stage changed between prompts (a person moved it, session start caught up git): the model hears of it now.
  on('prompt.submit', async ($, e, next) => {
    // Where it came from: this machine's prompt box, or Remote Control (a plugin's own prompt keeps the last).
    if (e.origin.kind !== 'plugin') { try { await update($, originAtom, () => e.origin.kind) } catch { /* unknown */ } }
    const person = e.origin.kind !== 'plugin' || e.origin.asUser === true
    const news = person ? [...(await attentionOnPrompt($, e.text)), ...(await sessionsOnPrompt($, e.text).catch(() => [] as string[]))] : []
    const go = (ev: typeof e) => next(news.length > 0 ? { ...ev, context: [...(ev.context ?? []), ...news] } : ev)
    // Between turns, where the person may have moved the session: the root follows. Within a turn it stays, so a call in another checkout stays elsewhere.
    await followCwd($)
    const root = await read($, rootAtom)
    if (root === null) return go(e)
    await retryStart($)
    if (e.origin.kind !== 'plugin' || e.origin.asUser === true) {
      const s = (await readShell($))?.status
      const record: PromptRecord = {
        id: `p${(await readPrompts($)).length + 1}-${Date.now().toString(36)}`, at: await nowIso($), text: e.text,
        ...(s?.item.kind === 'item' ? { item: s.item.id, itemTitle: s.title ?? s.item.id } : {}), ...(s?.state !== undefined ? { state: s.state.id } : {}),
        ...(s?.workflow !== undefined ? { flow: s.workflow.title } : {}),
        tools: 0, refusals: 0, entered: [], signals: [],
      }
      const before = await readPrompts($)
      await update($, promptsAtom, (was) => [...((((was as unknown) as PromptRecord[] | null) ?? [])), record].slice(-PROMPTS_KEPT) as unknown as GemflowJson)
      $.clock.after(0, () => { void storePrompts($) })
      // A typed prompt is judged (an option pressed said what it chose already), after it is on its way.
      if (e.origin.kind !== 'plugin' && (await readSettings($)).judge.enabled) {
        const lastAnswer = before[before.length - 1]?.did ?? ''
        const text = e.text
        $.clock.after(0, () => { void judgeTurn($, text, lastAnswer).catch(() => update($, judgedAtom, () => null)) })
      } else await update($, judgedAtom, () => null)
    }
    let doc: string
    try {
      doc = String(await $.fs.read(`${root}/.geml/context.geml`))
    } catch {
      return go(e)
    }
    const seen = contextOf(doc)
    if (seen === undefined || seen.key === (await read($, deliveredAtom))) return go(e)
    const item = (await readShell($))?.status?.item
    if (item === undefined || item.kind !== 'item' || item.id !== seen.item) return go(e)
    await update($, deliveredAtom, () => seen.key)
    return go({ ...e, context: [...(e.context ?? []), seen.text] })
  }).catch(($, e, next) => next(e))

  // A command that writes into the plugin's own folder (a developer copying a new build in): a reload is due.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const done = await next(e)
    try {
      const command = String(e.command ?? '').replace(/\\/g, '/')
      const root = $.plugin.root.replace(/\\/g, '/')
      if (command.includes(root) || /local-marketplaces/.test(command)) await update($, reloadAtom, () => true)
      if (/\bgit\b[^\n|;&]*\bcommit\b/.test(command) && !(await read($, committedAtom))) await update($, committedAtom, () => true)
    } catch { /* nothing due */ }
    return done
  }).catch(($, e, next) => next(e))

  // The host stores the person's prompt as a row with an id, the same the transcript file holds: the sessions tab's newest record without one learns it, so a press can scroll to the row.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId === undefined && e.message.role === 'user' && e.message.isMeta !== true && e.origin.kind !== 'plugin') {
      const uuid = e.uuid
      await update($, promptsAtom, (was) => {
        const list = [...(((was as unknown) as PromptRecord[] | null) ?? [])]
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const p = list[i] as PromptRecord
          if (p.uuid === undefined) { list[i] = { ...p, uuid }; return list as unknown as GemflowJson }
        }
        return was
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band (spec §8.1): Gemflow's mark, the one thing that is the person's now with its options, how many more wait, the board.
  // Hovering the thing's name, or `还有 N 件`, shows it whole in the line's place: a card drawn over the line, never beyond it.
  // A render that throws (a shell this module cannot read) draws one line saying so, never the engine's blank.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = elementsOf($, e)
    const { Box, Text, Button, Svg } = els
    const t = await words($)
    let view: BandView
    // The board is a press away whenever there is a workflow, not only when something waits in it.
    let workflow = false
    let waitingOnPerson = 0
    try {
      const shell = await readShell($)
      const board = await readBoard($)
      const item = shell?.status?.item
      // What waits on the person, the same list the board's 待处理 shows: the current work item's things, then the others'.
      const inbox = pendingList(await inboxOf($, t), [...othersWaiting(board, item?.kind === 'item' ? item.id : undefined, t), ...(board !== null ? [...toolSuggestions(board, await usageDrawn($), await dismissedOf($), t), ...ciSuggestions(board, shell?.units ?? [], await dismissedOf($), t)] : [])])
      workflow = shell?.status != null
      waitingOnPerson = inbox.length
      view = bandView({
        shell, problem: await read($, problemAtom), setup: await read($, setupAtom), todo: (await read($, todoAtom)) as unknown as TodoCount | null,
        inbox, timeline: board?.timeline ?? [], now: await nowIso($), t,
      })
    } catch (err) {
      view = { verb: '', title: `gemflow：状态带画不出来（${reasonOf(err)}）`, tone: 'error', note: '', detail: '', actions: [], more: { count: 0, detail: '' } }
    }
    // A fresh judgement of the last prompt stands in for the one thing: what it took (with an undo), or what it asks.
    const judged = (await read($, judgedAtom)) as unknown as Judgement | null
    if (judged !== null && Date.parse(await nowIso($)) - Date.parse(judged.at) < JUDGEMENT_MS) {
      const line = judgementLine(judged, t)
      view = { ...view, verb: t('判定'), title: line.title, tone: 'normal', note: line.note, detail: `${judged.said}${SEP}${line.title}${line.note !== '' ? `${SEP}${line.note}` : ''}`, actions: line.actions }
    }
    // What needs the person now (attention.ts): the reply's asks and the steps only they can take lead, after a broken
    // bridge and a fresh judgement; the workflow's own waiting items and a pause come next; a line of steps still owed
    // stands in for "我在做" only when nothing else does.
    let attentionPresses: Pressable[] | null = null
    const judgedFresh = judged !== null && Date.parse(await nowIso($)) - Date.parse(judged.at) < JUDGEMENT_MS
    if (view.tone !== 'error' && !judgedFresh) {
      try {
        const at = await attentionNow($, t)
        const workflowWaits = waitingOnPerson > 0 || view.verb === t('已暂停')
        if (at.line !== null && (at.line.lead !== null || !workflowWaits)) {
          view = { verb: '', title: at.line.text, tone: at.line.lead === 'broken' ? 'error' : 'normal', note: '', detail: at.line.text, actions: [], more: { count: 0, detail: '' } }
          attentionPresses = pressablesFor(at.lead, at.line.options, t)
          const pressed = pressedOf(attentionPresses, await readQueued($))
          if (pressed !== undefined) { view = { ...view, note: pendingNote(pressed, t) }; attentionPresses = [] }
        }
      } catch { /* the workflow's line stands */ }
    }
    const options: Pressable[] = attentionPresses ?? view.actions
    const tail: Pressable[] = [
      ...(view.more.count > 0 ? [{ key: 'more', label: t('还有 {0} 件', view.more.count), action: { op: 'open-board', tab: 'items' } as BoardAction }] : []),
      ...(workflow ? [{ key: 'board', label: t('看板'), action: { op: 'open-board' } as BoardAction }] : []),
    ]
    if (view.title === '' && options.length === 0 && tail.length === 0) return next(e)
    const columns: number = e.props.bodyColumns
    const env = await envNow($, t, e.surface).catch(() => ({ parts: [] as string[], host: null as HostInfo | null, remote: false }))
    const at = env.remote && env.host !== null ? `@${env.host.name}` : ''
    const reserve = [...options, ...tail].reduce((w, b) => w + (b.key === 'board' && Svg !== undefined ? 4 : cellWidth(b.label) + 5), 0) + (at !== '' ? cellWidth(at) + 1 : 0)
    const lead = 2 + (view.verb !== '' ? cellWidth(view.verb) + 1 : 0)
    const room = Math.max(8, columns - reserve - lead)
    const noteRoom = view.note !== '' ? Math.min(cellWidth(view.note) + 3, Math.floor(room / 3)) : 0
    const title = truncate(view.title, Math.max(6, room - noteRoom))
    const note = view.note !== '' ? truncate(`${SEP}${view.note}`, noteRoom) : ''
    /** The whole of something, drawn over the line while the pointer is on what it belongs to. */
    const card = (text: string, anchor: { left: number } | { right: number }, width: number) => text === '' ? null : (
      <Box position="absolute" top={0} {...anchor} width={Math.max(10, width)} display="none" hover={{ display: 'flex' }} backgroundColor="inverseText">
        <Text wrap="truncate-end">{text}</Text>
      </Box>
    )
    // Where the surface draws pictures, a native button as the design has it (a hotkey there draws a number badge);
    // the terminal's rows read "1: label", a survey's way.
    const pressable = (b: Pressable, i: number) => Svg !== undefined
      ? (b.key === 'board'
        ? iconButton($, els, b, 'board', { from: 'right', size: 15 })
        : <Button key={b.key} label={b.label} {...(b.primary ? { variant: 'primary' } : {})} onPress={press($, b.action)} />)
      : <Button key={b.key} plain hotkey={String(i + 1)} label={b.label} {...(b.primary ? { variant: 'primary' } : {})} onPress={press($, b.action)} />
    const board = tail.find((b) => b.key === 'board')
    return (
      <Box gap={1} alignItems="center" flexGrow={1}>
        {/* The mark opens the board: a blank button laid over the picture (a Button holds only words), the mark itself as the button on the terminal. */}
        {Svg !== undefined
          ? (
            <Box key="band-mark" flexShrink={0} alignItems="center" paddingX={1}>
              <Svg source={MARK_SVG} alt="Gemflow" width={13} height={13} />
              <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
                <Button key="band-mark-open" plain label={HIT} onPress={press($, { op: 'open-board' })} />
              </Box>
            </Box>
          )
          : <Button key="band-mark-open" plain label={t('看板')} onPress={press($, { op: 'open-board' })}><Text {...toneProps(MARK.tone)}>{MARK.text}</Text></Button>}
        {view.verb !== '' && <Text dimColor>{view.verb}</Text>}
        <Box key="band-title">
          {workflow
            ? <Button key="title" plain label={view.title} onPress={press($, { op: 'open-board', tab: 'items' })}><Text {...(Svg !== undefined && view.tone === 'normal' ? { color: 'suggestion' } : toneProps(view.tone))} underline={view.tone === 'normal'}>{title}</Text></Button>
            : <Text {...toneProps(view.tone)}>{title}</Text>}
          {card([view.detail !== '' ? `${view.verb !== '' ? `${view.verb} ` : ''}${view.title}${SEP}${view.detail}` : '', env.parts.join(SEP)].filter((x) => x !== '').join(`${SEP}`), { left: 0 }, columns - lead)}
        </Box>
        {note !== '' && <Text dimColor>{note}</Text>}
        {options.map(pressable)}
        {at !== '' && <Text dimColor>{at}</Text>}
        {tail.map((b, i) => b.key === 'more'
          ? <Box key="band-more">{pressable(b, options.length + i)}{card(view.more.detail, { right: 0 }, columns - 4)}</Box>
          : null)}
        {board !== undefined && <Box key="band-push" flexGrow={1} />}
        {board !== undefined && pressable(board, options.length + tail.indexOf(board))}
      </Box>
    )
  })

  // The board (spec §8.2): the header, five tabs as a row of buttons over the tab atom, and rows from board.ts.
  // The matcher spells BOARD_ID's value: the engine reads matchers statically (an imported constant shows as requestId=?).
  on('ui.render', { component: 'Pane', requestId: 'gemflow-board' }, async ($, e) => {
    const els = elementsOf($, e)
    const { Box, Text, Button } = els
    const t = await words($)
    // A tab this version no longer has (one kept from before an update) opens the work items.
    const kept = await read($, tabAtom)
    const tab: BoardTab = (TAB_IDS as readonly string[]).includes(kept) ? kept : HOME_TAB
    const columns = e.props.bodyColumns
    let rows: BoardRow[]
    let head: Awaited<ReturnType<typeof headerRows>> | undefined
    try {
      const inbox = await inboxOf($, t)
      head = await headerRows($, t)
      rows = paneRows({
        board: await readBoard($), problem: await read($, boardProblemAtom), shell: await readShell($), tab, columns, maxRows: Math.max(4, e.props.scroll.bodyRows - 4), t,
        now: await nowIso($), root: (await read($, rootAtom)) ?? '', inbox,
        filter: (await read($, filterAtom)) as JournalFilter, expanded: await read($, expandedAtom), evidence: await read($, evidenceAtom),
        // Written on every tool call: read only on the tabs that show them, so a call redraws no other tab.
        prompts: tab === 'sessions' || tab === 'journal' ? await readPrompts($) : [],
        ...(tab === 'sessions' ? { project: { sessions: ((await read($, projectSessionsAtom)) as unknown as SessionSummary[] | null) ?? [], own: await $.session.id().catch(() => ''), open: await read($, openSessionAtom) } } : {}),
        menu: await read($, turnMenuAtom), doneOpen: await read($, doneOpenAtom),
        sessionFlow: await read($, sessionFlowAtom), sessionRuns: ((await read($, sessionRunsAtom)) as unknown as string[] | null) ?? [],
        flowState: await read($, flowStateAtom), switching: await read($, flowSwitchAtom), workflows: (await read($, workflowsAtom)) as unknown as { bundled: string[]; installed: string[] } | null,
        usage: await usageDrawn($), dismissed: await dismissedOf($), toolQuery: await read($, toolQueryAtom), toolMenu: await read($, toolMenuAtom), toolNaming: await read($, toolNamingAtom),
        toolsOpen: ((await read($, toolsOpenAtom)) as unknown as string[] | null) ?? [],
      })
    } catch (err) {
      rows = [{ kind: 'text', text: truncate(`gemflow：看板画不出来（${reasonOf(err)}）`, columns), tone: 'error' }]
    }
    const envLine = (await envNow($, t, e.surface).catch(() => ({ parts: [] as string[] }))).parts
    // The work items open on 此刻: everything the band has room for one of.
    if (tab === 'items') {
      try {
        const at = await attentionNow($, t)
        rows = [...nowRows({ reply: at.reply, standing: at.standing, memory: at.memory, queued: await readQueued($), t }), ...rows]
      } catch { /* the work items alone */ }
    }
    return (
      <Box flexDirection="column">
        {head !== undefined && (
          <Box gap={1} alignItems="center">
            {els.Svg !== undefined ? <els.Svg source={MARK_SVG} alt="Gemflow" width={16} height={16} /> : <Text {...toneProps(MARK.tone)}>{MARK.text}</Text>}
            <Text bold>Gemflow</Text>
            {head.version !== '' && (els.Svg !== undefined
              ? <Box key="version" borderStyle="round" borderColor={RULE} paddingX={1}><Text dimColor>{head.version}</Text></Box>
              : <Text dimColor>{head.version}</Text>)}
            {head.newer !== undefined && <Button key="newer" plain label={t('● 可更新 {0}', head.newer)} onPress={press($, { op: 'dialog', dialog: 'upgrade' })} />}
            <Box flexGrow={1} />
            <Box key="dialogs" gap={els.Svg !== undefined ? 2 : 1} alignItems="center">
              {head.dialogs.map((d) => iconButton($, els, d, d.key.replace(/^dialog-/, '') as Glyph))}
            </Box>
          </Box>
        )}
        {head !== undefined && hairline(els, 'rule-top', columns)}
        {head?.name !== undefined && (els.Svg !== undefined
          ? (
            <Box key="item-row" gap={1} alignItems="center" backgroundColor={SHADE} paddingX={1}>
              <Text bold>{head.name}</Text>
              {head.stage !== undefined && <Text bold color="inverseText" backgroundColor="text">{` ${head.stage} `}</Text>}
              {head.flow !== undefined && <Text dimColor>{head.flow}</Text>}
              <Box flexGrow={1} />
              {head.hold !== undefined && <Button key={head.hold.key} label={head.hold.label} onPress={press($, head.hold.action)} />}
            </Box>
          )
          : (
            <Box gap={1}>
              <Text bold>{head.name}</Text>
              {head.stage !== undefined && <Text {...toneProps('brand')} bold>{head.stage}</Text>}
              {head.flow !== undefined && <Text dimColor>{head.flow}</Text>}
              <Box flexGrow={1} />
              {head.hold !== undefined && <Button key={head.hold.key} plain dimColor label={head.hold.label} onPress={press($, head.hold.action)} />}
            </Box>
          ))}
        {head?.reason !== undefined && <Text dimColor>{head.reason}</Text>}
        {envLine.length > 0 && <Text key="env" dimColor wrap="truncate-end">{envLine.join(SEP)}</Text>}
        {hairline(els, 'rule-head', columns)}
        <Box gap={els.Svg !== undefined ? 3 : 2} flexWrap="wrap" alignItems="center">
          {tabs(t).map((x) => els.Svg !== undefined
            ? iconButton($, els, { key: `tab-${x.id}`, label: x.label, action: { op: 'tab', tab: x.id } }, x.id, { tone: x.id === tab ? 'active' : 'dim', from: 'left' })
            : x.id === tab
              ? <Button key={`tab-${x.id}`} plain onPress={press($, { op: 'tab', tab: x.id })}><Text bold underline>{x.label}</Text></Button>
              : <Button key={`tab-${x.id}`} plain dimColor label={x.label} onPress={press($, { op: 'tab', tab: x.id })} />)}
        </Box>
        {hairline(els, 'rule-tabs', columns)}
        {drawRows($, els, rows, columns)}
      </Box>
    )
  })

  // The dialogs (settings, upgrade, about, share): one pane, its content by the dialog atom.
  on('ui.render', { component: 'Pane', requestId: 'gemflow-dialog' }, async ($, e) => {
    const els = elementsOf($, e)
    const { Box, Text, Button } = els
    const t = await words($)
    const dialog = (await read($, dialogAtom)) as Dialog | null
    let rows: BoardRow[]
    try {
      rows = dialog === null ? [] : await dialogRows($, t, dialog, e.props.bodyColumns)
    } catch (err) {
      rows = [{ kind: 'text', text: `gemflow：${reasonOf(err)}`, tone: 'error' }]
    }
    return (
      <Box flexDirection="column">
        {rows.map((r, i) => drawRow($, els, r, i))}
        <Box>
          <Button key="close" role="dismiss" plain dimColor label={t('关闭')} onPress={press($, { op: 'dialog', dialog: null })} />
        </Box>
        {dialog === null && <Text dimColor> </Text>}
      </Box>
    )
  })

  // The share dialog's picks are the module's own, not the board's: they change the dialog, nothing else.
  on('ui.press', { plugin: 'gemflow', requestId: 'gemflow-dialog' }, async ($, e, next) => {
    const m = e.element.match(/^(what|how|strip)(?:-(.+))?$/)
    if (m === null) return next(e)
    const choice = ((await read($, shareAtom)) as unknown as { what: ShareWhat; how: ShareHow; strip: boolean } | null) ?? { what: 'status', how: 'copy', strip: true }
    const value = m[1] === 'what' ? { ...choice, what: m[2] as ShareWhat } : m[1] === 'how' ? { ...choice, how: m[2] as ShareHow } : { ...choice, strip: !choice.strip }
    await update($, shareAtom, () => value as unknown as GemflowJson)
    return next(e)
  })

  // /gemflow (spec §8.3). The board opens only when asked, so it is placed at any width.
  on('command.run', { command: 'gemflow' }, async ($, e) => {
    await retryStart($)
    const t = await words($)
    const intent = parseCommand(e.args)
    if (intent.kind === 'board') {
      const failure = await loadBoard($)
      if (failure !== null) return { text: boardText(undefined, failure, t) }
      const opened = await openBoard($, intent.tab)
      return { text: boardText(opened.isPlaced ? undefined : opened.reason, undefined, t) }
    }
    const op: BridgeOp | undefined = intent.kind === 'status' ? { op: 'status' }
      : intent.kind === 'pause' ? { op: 'pause' }
      : intent.kind === 'resume' ? { op: 'resume' }
      : intent.kind === 'use' ? { op: 'use', workflow: intent.workflow }
      : intent.kind === 'add' ? { op: 'add', ...(intent.workflow !== undefined ? { workflow: intent.workflow } : {}) }
      : undefined
    const res = op === undefined ? undefined : await bridge($, op, intent.kind === 'status' ? BRIDGE_TIMEOUT_MS : SLOW_TIMEOUT_MS)
    // Another workflow (use, or add's first one), or a hold: another board.
    if (res !== undefined && res.ok && (intent.kind === 'use' || intent.kind === 'pause' || intent.kind === 'resume' || (intent.kind === 'add' && res.added?.activated === true))) await reloadBoardLater($)
    return { text: commandText(intent, res, await read($, problemAtom), t) }
  }).catch(() => ({ text: 'gemflow：命令没有完成，原因见输入框上方的状态带' }))
}
