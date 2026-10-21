// The hooks module under the engine's own test host. A scripted bridge
// answers `process.run`; nothing here touches a disk or starts a process.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROOT = '/work/app'
/** The home directory the test's environment names. */
const HOME = '/home/me'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const PANE = { title: 'Gemflow', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

/** A prompt's context without the standing instructions a conversation's first prompt carries (tested on their own): undefined when nothing else is there. */
const sans = (ctx: readonly string[] | undefined): readonly string[] | undefined => {
  if (ctx === undefined) return undefined
  const rest = ctx.filter((s) => !s.startsWith('Gemflow: '))
  return rest.length === 0 ? undefined : rest
}
const COMPOSER = { kind: 'composer' as const }
const PRESENTATION = { isFullscreen: true, columns: 160 }

/** A three-state workflow: build → review on the machine's judgement (tests-pass and pr-open), review → done on the model's or a person's. */
const USES: Record<string, string[]> = { build: ['edit', 'test'], review: [], done: [] }
const NEXT = (vars: Record<string, boolean>): Record<string, unknown[]> => {
  const missing = ['tests-pass', 'pr-open'].filter((v) => vars[v] !== true)
  return {
    build: [{ name: 'build→review', to: 'review', judge: 'machine', approval: false, guard: 'tests-pass and pr-open', reads: ['tests-pass', 'pr-open'], missing, holds: missing.length === 0, note: '', label: 'review', toFinal: false, toStart: false }],
    review: [{ name: 'review→done', to: 'done', judge: 'model', approval: false, reads: [], missing: [], holds: true, note: '', label: 'done', toFinal: true, toStart: false }],
    done: [],
  }
}
/** review → done as an approval edge that holds once the tests passed: what the inbox and the band act on. */
const APPROVAL = (vars: Record<string, boolean>) => ({ name: 'review→done', to: 'done', judge: 'machine', approval: true, guard: 'tests-pass', reads: ['tests-pass'], missing: vars['tests-pass'] === true ? [] : ['tests-pass'], holds: vars['tests-pass'] === true, note: '', label: '通过', toFinal: true, toStart: false })
/** The dictionary, as the policy and the board carry it. */
const ROWS = [
  { tool: 'Read', allow: ['*'], deny: [], default: false, row: 1 },
  { tool: 'Grep', allow: ['*'], deny: [], default: false, row: 2 },
  { tool: 'Bash(ls)', allow: ['*'], deny: [], default: false, row: 3 },
  { tool: 'Edit', for: 'edit', allow: [], deny: [], default: true, row: 4 },
  { tool: 'Write', for: 'edit', allow: [], deny: [], default: false, row: 5 },
  { tool: 'Bash(npm test)', for: 'test', allow: [], deny: [], default: true, row: 6 },
  { tool: 'Bash(wrangler deploy)', for: 'deploy', allow: [], deny: [], default: true, row: 7 },
]

type Req = { op: string; [key: string]: unknown }

/** A path as the engine hands it to a hook, read back as the POSIX path the test named: on Windows /work/app arrives as C:\work\app. */
const posix = (p: string): string => p.replace(/^[A-Za-z]:/, '').split('\\').join('/')

/** A project as the bridge would report it, and the bridge itself, scripted. */
function world(on: On) {
  const w = {
    sent: [] as Req[],
    registered: [] as string[],
    state: 'build',
    rev: 0,
    vars: { 'tests-pass': false, 'pr-open': true } as Record<string, boolean>,
    node: true,
    bridge: true,
    /** When set, `process.run` of the bridge answers this raw stdout, exit code and stderr. */
    raw: null as { stdout: string; exitCode: number; stderr: string } | null,
    /** When false, the project has no workflow: every answer is the quiet problem shell, and no board. */
    workflow: true,
    /** Tools the engine refuses to register, by name, with the refusal. */
    refuse: {} as Record<string, string>,
    /** How many times the board pane was opened. */
    opened: 0,
    /** The panes closed, by id. */
    closed: [] as string[],
    /** When set, the bridge answers every request as the CLI answers one that threw: an error with no shell. */
    error: null as string | null,
    /** The to-do count refresh and board answers carry; null when the work item is no media entry. */
    todo: null as { item: string; state: string; count: number } | null,
    /** The directory `$.session.cwd()` answers: the loop making the next call stands there. */
    cwd: ROOT,
    /** The `.git` entries `$.fs.stat` finds, by path; every other path is missing. */
    gitEntries: new Set<string>(),
    /** When set, an `after` the bridge is sent answers this other work item's new stage text as well. */
    routed: null as { item: string; context: string } | null,
    /** The session's current work item, as git would say after a branch switch. */
    item: 'feat/x',
    /** The directory of the project's session logs the attention answer names; null, none. */
    sessionsDir: null as string | null,
    /** Files the module wrote or a test laid down, by path. */
    files: new Map<string, string>(),
    /** The open pull requests the attention answer carries. */
    prs: [] as { number: number; branch: string; green: boolean; failing: string[] }[],
    /** The other work items the board lists, beside the current one. */
    items: [] as Record<string, unknown>[],
    /** While set, an `after` request is held until it settles: a bridge slow to answer. */
    hold: null as Promise<void> | null,
    /** A board op held until it resolves; `boardless`: the board op answers with no board. */
    holdBoard: null as Promise<void> | null,
    /** The version the plugin's folder holds, as the CLI reports it; `manifest`, the one the module reads at its start. */
    synced: null as string | null,
    manifest: null as string | null,
    /** The transcripts backfill-list names, and what backfill-one answers for each file (a string fails it). */
    transcripts: [] as { file: string; id: string; size: number }[],
    /** The prompt rows this session's transcript holds (turn-ids); null, no transcript. */
    turnIds: null as string[] | null,
    /** Answers for the next turn-ids calls, one each, before `turnIds` stands in: a transcript that changes between two reads. */
    turnIdsQueue: [] as (string[] | null)[],
    backfills: new Map<string, Record<string, unknown> | string>(),
    boardless: false,
    /** The work items that have a journal: a handoff to one of them is a return, to any other a new item. */
    journals: new Set(['feat/x']),
    /** When set, review → done needs a person (APPROVAL). */
    approval: false,
    /** Whether a person holds the work item. */
    paused: false,
    /** The journal's timeline as the board carries it. */
    timeline: [] as unknown[],
    /** The lessons the bridge was asked to learn, the store, the notifications and the copies, as the hooks module sent them. */
    lessons: [] as unknown[],
    store: new Map<string, unknown>(),
    notified: [] as string[],
    copied: [] as string[],
    toasts: [] as string[],
  }
  const stage = () => `[gemflow] stage #${w.state} · rev ${w.rev}`
  const shell = () => ({
    status: {
      workflow: { name: 'dev', path: '.geml/workflows/dev/flow.geml', title: '开发流程' },
      item: { kind: 'item', id: w.item },
      state: { id: w.state, title: w.state, rev: w.rev, uses: USES[w.state] ?? [], final: w.state === 'done', since: '2026-10-12T09:00:00Z' },
      vars: w.vars,
      sources: { 'tests-pass': 'tool:test', 'pr-open': 'git:pr-open' },
      next: w.approval && w.state === 'review' ? [APPROVAL(w.vars)] : (NEXT(w.vars)[w.state] ?? []),
      refusals: 0, paused: w.paused, gh: { available: true },
    },
    policy: {
      active: true, unit: { kind: 'branch' }, state: w.state, uses: USES[w.state] ?? [],
      fences: { edit: ['build'], test: ['build'], deploy: ['release'] }, rows: ROWS, files: [], git: true,
      relevant: w.state === 'build' ? ['tests-pass', 'pr-open'] : [], evidence: ['test'],
    },
    contextKey: `${w.item}@${w.rev}`,
    ...(w.synced !== null ? { versions: { gemflow: w.synced, parser: '1.12.5' } } : {}),
  })
  /** What the CLI hands over when an after or verb answer is on another work item than the one the main loop last read. */
  const handoff = (req: Req) => {
    const delivered = typeof req.delivered === 'string' ? req.delivered : undefined
    if (delivered === undefined || delivered.slice(0, delivered.lastIndexOf('@')) === w.item) return {}
    const line = w.journals.has(w.item)
      ? `[gemflow] back on ${w.item} · #${w.state} · rev ${w.rev} · tests-pass ✗ · pr-open ✓`
      : `[gemflow] now on ${w.item} · #${w.state} (new work item)`
    w.journals.add(w.item)
    return { handoff: line, context: stage() }
  }
  const board = () => ({
    states: [
      { id: 'build', title: 'build', description: '写代码和测试', initial: true, final: false, uses: ['edit', 'test'] },
      { id: 'review', title: 'review', description: '', initial: false, final: false, uses: [] },
      { id: 'done', title: 'done', description: '', initial: false, final: true, uses: [] },
    ],
    transitions: [
      { name: 'build→review', from: 'build', to: 'review', judge: 'machine', approval: false, guard: 'tests-pass and pr-open', note: '' },
      { name: 'review→done', from: 'review', to: 'done', judge: 'model', approval: false, note: '' },
    ],
    fences: [{ use: 'edit', states: ['build'] }, { use: 'test', states: ['build'] }],
    tools: ROWS, backlog: null, items: [{ id: 'feat/x', state: w.state, rev: w.rev, at: '2026-10-12T09:00:00Z', paused: w.paused }, ...w.items], timeline: w.timeline, clocks: [], tree: 'tree:1',
    // The flow picture as the CLI sends it: the parser's topology, the overlay, and the SVG a web surface inlines.
    picture: {
      flow: {
        ranks: [['build'], ['review'], ['done']],
        edges: [
          { name: 'build→review', from: 'build', to: 'review', kind: 'forward', label: 'pr-open, tests-pass', sentence: false, marks: [] },
          { name: 'review→done', from: 'review', to: 'done', kind: 'forward', label: '', sentence: true, marks: [] },
        ],
      },
      overlay: { current: w.state },
      svg: '<svg/>',
    },
  })
  const answer = (req: Req) => {
    w.sent.push(req)
    if (!w.workflow) {
      const none = { status: null, policy: null, contextKey: null, problem: { text: 'no workflow here: run `gemflow init`', quiet: true } }
      return ['verb', 'mark', 'advance', 'bind'].includes(req.op) ? { v: 1, ok: false, error: 'no workflow here', shell: none } : { v: 1, ok: true, shell: none }
    }
    if (req.op === 'after' && w.routed !== null) return { v: 1, ok: true, shell: shell(), entered: [], routed: w.routed }
    const ranTests = (req.input as { command?: string } | undefined)?.command === 'npm test'
    if (req.op === 'after' && ranTests && req.exitCode === 0 && w.state === 'build') {
      w.vars['tests-pass'] = true
      w.state = 'review'
      w.rev = 3
      return { v: 1, ok: true, shell: shell(), entered: ['review'], context: stage() }
    }
    // A tool bound to a use this state does not declare: refused, and the refusal recorded.
    if (req.op === 'before' && (req.tool === 'Edit' || req.tool === 'Write') && !(USES[w.state] ?? []).includes('edit')) {
      return { v: 1, ok: true, shell: shell(), refusal: `${String(req.tool)} is edit, which is used only in #build; the workflow is in #${w.state}`, recorded: true }
    }
    // A fenced command pattern: refused unless the person waived it for this call.
    const line = (req.input as { command?: string } | undefined)?.command ?? ''
    if (req.op === 'before' && /wrangler deploy/.test(line) && !(req.waived as string[] | undefined)?.includes('Bash(wrangler deploy)')) {
      return { v: 1, ok: true, shell: shell(), refusal: `"${line}" is deploy, which is used only in #release; the workflow is in #${w.state}`, recorded: true }
    }
    if (req.op === 'pause') { w.paused = true; return { v: 1, ok: true, shell: shell() } }
    if (req.op === 'resume') { w.paused = false; return { v: 1, ok: true, shell: shell(), entered: [] } }
    if (req.op === 'learn') { w.lessons.push(req.lessons); return { v: 1, ok: true, shell: shell() } }
    if (req.op === 'export') return { v: 1, ok: true, shell: shell(), exported: { path: `.geml/exports/${String(req.name ?? 'x')}.${String(req.format)}`, text: String(req.text ?? 'journal text') } }
    if (req.op === 'import') return { v: 1, ok: true, shell: shell(), workflows: ['coding', 'dev'], installed: ['dev', 'mine'], added: { name: 'mine', activated: false } }
    if (req.op === 'add' && req.workflow === undefined) return { v: 1, ok: true, shell: shell(), workflows: ['coding', 'dev', 'refund'], installed: ['dev'] }
    if (req.op === 'advance') {
      w.state = String(req.to)
      w.rev += 1
      return { v: 1, ok: true, shell: shell(), entered: [w.state] }
    }
    if (req.op === 'verb' && req.name === 'move' && w.state === 'build') {
      w.state = 'review'
      w.rev = 5
      return { v: 1, ok: true, shell: shell(), text: '{"to":"review"}', context: stage() }
    }
    if (req.op === 'verb') return { v: 1, ok: true, shell: shell(), text: `[gemflow] work item feat/x · state #${w.state}` }
    if (req.op === 'board') return w.boardless ? { v: 1, ok: true, shell: shell() } : { v: 1, ok: true, shell: shell(), board: board(), todo: w.todo }
    if (req.op === 'artifact') return { v: 1, ok: true, shell: shell(), text: `Recorded the link under feat/x's artifacts.` }
    if (req.op === 'backfill-list') return { v: 1, ok: true, shell: shell(), backfill: { sessions: w.transcripts } }
    if (req.op === 'turn-ids') {
      const ids = w.turnIdsQueue.length > 0 ? (w.turnIdsQueue.shift() as string[] | null) : w.turnIds
      return ids === null ? { v: 1, ok: false, error: 'gemflow: no transcript', shell: shell() } : { v: 1, ok: true, shell: shell(), backfill: { uuids: ids } }
    }
    if (req.op === 'backfill-one') {
      const b = w.backfills.get(String(req.file))
      return typeof b === 'string' ? { v: 1, ok: false, error: `gemflow: ${b}`, shell: shell() } : { v: 1, ok: true, shell: shell(), backfill: b ?? { id: String(req.id), turns: 0, files: 0, links: 0 } }
    }
    if (req.op === 'refresh') return { v: 1, ok: true, shell: shell(), todo: w.todo }
    if (req.op === 'status' && w.sessionsDir !== null) return { v: 1, ok: true, shell: shell(), sessions: w.sessionsDir }
    if (req.op === 'attention') return { v: 1, ok: true, shell: shell(), attention: { ahead: [], prs: w.prs }, ...(w.sessionsDir !== null ? { sessions: w.sessionsDir } : {}), host: { name: 'build-box', platform: 'linux', user: 'dev', branch: 'feat/x' } }
    return { v: 1, ok: true, shell: shell(), ...(req.op === 'before' ? { recorded: false } : {}), ...(req.op === 'after' ? handoff(req) : {}) }
  }
  const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  on('process.run', async ($, e) => {
    if (e.argv[2] === 'hook' && w.hold !== null && (JSON.parse(e.init?.stdin ?? '{}') as Req).op === 'after') await w.hold
    if (e.argv[2] === 'hook' && w.holdBoard !== null && (JSON.parse(e.init?.stdin ?? '{}') as Req).op === 'board') await w.holdBoard
    if (e.argv[1] === '--version') return w.node ? { value: ran('v24.1.0\n') } : { deny: 'spawn node ENOENT' }
    if (e.argv[0] === '/bin/sh') return { value: ran('', 1) }
    // git's answer for the checkout a directory is in: the deepest `.git` entry at or above it.
    if (e.argv[0] === 'git' && e.argv[3] === 'rev-parse') {
      const dir = e.argv[2] ?? ''
      const top = [...w.gitEntries].map((g) => g.slice(0, -'/.git'.length)).filter((t) => dir === t || dir.startsWith(`${t}/`)).sort((a, b) => b.length - a.length)[0]
      return { value: top !== undefined ? ran(`${top}
`) : ran('', 128) }
    }
    if (e.argv[2] === 'hook') {
      if (!w.bridge) return { deny: 'timed out after 15000 ms' }
      if (w.raw !== null) return { value: { ...ran(w.raw.stdout, w.raw.exitCode), stderr: w.raw.stderr } }
      if (w.error !== null) return { value: ran(`${JSON.stringify({ v: 1, ok: false, error: `gemflow: ${w.error}` })}\n`) }
      return { value: ran(`${JSON.stringify(answer(JSON.parse(e.init?.stdin ?? '{}') as Req))}\n`) }
    }
    return { deny: `unexpected ${e.argv.join(' ')}` }
  })
  // .geml/context.geml as the CLI writes it: the stage's text in `text {#current}`, the item, state and rev in `data {#stage}`.
  on('fs.write', ($, e) => { w.files.set(posix(e.path), e.text); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: w.files.has(posix(e.path)) }))
  on('fs.list', ($, e) => {
    const dir = posix(e.path ?? '').replace(/\/$/, '')
    return { value: [...w.files.entries()].filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(([p, text]) => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => (posix(e.path).endsWith('/.claude-plugin/plugin.json') && w.manifest !== null ? { value: JSON.stringify({ version: w.manifest }) } : w.files.has(posix(e.path)) ? { value: w.files.get(posix(e.path)) as string } : posix(e.path) === `${ROOT}/.geml/context.geml`
    ? { value: `=== meta\nprofile = "geml-statechart/v1"\n===\n\n=== data {#stage format=json}\n${JSON.stringify({ item: w.item, state: w.state, rev: w.rev })}\n===\n\n=== text {#current}\n${stage()}\n===\n` }
    : { deny: 'ENOENT' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('fs.stat', ($, e) => (w.gitEntries.has(posix(e.path)) ? { value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  on('tool.register', ($, e) => {
    const refused = w.refuse[e.name]
    if (refused !== undefined) return { deny: refused }
    w.registered.push(e.name)
    return { value: { tool: `mcp__gemflow__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    w.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => { w.closed.push(e.id); return { value: undefined } })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.notify', ($, e) => { w.notified.push(e.text); return { value: { isSent: true, channel: 'test' } } })
  on('ui.copy', ($, e) => { w.copied.push(e.text); return { value: { isCopied: true } } })
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => { w.store.set(e.key, e.value); return { value: undefined } })
  on('env.get', ($, e) => ({ value: e.name === 'LANG' ? 'zh_CN.UTF-8' : e.name === 'HOME' ? HOME : undefined }))
  on('session.id', () => ({ value: 'sess-1234567890' }))
  on('http.fetch', () => ({ deny: 'offline' }))
  return w
}

async function start($: Engine, on: On): Promise<ReturnType<typeof mock.clock>> {
  const clock = mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

type Drawn = { type: string; key?: string; props?: Record<string, unknown>; children?: (Drawn | string)[] }

const keyOf = (el: Drawn): unknown => el.key ?? el.props?.key
/** Whether a drawing holds the Button keyed `key`. */
const holds = (el: Drawn | string, key: string): boolean => typeof el !== 'string' && ((el.type === 'Button' && keyOf(el) === key) || (el.children ?? []).some((c) => holds(c, key)))
/** The Box a press laid over others spans: the parent of the nearest absolutely placed Box above the Button keyed `key`. */
const spanOf = (el: Drawn | string, key: string, path: Drawn[] = []): Drawn | undefined => {
  if (typeof el === 'string') return undefined
  if (el.type === 'Button' && keyOf(el) === key) {
    const i = path.map((p) => p.props?.position).lastIndexOf('absolute')
    return i > 0 ? path[i - 1] : undefined
  }
  for (const c of el.children ?? []) { const found = spanOf(c, key, [...path, el]); if (found !== undefined) return found }
  return undefined
}

/** The words a drawing shows, in order: what a Box drawn hidden holds (a card the pointer reveals) left out. */
const shown = (el: Drawn | string, out: string[] = []): string[] => {
  if (typeof el === 'string') { if (el.trim() !== '') out.push(el.trim()); return out }
  if (el.props?.display === 'none') return out
  if (el.type === 'Button' && (el.children ?? []).length === 0) out.push(`[${String(el.props?.label)}]`)
  for (const c of el.children ?? []) shown(c, out)
  return out
}

/** The card the pointer reveals over the band's title: the one thing whole. */
const bandCard = async ($: Engine): Promise<string | undefined> => {
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const hidden = (el: Drawn | string): Drawn | undefined => {
    if (typeof el === 'string') return undefined
    if (el.props?.display === 'none') return el
    for (const c of el.children ?? []) { const found = hidden(c); if (found !== undefined) return found }
    return undefined
  }
  const card = hidden((await band.drawn()) as unknown as Drawn)
  await band.unmount()
  return card === undefined ? undefined : shown({ ...card, props: {} }).join(' ')
}

/** The band as a person reads it: its words, a button as [label], a space between; on the terminal unless told. */
const bandText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = BAND.bodyColumns): Promise<string> => {
  const band = await $.ui.mount({ plugin: 'gemflow', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns } })
  const text = shown((await band.drawn()) as unknown as Drawn).join(' ')
  await band.unmount()
  return text
}

test('real event order: session start, a test run moves the stage, the board moves it again, the next prompt hears of it', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  await start($, on)
  expect(w.sent.map((r) => r.op), 'the board the inbox is built from is read at the start').toEqual(['status', 'refresh', 'board', 'attention'])
  expect(w.sent[0]).toMatchObject({ v: 1, root: ROOT })
  expect(w.registered).toEqual(['status', 'move', 'set', 'note', 'artifact', 'ask'])

  const tests = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', tool: 'Bash', callId: 'b1', exitCode: 0, isError: false, gitOperation: false, input: { command: 'npm test' } })
  expect(tests.context).toEqual(['[gemflow] stage #review · rev 3'])

  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(sans(seen)).toBeUndefined()

  const opened = await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(opened.text).toBe('已打开 Gemflow 看板。')
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await pane.press({ key: 'tab-flow' })
  await pane.press({ key: 'advance-review→done' })
  expect(w.sent.filter((r) => r.op === 'advance').at(-1)).toMatchObject({ to: 'done' })

  await $.prompt.submit({ text: 'and now?', wait: false, origin: COMPOSER })
  expect(sans(seen)).toEqual(['[gemflow] stage #done · rev 4'])
})

test('the session moved to another checkout: the next prompt reads the workflow there; a directory in no checkout, or deeper in the same one, keeps the root', async ($, on) => {
  const w = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  w.gitEntries.add(`${ROOT}/.git`)
  await start($, on)
  expect(w.sent[0]).toMatchObject({ root: ROOT })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })

  w.cwd = `${ROOT}/src/deep`
  w.sent.length = 0
  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(w.sent.filter((r) => r.op === 'status'), 'a directory inside the same checkout starts nothing').toEqual([])

  const other = '/work/app-feature'
  w.gitEntries.add(`${other}/.git`)
  w.cwd = `${other}/lib`
  await $.prompt.submit({ text: 'and here?', wait: false, origin: COMPOSER })
  expect(w.sent.find((r) => r.op === 'status'), 'the bridge starts again at the new checkout').toMatchObject({ root: other })
  expect(Object.values((w.store.get(`usage:${ROOT}`) ?? {}) as Record<string, Record<string, number>>)[0], 'what ran in the old checkout is counted under it').toMatchObject({ 'Bash(ls)': 1 })

  w.cwd = '/tmp/scratch'
  w.sent.length = 0
  await $.prompt.submit({ text: 'and now?', wait: false, origin: COMPOSER })
  expect(w.sent.filter((r) => r.op === 'status')).toEqual([])
  expect(w.sent.every((r) => r.root === other)).toBe(true)
})

test('a failing test run reports its exit code; a command no evidence reads costs no spawn, a branch switch does', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, ($, e) => (e.command === 'npm test'
    ? { isError: true, result: 'Exit code 1', text: 'Exit code 1\n1 failing' }
    : { result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  await start($, on)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', exitCode: 1, isError: true })
  const n = w.sent.length
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'ls -la' })
  expect(w.sent.length).toBe(n)
  // git's facts can name another work item after a switch, though the call carries no gitOperation.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: 'git switch main' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', tool: 'Bash', callId: 'b3', exitCode: 0, gitOperation: false, input: { command: 'git switch main' } })
})

test('a use fenced to another state refuses through the bridge; a broken bridge or an error answer lets the call through, the band says why, and the policy outlives both', async ($, on) => {
  const w = world(on)
  w.state = 'review'
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: `${ROOT}/a.ts` }, text: 'edited' }))
  const clock = await start($, on)
  const refused = await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(refused.deny ?? refused.text ?? '').toMatch(/Edit is edit, which is used only in #build; the workflow is in #review/)
  expect(w.sent.at(-1)).toMatchObject({ op: 'before', tool: 'Edit', input: { file_path: `${ROOT}/a.ts` } })
  w.bridge = false
  const passed = await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(passed.text).toBe('edited')
  let band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /暂时没应答/ }), 'one request that did not come back is a busy machine, not news').toBeUndefined()
  await band.unmount()
  expect((await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })).text).toBe('edited')
  band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /暂时没应答/ }), 'two in a row on a busy machine: still no news').toBeUndefined()
  await band.unmount()
  await clock.advance(120_000)
  expect((await $.tool.call({ tool: 'Edit', tool_use_id: 'e3b', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })).text).toBe('edited')
  band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /暂时没应答，不拦操作/ }), 'none back for two minutes: said, and that nothing is held up').toBeDefined()
  await band.unmount()

  // An answer with no shell (the CLI's request threw) says nothing about the workflow: the call goes through, the band
  // shows the error, and the last policy stays, so the next healthy answer refuses again.
  w.bridge = true
  w.error = 'journal.geml.lock is held by another process'
  const errored = await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(errored.text).toBe('edited')
  const failing = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await failing.find({ type: 'Text', text: /gemflow：journal.geml.lock is held by another process/ })).toBeDefined()
  await failing.unmount()
  w.error = null
  const again = await $.tool.call({ tool: 'Edit', tool_use_id: 'e4', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(again.deny ?? again.text ?? '').toMatch(/used only in #build/)
  expect(await bandText($)).toBe('» 我在做 feat/x · review [看板]')
})

test('the three model tools are served by the bridge', async ($, on) => {
  const w = world(on)
  await start($, on)
  const r = await $.tool.call({ tool: 'mcp__gemflow__status', tool_use_id: 'v1' })
  expect(r.result).toBe('[gemflow] work item feat/x · state #build')
  expect(w.sent.at(-1)).toMatchObject({ op: 'verb', name: 'status', callId: 'v1' })
  expect(w.sent.at(-1)?.args).toEqual({})
})

test('the band and /gemflow, on terminal and desktop', async ($, on) => {
  world(on)
  await start($, on)
  // The mark is a character on the terminal, a picture on a desktop; the rest reads the same.
  expect(await bandText($)).toBe('» 我在做 feat/x · build [看板]')
  expect(await bandText($, 'desktop')).toBe('[　　] 我在做 feat/x · build [　　　] [　　]')
  const desktop = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
  expect(await bandCard($), 'the pointer on the title shows the one thing whole, and where it runs').toBe('我在做 feat/x · build · 下一步「review」 · 自动 · 运行于 build-box · app · feat/x')
  const out = await $.command.run({ command: 'gemflow', args: '', origin: COMPOSER, presentation: PRESENTATION })
  expect(out.text).toContain('工作项 feat/x · 阶段 #build')
  expect(out.text).toContain('工具：edit test')
})

test('no Node: the band says so, tool calls pass untouched, and nothing is sent', async ($, on) => {
  const w = world(on)
  w.node = false
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ran' }))
  await start($, on)
  expect((await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })).text).toBe('ran')
  expect(w.sent).toEqual([])
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /找不到 node/ })).toBeDefined()
})

test('the board draws its header and its five tabs on every surface, opening on the work items', async ($, on) => {
  world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({ plugin: 'gemflow', surface, component: 'Pane', requestId: 'gemflow-board', props: PANE })
    for (const key of ['tab-sessions', 'tab-flow', 'tab-items', 'tab-journal', 'tab-tools', 'dialog-share', 'dialog-settings', 'dialog-upgrade', 'dialog-about']) {
      expect(await pane.find({ type: 'Button', key })).toBeDefined()
    }
    expect(await pane.find({ type: 'Button', key: 'tab-pending' }), 'what waits is on the work items tab, not a tab of its own').toBeUndefined()
    const texts = async (): Promise<string> => (await pane.findAll({ type: 'Text' })).map((x) => x.text).join(' | ')
    // The mark: a character on the terminal, a picture where the surface draws one.
    if (surface === 'terminal') expect(await pane.find({ type: 'Text', text: '»' }), await texts()).toBeDefined()
    else expect(await pane.find({ type: 'Svg' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Gemflow' })).toBeDefined()
    // Under it: the work item, its stage, its flow.
    for (const said of ['feat/x', 'build', '开发流程']) expect(await pane.find({ type: 'Text', text: said }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '暂无' }), `the work items first, nothing waiting: ${await texts()}`).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '当前 · build' }), await texts()).toBeDefined()
    await pane.press({ key: 'tab-flow' })
    // #build's transition waits on its guard: drawn, not offered, since a person's advance would be refused.
    expect(await pane.find({ type: 'Button', key: 'advance-build→review' })).toBeUndefined()
    // The picture is the parser's drawing where a surface draws pictures, boxes and lines on the terminal.
    if (surface === 'terminal') expect(await pane.find({ type: 'Text', text: /→ #review {2}自动 {2}要求 tests-pass and pr-open（未满足）/ }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '这里能用' }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Edit · Write' }), await texts()).toBeDefined()
    await pane.press({ key: 'tab-tools' })
    expect(await pane.find({ type: 'Button', key: 'open-tool-Bash(npm test)' }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'npm test' }) ?? await pane.find({ type: 'Button', text: 'npm test' }), 'the name, as words where pictures are drawn').toBeDefined()
    expect(await pane.find({ type: 'Text', text: '跑测试（首选）' }), await texts()).toBeDefined()
    await pane.press({ key: 'tab-journal' })
    expect(await pane.find({ type: 'Text', text: '暂无' }), 'the journal says it has nothing, in a word').toBeDefined()
    await pane.press({ key: 'tab-sessions' })
    expect(await pane.find({ type: 'Text', text: /还没有 prompt/ })).toBeDefined()
    await pane.press({ key: 'tab-items' })
    await pane.unmount()
  }
})

test("a subagent's tool call that moves the stage: the subagent reads it, and the main thread's next prompt still does", async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  await start($, on)
  const sub = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', agentId: 'agent-7' })
  expect(sub.context).toEqual(['[gemflow] stage #review · rev 3'])
  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(sans(seen)).toEqual(['[gemflow] stage #review · rev 3'])
  await $.prompt.submit({ text: 'and?', wait: false, origin: COMPOSER })
  expect(sans(seen)).toBeUndefined()
})

test("a subagent's move: the result carries the stage, and the main thread's next prompt still does", async ($, on) => {
  world(on)
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  await start($, on)
  const sub = await $.tool.call({ tool: 'mcp__gemflow__move', tool_use_id: 'v1', to: 'review', agentId: 'agent-2' })
  expect(sub.context).toEqual(['[gemflow] stage #review · rev 5'])
  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(sans(seen)).toEqual(['[gemflow] stage #review · rev 5'])
})

test('a registration the engine refuses: the start goes on, and the band says which', async ($, on) => {
  const w = world(on)
  w.refuse = { set: 'a tool named set is already registered' }
  await start($, on)
  expect(w.sent.map((r) => r.op)).toEqual(['status', 'refresh', 'board', 'attention'])
  expect(w.registered).toEqual(['status', 'move', 'note', 'artifact', 'ask'])
  expect(await bandText($, 'terminal', 400)).toMatch(/^» gemflow：没有注册上 set（[^（]*already registered[^）]*） \[看板\]$/)
})

test('a bundle that was never built: the band shows the error line and the build to run', async ($, on) => {
  const w = world(on)
  w.raw = { stdout: '', exitCode: 1, stderr: "node:internal/modules/cjs/loader:1479\n  throw err;\n\nError: Cannot find module '/p/dist/gemflow.mjs'\n" }
  await start($, on)
  expect(await bandText($)).toMatch(/^» gemflow：桥接没有构建 — 在 \S+ 运行 npm run build.* \[重试\]$/)
  const said = await $.command.run({ command: 'gemflow', args: '', origin: COMPOSER, presentation: PRESENTATION })
  expect(said.text).toMatch(/^gemflow：桥接没有构建 — 在 \S+ 运行 npm run build（Error: Cannot find module '\/p\/dist\/gemflow\.mjs'）$/)
})

test('a start that found no Node is tried again by a tool call or a prompt after ten seconds; one that answered is not tried again', async ($, on) => {
  const w = world(on)
  w.node = false
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const clock = await start($, on)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent).toEqual([])
  w.node = true
  await clock.advance(5_000)
  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(w.sent, 'not within ten seconds').toEqual([])
  await clock.advance(6_000)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'ls' })
  expect(w.sent.map((r) => r.op)).toEqual(['status'])
  await clock.settle()
  expect(w.sent.map((r) => r.op)).toEqual(['status', 'refresh', 'board'])
  expect(await bandText($)).toBe('» 我在做 feat/x · build [看板]')
  await clock.advance(120_000)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: 'ls' })
  expect(w.sent.filter((r) => r.op === 'status'), 'a start that answered is not tried again').toHaveLength(1)
})

test('the board in a project with no workflow, or with the bridge down, says why instead of waiting', async ($, on) => {
  const w = world(on)
  w.workflow = false
  await start($, on)
  const none = await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(none.text).toBe('看板打不开：这个项目还没有流程。用 /gemflow add 选一个内置流程。')
  expect(w.opened).toBe(0)
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '这个项目还没有流程。用 /gemflow add 选一个内置流程。' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /正在读取/ })).toBeUndefined()
  await pane.unmount()

  w.workflow = true
  expect((await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })).text).toBe('已打开 Gemflow 看板。')
  w.bridge = false
  const down = await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(down.text).toMatch(/^看板打不开：暂时没应答，不拦操作（[^）]*timed out after 15000 ms）$/, 'the person asked for the board: told at once')
  const stale = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await stale.press({ key: 'tab-flow' })
  expect(await stale.find({ type: 'Text', text: /^gemflow：暂时没应答/ })).toBeDefined()
  expect(await stale.find({ type: 'Text', text: /▶ build/ }), 'the last board stays under the reason').toBeDefined()
})

test('a shell the band or the board cannot draw: one line says so', async ($, on) => {
  const w = world(on)
  await start($, on)
  w.raw = { stdout: `${JSON.stringify({ v: 1, ok: true, shell: { status: { item: { kind: 'item', id: 'x' } }, policy: null, contextKey: null } })}\n`, exitCode: 0, stderr: '' }
  await $.command.run({ command: 'gemflow', args: '', origin: COMPOSER, presentation: PRESENTATION })
  expect(await bandText($)).toMatch(/^» gemflow：状态带画不出来（/)
  w.raw = { stdout: `${JSON.stringify({ v: 1, ok: true, shell: { status: null, policy: null, contextKey: null }, board: { states: null } })}\n`, exitCode: 0, stderr: '' }
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await pane.press({ key: 'tab-flow' })
  expect(await pane.find({ type: 'Text', text: /^gemflow：流程画不出来（/ }), 'the tab says it cannot be drawn, by its name').toBeDefined()
})

test('the board is read again after an answer that moved the stage, and after /gemflow use', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  const clock = await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const boards = () => w.sent.filter((r) => r.op === 'board').length
  expect(boards(), 'once at the start, once for the command').toBe(2)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  await clock.settle()
  expect(boards(), 'nothing moved').toBe(2)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'npm test' })
  await clock.settle()
  expect(boards()).toBe(3)
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await pane.press({ key: 'tab-flow' })
  expect(await pane.find({ type: 'Button', key: 'advance-review→done' })).toBeDefined()
  await pane.unmount()
  await $.command.run({ command: 'gemflow', args: 'use dev', origin: COMPOSER, presentation: PRESENTATION })
  await clock.settle()
  expect(boards()).toBe(4)
})

test('the to-do count a refresh read stays on the band while the stage is the one it was read in, until a later refresh or board answer replaces it', async ($, on) => {
  const w = world(on)
  w.todo = { item: 'feat/x', state: 'build', count: 7 }
  let failing = true
  on('tool.call', { tool: 'Bash' }, () => (failing
    ? { isError: true, result: 'Exit code 1', text: 'Exit code 1\n1 failing' }
    : { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  await start($, on)
  const drawn = async (text: string | RegExp) => {
    const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const found = await band.find({ type: 'Text', text })
    await band.unmount()
    return found
  }
  expect(await drawn('待办 7 项')).toBeDefined()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', callId: 'b1', exitCode: 1 })
  expect(await drawn('待办 7 项')).toBeDefined()
  w.todo = { item: 'feat/x', state: 'build', count: 1000 }
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(await drawn('待办 999+ 项')).toBeDefined()
  failing = false
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'npm test' })
  expect(w.state, 'a green run moved the stage on').toBe('review')
  expect(await drawn(/待办/), 'the count was read in #build').toBeUndefined()
  w.todo = null
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(await drawn(/待办/)).toBeUndefined()
})

test('a call that may act in another checkout goes to the bridge with the directory it starts in; one in the session\'s checkout is decided from the policy', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' }, text: 'written' }))
  await start($, on)
  const wt = `${ROOT}/.claude/worktrees/agent-1`
  w.gitEntries.add(`${wt}/.git`)
  const sent = async (call: Record<string, unknown>): Promise<unknown[][]> => {
    const n = w.sent.length
    await $.tool.call(call as never)
    return w.sent.slice(n).map((r) => [r.op, r.cwd])
  }
  // The main loop in the root: a command no evidence reads costs no spawn, and the policy has nothing to refuse.
  expect(await sent({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })).toEqual([])
  // A cd in the line: where the commands run is the bridge's to follow.
  expect(await sent({ tool: 'Bash', tool_use_id: 'b2', command: 'cd .claude/worktrees/agent-1 && ls' })).toEqual([['before', ROOT], ['after', ROOT]])
  // A file written in the worktree: the worktree's work item judges it, and it never becomes the session's last file.
  expect(await sent({ tool: 'Write', tool_use_id: 'w1', file_path: `${wt}/src/a.ts`, content: 'x' })).toEqual([['before', ROOT], ['after', ROOT]])
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', tool: 'Write', input: { file_path: `${wt}/src/a.ts` }, wrotePath: '.claude/worktrees/agent-1/src/a.ts' })
  // A subagent in its isolated worktree: every call, from there.
  w.cwd = wt
  expect(await sent({ tool: 'Bash', tool_use_id: 'b3', command: 'ls', agentId: 'agent-1' })).toEqual([['before', wt], ['after', wt]])
  // Below the root with no checkout of its own on the way up: the policy decides again.
  w.cwd = `${ROOT}/src`
  expect(await sent({ tool: 'Bash', tool_use_id: 'b4', command: 'ls' })).toEqual([])
  w.cwd = '/elsewhere/app'
  expect(await sent({ tool: 'Bash', tool_use_id: 'b5', command: 'ls' })).toEqual([['before', '/elsewhere/app'], ['after', '/elsewhere/app']])
})

test("another work item's stage text reaches the subagent working there, never the main loop, which keeps the session's", async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  await start($, on)
  const wt = `${ROOT}/.claude/worktrees/agent-1`
  w.gitEntries.add(`${wt}/.git`)
  w.cwd = wt
  w.routed = { item: 'worktree-agent-1', context: '[gemflow] stage #build · worktree-agent-1' }
  const sub = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', agentId: 'agent-1' })
  expect(sub.context).toEqual(['[gemflow] stage #build · worktree-agent-1'])
  w.cwd = ROOT
  const main = await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'cd .claude/worktrees/agent-1 && npm test' })
  expect(main.context).toBeUndefined()
  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(sans(seen), 'the next prompt carries the session\'s own stage: nothing marked the other item\'s as delivered').toEqual(['[gemflow] stage #build · rev 0'])
})

test('a branch switch hands the new work item over in the result; switching back says where the old one stood; a subagent asks for no handoff', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  await start($, on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  expect(sans(seen)).toEqual(['[gemflow] stage #build · rev 0'])
  w.item = 'feat/y'
  const there = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git switch -c feat/y' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', delivered: 'feat/x@0' })
  expect(there.context).toEqual(['[gemflow] now on feat/y · #build (new work item)\n[gemflow] stage #build · rev 0'])
  await $.prompt.submit({ text: 'and?', wait: false, origin: COMPOSER })
  expect(sans(seen), 'handed over with the result: the next prompt does not repeat it').toBeUndefined()
  w.item = 'feat/x'
  const back = await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git switch feat/x' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', delivered: 'feat/y@0' })
  expect(back.context).toEqual(['[gemflow] back on feat/x · #build · rev 0 · tests-pass ✗ · pr-open ✓\n[gemflow] stage #build · rev 0'])
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: 'git switch feat/y', agentId: 'agent-1' })
  expect(w.sent.at(-1)?.op).toBe('after')
  expect(w.sent.at(-1)?.delivered).toBeUndefined()
})

/** A time `minutes` before the mocked clock's now, as the journal writes it. */
const minutesAgo = (clock: ReturnType<typeof mock.clock>, minutes: number): string => new Date(clock.now() - minutes * 60_000).toISOString()

test('an approval edge that holds: the band offers the approval, the inbox lists it, a press moves the workflow through the bridge, and the desktop is told', async ($, on) => {
  const w = world(on)
  w.approval = true
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  const clock = await start($, on)
  expect(w.notified).toEqual([])
  // The tests pass: build → review on its own; review → done now waits for a person.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  await clock.settle()
  expect(w.state).toBe('review')
  expect(w.notified).toEqual(['需验收：feat/x\nreview'])
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Svg' })).toBeDefined()
  expect(await bandText($, 'desktop')).toBe('[　　] 验收 feat/x [　　　] [通过] [　　]')
  expect((await band.findAll({ type: 'Button' })).map((b) => b.key)).toEqual(['band-mark-open', 'title', 'approve-done', 'board'])
  await band.press({ key: 'approve-done' })
  expect(w.sent.filter((r) => r.op === 'advance').at(-1)).toMatchObject({ to: 'done' })
  expect(w.state).toBe('done')
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '暂无' }), 'approved: nothing waits').toBeDefined()
  await pane.unmount()
})

test('a model stuck on one fenced key: the inbox says so, "allow once" lets the next such call through with the fence told, then the fence holds again', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  const clock = await start($, on)
  const reason = '"npx wrangler deploy" is deploy, which is used only in #release; the workflow is in #build; switching the work item is always allowed: x'
  w.timeline = [
    { kind: 'snapshot', rev: 0, at: minutesAgo(clock, 20), state: 'build', cause: 'enter' },
    { kind: 'refused', n: 1, rev: 0, at: minutesAgo(clock, 3), tool: 'Bash', reason, key: 'Bash(wrangler deploy)' },
    { kind: 'refused', n: 2, rev: 0, at: minutesAgo(clock, 2), tool: 'Bash', reason, key: 'Bash(wrangler deploy)' },
    { kind: 'refused', n: 3, rev: 0, at: minutesAgo(clock, 1), tool: 'Bash', reason, key: 'Bash(wrangler deploy)' },
  ]
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const refused = await $.tool.call({ tool: 'Bash', tool_use_id: 'd1', command: 'npx wrangler deploy' })
  expect(refused.deny ?? refused.text ?? '').toMatch(/is deploy, which is used only in #release/)
  expect(w.sent.at(-1)).toMatchObject({ op: 'before', tool: 'Bash' })
  expect((w.sent.at(-1) as Req)['waived']).toBeUndefined()
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '被拦' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Bash(wrangler deploy)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '3 分钟内 3 次' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'journal-Bash(wrangler deploy)' }), 'and where the refusals are recorded').toBeDefined()
  expect(await bandText($), 'the band leads with it').toBe('» 被拦 Bash(wrangler deploy) [放行一次] [看记录] [看板]')
  await pane.press({ key: 'pass-Bash(wrangler deploy)' })
  await pane.unmount()
  const passed = await $.tool.call({ tool: 'Bash', tool_use_id: 'd2', command: 'npx wrangler deploy' })
  expect(passed.text).toBe('ok')
  expect(w.sent.filter((r) => r.op === 'before').at(-1)).toMatchObject({ callId: 'd2', waived: ['Bash(wrangler deploy)'] })
  const again = await $.tool.call({ tool: 'Bash', tool_use_id: 'd3', command: 'npx wrangler deploy' })
  expect(again.deny ?? again.text ?? '', 'the waiver was spent').toMatch(/used only in #release/)
})

test('a tool no row takes goes through: nobody is asked, nothing waits, nothing is learned', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'WebFetch' }, () => ({ result: { bytes: 1 }, text: 'fetched' }))
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => { asked++; return { result: {}, text: '' } })
  await start($, on)
  const fetched = await $.tool.call({ tool: 'WebFetch', tool_use_id: 'f1', url: 'https://x' })
  expect(fetched.text).toBe('fetched')
  expect(asked).toBe(0)
  expect(w.sent.filter((r) => r.op === 'learn')).toEqual([])
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map((b) => b.key)).not.toContain('pending')
  await band.unmount()
})

test('the band offers the board whenever there is a workflow, nothing waiting or not; a press opens it', async ($, on) => {
  const w = world(on)
  await start($, on)
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map((b) => b.key), 'the mark and the title are presses too: the board, the work items').toEqual(['band-mark-open', 'title', 'board'])
  const opened = w.opened
  await band.press({ key: 'board' })
  expect(w.opened).toBe(opened + 1)
  await band.unmount()
  // The mark opens it too, on every surface.
  for (const surface of ['terminal', 'desktop'] as const) {
    const again = await $.ui.mount({ plugin: 'gemflow', surface, component: 'AbovePrompt', props: BAND })
    const before = w.opened
    await again.press({ key: 'band-mark-open' })
    expect(w.opened, surface).toBe(before + 1)
    await again.unmount()
  }
})

test('a tab whose rows cannot be drawn says why in its place; the tab bar still switches, to the other tabs and back', async ($, on) => {
  const w = world(on)
  w.items = [{ id: 'feat/broken', state: 'build', rev: 1, at: '2026-10-12T08:00:00Z', paused: false, depends: 'not a list' as never }]
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'gemflow', surface, component: 'Pane', requestId: 'gemflow-board', props: PANE })
    const words = async (): Promise<string> => shown((await pane.drawn()) as unknown as Drawn).join(' ')
    expect(await words(), surface).toMatch(/gemflow：工作项画不出来（/)
    await pane.press({ key: 'tab-tools' })
    expect(await words(), `${surface}: the other tabs draw`).toMatch(/跑测试/)
    expect(await words()).not.toMatch(/画不出来/)
    await pane.press({ key: 'tab-items' })
    expect(await words(), `${surface}: and back`).toMatch(/gemflow：工作项画不出来（/)
    await pane.unmount()
  }
})

test('the probe: where prompt.compose reaches the engine (its bare-named sections are there), the first prompt carries no standing instructions', async ($, on) => {
  world(on)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => { contexts.push(e.context); return { text: e.text } })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'session' as const }, { id: 'acme:policy', text: '…', scope: 'session' as const }] }))
  await start($, on)
  await $.prompt.submit({ text: '开始', wait: false, origin: COMPOSER })
  expect((contexts.at(-1) ?? []).filter((x) => x.startsWith('Gemflow: '))).toEqual([])
})

test('the probe: a plugin above keeps prompt.compose (only its own sections come back), so the first prompt carries the standing instructions', async ($, on) => {
  world(on)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => { contexts.push(e.context); return { text: e.text } })
  on('prompt.compose', () => ({ sections: [{ id: 'cc-plugin-sec-default:policy', text: '…', scope: 'session' as const }] }))
  await start($, on)
  await $.prompt.submit({ text: '开始', wait: false, origin: COMPOSER })
  expect((contexts.at(-1) ?? []).filter((x) => x.startsWith('Gemflow: ')).length).toBe(2)
})

test("a conversation's first prompt carries the standing instructions (the other sessions, the ask tool), once; again after a /clear and after a compaction; never once the system prompt carried them", async ($, on) => {
  world(on)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => { contexts.push(e.context); return { text: e.text } })
  // The engine's own ends, compactions and compositions, beneath the plugin.
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('prompt.compose', () => ({ sections: [] }))
  await start($, on)
  const standing = (): string[] => (contexts.at(-1) ?? []).filter((s) => s.startsWith('Gemflow: ')).map((s) => s.slice(0, 32))
  await $.prompt.submit({ text: '开始', wait: false, origin: COMPOSER })
  expect(standing()).toEqual(['Gemflow: this project is worked ', 'Gemflow: when a turn ends asking'])
  await $.prompt.submit({ text: '继续', wait: false, origin: COMPOSER })
  expect(standing(), 'told once').toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.prompt.submit({ text: '重新开始', wait: false, origin: COMPOSER })
  expect(standing().length, 'after a /clear: again').toBe(2)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: '开始', toolUses: [] }] })
  await $.prompt.submit({ text: '压缩后', wait: false, origin: COMPOSER })
  expect(standing().length, 'after a compaction: again').toBe(2)
  const composed = await $.prompt.compose({ model: 'claude', promptModel: 'claude', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections.map((x) => x.id).filter((id) => id.startsWith('gemflow:'))).toEqual(['gemflow:sessions', 'gemflow:ask'])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.prompt.submit({ text: '再来', wait: false, origin: COMPOSER })
  expect(standing(), 'the system prompt carries them: the prompt does not').toEqual([])
})

test('the version that runs is the one the board says; one synced and not loaded is a reload due, with both versions', async ($, on) => {
  const w = world(on)
  w.manifest = '0.2.32'
  w.synced = '0.2.35'
  await start($, on)
  expect(await bandText($)).toMatch(/待重载：0\.2\.35（运行 0\.2\.32）/)
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  const words = shown((await pane.drawn()) as unknown as Drawn).join(' ')
  expect(words, 'the header: the version running, then the one synced').toMatch(/0\.2\.32 已同步 0\.2\.35/)
  await pane.unmount()
  w.synced = '0.2.32'
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(await bandText($), 'the same version: nothing to reload').not.toMatch(/待重载/)
})

test('a reload with the board still up opens it again, so this module draws it and its presses work; a dialog left up is closed', async ($, on) => {
  const w = world(on)
  const pane = (id: string) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })
  let up = [pane('gemflow-board'), pane('gemflow-dialog')]
  on('ui.panes', () => ({ value: up }))
  await start($, on)
  expect(w.opened, 'the board, opened anew').toBe(1)
  expect(w.closed).toEqual(['gemflow-dialog'])
  up = []
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.opened, 'nothing up: nothing opened').toBe(1)
})

test('a session started (or reloaded) in a subdirectory of the checkout works from the checkout\'s top', async ($, on) => {
  const w = world(on)
  w.gitEntries.add(`${ROOT}/.git`)
  const clock = mock.clock(on)
  await $.session.start({ cwd: `${ROOT}/integrations/gemflow`, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect([...new Set(w.sent.map((r) => r.root))], 'every request from the top, where .geml/ is').toEqual([ROOT])
})

test('the board opens on its press: a board not read yet is read behind the open pane, which says so meanwhile', async ($, on) => {
  const w = world(on)
  w.boardless = true
  const clock = await start($, on)
  w.boardless = false
  let release = (): void => undefined
  w.holdBoard = new Promise<void>((r) => { release = r })
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const before = w.opened
  const boards = w.sent.filter((r) => r.op === 'board').length
  const pressing = band.press({ key: 'board' })
  await clock.advance(1)
  expect(w.opened, 'open at once, the board still being read').toBe(before + 1)
  expect(w.sent.filter((r) => r.op === 'board').length, 'its read not answered yet').toBe(boards)
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(shown((await pane.drawn()) as unknown as Drawn).join(' ')).toMatch(/正在读取看板…/)
  release()
  await pressing
  await clock.advance(1)
  expect(w.sent.filter((r) => r.op === 'board').length).toBe(boards + 1)
  expect(shown((await pane.drawn()) as unknown as Drawn).join(' ')).not.toMatch(/正在读取看板…/)
  await pane.unmount()
  await band.unmount()
})

test('pause and resume: no button on the board header; /gemflow pause holds it, the band says so and offers only resume', async ($, on) => {
  const w = world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Button', key: 'pause' }), 'no pause on the header').toBeUndefined()
  expect((await $.command.run({ command: 'gemflow', args: 'pause', origin: COMPOSER, presentation: PRESENTATION })).text).toMatch(/^已暂停。\n/)
  expect(w.sent.filter((r) => r.op === 'pause')).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: 'build · 已暂停' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'resume' }), 'no resume on the header either: the band has it').toBeUndefined()
  expect(await bandText($)).toBe('» 已暂停 feat/x · 阶段不变，照常记录 [继续] [看板]')
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map((b) => b.key)).toEqual(['band-mark-open', 'title', 'resume', 'board'])
  await band.press({ key: 'resume' })
  expect(w.sent.filter((r) => r.op === 'resume')).toHaveLength(1)
  expect(await band.find({ type: 'Text', text: /已暂停/ })).toBeUndefined()
  await band.unmount()
  await pane.unmount()
  expect((await $.command.run({ command: 'gemflow', args: 'pause', origin: COMPOSER, presentation: PRESENTATION })).text).toMatch(/^已暂停。\n/)
  expect((await $.command.run({ command: 'gemflow', args: 'resume', origin: COMPOSER, presentation: PRESENTATION })).text).toMatch(/^已继续。\n/)
})

test('the settings dialog: a toggle is kept in the store and read back at the next start; the language changes the words', async ($, on) => {
  const w = world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const board = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await board.press({ key: 'dialog-settings' })
  expect(w.opened).toBe(2)
  await board.unmount()
  const desk = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-dialog', props: { ...PANE, title: '设置' } })
  expect(await desk.find({ type: 'Button', key: 'set-notify.stage' }), 'the desktop app lets no plugin notify: no switch that does nothing').toBeUndefined()
  expect(await desk.find({ type: 'Button', key: 'set-judge.enabled' })).toBeDefined()
  await desk.unmount()
  const dialog = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-dialog', props: { ...PANE, title: '设置' } })
  expect(await dialog.find({ type: 'Button', key: 'set-notify.stage' })).toMatchObject({ text: '[ ] 阶段变更时' })
  await dialog.press({ key: 'set-notify.stage' })
  expect(w.store.get('settings')).toMatchObject({ notify: { inbox: true, refusal: true, stage: true } })
  expect(await dialog.find({ type: 'Button', key: 'set-notify.stage' })).toMatchObject({ text: '[x] 阶段变更时' })
  expect(await dialog.find({ type: 'Text', text: /流程在「流程」页换和调整/ }), 'flows are switched on the flow tab').toBeDefined()
  await dialog.press({ key: 'lang-en' })
  expect(await dialog.find({ type: 'Text', text: 'Desktop notifications' })).toBeDefined()
  expect(await dialog.find({ type: 'Button', key: 'set-notify.stage' })).toMatchObject({ text: '[x] When the stage changes' })
  await dialog.unmount()
  expect(await bandText($)).toBe('» Working on feat/x · build [Board]')
  // The flow tab switches flows: the installed ones, from the bridge, and the bundled ones to add.
  const flows = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await flows.press({ key: 'tab-flow' })
  await flows.press({ key: 'flow-switch' })
  expect(await flows.find({ type: 'Button', key: 'use-dev' }), 'the installed workflows, from the bridge').toBeDefined()
  expect(await flows.find({ type: 'Button', key: 'add-coding' })).toBeDefined()
  await flows.unmount()
})

test('the session tab lists each prompt by day, newest first, with what its turn did, and exports them through the bridge where the person says', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  const asked: { question: string; header?: string; options: string[] }[] = []
  let answer = '~/notes'
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e.questions as { question: string; header?: string; options: { label: string }[] }[])[0]!
    asked.push({ question: q.question, header: q.header, options: q.options.map((o) => o.label) })
    return { result: { questions: e.questions, answers: { [q.question]: answer } }, text: answer }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await start($, on)
  await $.prompt.submit({ text: '把测试补上，然后开 PR。', wait: false, origin: COMPOSER })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'npm test' })
  await $.prompt.submit({ text: '顺手部署一下。', wait: false, origin: COMPOSER })
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '今天' })).toBeDefined()
  const turns = (await pane.findAll({ type: 'Button' })).filter((b) => String(b.key).startsWith('open-prompt-')).map((b) => b.text)
  expect(turns, 'newest first').toEqual(['顺手部署一下。', '把测试补上，然后开 PR。'])
  expect(await pane.find({ type: 'Text', text: /2 次工具调用 · tests-pass ✓ · 进 #review/ }), 'what the first turn did').toBeDefined()
  expect(await pane.find({ type: 'Text', text: /进行中…/ }), 'the last is still going').toBeDefined()
  // The export sits on this session's heading: a press asks where to, and the record goes there as GEML; no format to pick.
  // The places offered are the folders there are: Downloads and the desktop where the home has them, else the home itself.
  expect((await pane.findAll({ type: 'Button' })).filter((b) => /^export-own-/.test(String(b.key))), 'no format buttons').toEqual([])
  await pane.press({ key: 'export-own' })
  expect(asked.at(-1)?.options, 'a home with neither folder').toEqual(['本项目 .geml/exports/', '主目录 ~'])
  w.files.set(`${HOME}/Downloads`, '')
  await pane.press({ key: 'export-own' })
  expect(asked.at(-1)?.options).toEqual(['下载 ~/Downloads', '本项目 .geml/exports/'])
  w.files.set(`${HOME}/Desktop`, '')
  await pane.press({ key: 'export-own' })
  expect(asked.at(-1)).toEqual({ question: '把本会话导出到哪？', header: '导出', options: ['下载 ~/Downloads', '桌面 ~/Desktop', '本项目 .geml/exports/'] })
  const exported = w.sent.filter((r) => r.op === 'export').at(-1) as Req
  expect(exported, 'a place typed under Other').toMatchObject({ kind: 'text', format: 'geml', name: 'session-sess-123', to: '~/notes' })
  expect(String(exported['text'])).toMatch(/^=== meta\n/)
  expect(String(exported['text'])).toContain('把测试补上，然后开 PR。')
  expect(w.toasts.at(-1)).toBe('已导出 .geml/exports/session-sess-123.geml')
  answer = '下载 ~/Downloads'
  await pane.press({ key: 'export-own' })
  expect(w.sent.filter((r) => r.op === 'export').at(-1), 'an option is its folder').toMatchObject({ to: '~/Downloads' })
  answer = '本项目 .geml/exports/'
  await pane.press({ key: 'export-own' })
  expect((w.sent.filter((r) => r.op === 'export').at(-1) as Req)['to'], "the project's exports: no place sent").toBeUndefined()
  await pane.unmount()
})

test('the session tab: a prompt learns its row once the host stored it, a press scrolls the conversation to it, and 从这里拆分 / 删除 hand the turn to the model with the split-session skill after a yes', async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  const prompted: string[] = []
  const asked: string[] = []
  on('prompt.submit', ($, e) => { if (e.origin.kind === 'plugin') prompted.push(e.text); return { text: e.text } })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e.questions as { question: string; options: { label: string }[] }[])[0]!
    asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: q.options[0]!.label } }, text: q.options[0]!.label }
  })
  await start($, on)
  // The engine stores each prompt as a row of the transcript once it entered: the hook learns the row's id there.
  const stored: string[] = []
  for (const [text, uuid] of [['把测试补上，然后开 PR。', 'row-aaaa'], ['顺手部署一下。', 'row-bbbb']] as const) {
    await $.prompt.submit({ text, wait: false, origin: COMPOSER })
    await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text }] }, door: 'prompt', origin: COMPOSER, uuid })
    stored.push(uuid)
  }
  expect(session.appended().filter((r) => r.door === 'prompt').map((r) => r.uuid), 'the rows the host stored').toEqual(stored)
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  const picks = (await pane.findAll({ type: 'Button' })).filter((b) => String(b.key).startsWith('open-prompt-'))
  expect(picks).toHaveLength(2)
  // The oldest turn, drawn last: its icons stand at its right, named.
  const id = String(picks[1]!.key).slice('open-prompt-'.length)
  expect((await pane.find({ type: 'Button', key: `locate-${id}` }))?.text, 'the icons stand on the row').toBe('跳转')
  await pane.press({ key: `locate-${id}` })
  // A transcript row is the surface's to move: the test host has none, so the module reports why nothing moved.
  expect(w.toasts.at(-1)).toBe('对话没有滚到那一处：no implementation for ui.scroll')
  await pane.press({ key: `split-${id}` })
  expect(asked.at(-1)).toBe('把这一轮及之后的轮次拆到新会话？最后一轮留下，会先备份；重启应用后生效。')
  expect(prompted).toHaveLength(1)
  expect(prompted[0]).toContain('/skills/split-session/split-session.mjs')
  expect(prompted[0]).toContain('「把测试补上，然后开 PR。」')
  expect(prompted[0]).toContain('最后一轮除外')
  await pane.press({ key: `remove-${id}` })
  expect(asked.at(-1), '删除 deletes: it says so').toBe('删除这一轮？会先备份，可恢复；重启应用后才看不到。')
  expect(prompted[1]).toContain('用 remove 只删掉这一轮（不建新会话）')
  expect(w.toasts.filter((x) => x === '已交给模型，结果看对话')).toHaveLength(2)
  await pane.press({ key: 'export-own' })
  expect(asked.at(-1), 'the export asks where to').toBe('把本会话导出到哪？')
  const exported = w.sent.filter((r) => r.op === 'export').at(-1) as Req
  const index = /^=== data \{#session format=json\}\n([\s\S]*?)\n===$/m.exec(String(exported['text']))
  expect((JSON.parse(index![1]!) as { prompts: { uuid?: string }[] }).prompts.map((p) => p.uuid), 'the export carries the rows\' ids').toEqual(stored)
  await pane.unmount()
})

test('a finished call does not wait on a slow bridge: its result goes on after two seconds, and the evidence is still recorded', async ($, on) => {
  const w = world(on)
  let release = (): void => undefined
  w.hold = new Promise<void>((r) => { release = r })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'all green', stderr: '', interrupted: false }, text: 'all green' }))
  const clock = await start($, on)
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'slow-1', command: 'npm test' })
  await clock.advance(2_000)
  const done = await call
  expect(done.text, 'the result as it was, nothing waited for').toBe('all green')
  expect(w.sent.some((r) => r.op === 'after' && r.callId === 'slow-1'), 'not answered yet').toBe(false)
  release()
  await clock.advance(1)
  expect(w.sent.some((r) => r.op === 'after' && r.callId === 'slow-1'), 'the evidence still went in').toBe(true)
})

test('a merged work item still checked out is a card on the items tab: 收尾 asks first, then hands the model the steps with git\'s own checks; 先留着 puts it away', async ($, on) => {
  const w = world(on)
  w.items = [{ id: 'feat/runtime', state: 'build', rev: 2, at: '2026-10-09T09:00:00Z', paused: false, end: 'merged', worktree: '../geml-agent-runtime', commits: 13, pr: { number: 32, state: 'merged' } }]
  const prompted: string[] = []
  const asked: string[] = []
  let reply = '取消'
  on('prompt.submit', ($, e) => { if (e.origin.kind === 'plugin') prompted.push(e.text); return { text: e.text } })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e.questions as { question: string }[])[0]!
    asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: reply } }, text: reply }
  })
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board items', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'feat/runtime 已合并' })).toBeDefined()
  await pane.press({ key: 'close-go-feat/runtime' })
  expect(asked.at(-1)).toBe('删掉 worktree ../geml-agent-runtime 和分支 feat/runtime？提交都在 main 里才删，远端分支不动。')
  expect(prompted, 'cancelled: nothing handed over').toEqual([])
  reply = '收尾'
  await pane.press({ key: 'close-go-feat/runtime' })
  expect(prompted).toHaveLength(1)
  expect(prompted[0]).toContain('git branch --merged')
  expect(prompted[0]).toContain('git worktree remove ../geml-agent-runtime（不加 --force')
  expect(prompted[0]).toContain('git branch -d feat/runtime（用 -d，不用 -D）')
  await pane.press({ key: 'close-keep-feat/runtime' })
  expect(await pane.find({ type: 'Text', text: 'feat/runtime 已合并' }), 'left as it is: the card is gone').toBeUndefined()
  await pane.unmount()
})

test('share: where it stands is shown to select on the desktop (no clipboard there) and copied on the terminal; the journal goes as a file, its place a link on the board', async ($, on) => {
  const w = world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const board = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await board.press({ key: 'dialog-share' })
  await board.unmount()
  const dialog = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-dialog', props: { ...PANE, title: '分享' } })
  expect(await dialog.find({ type: 'Text', text: 'feat/x · 开发流程 · build' }), 'the preview').toBeDefined()
  expect(await dialog.find({ type: 'Button', key: 'how-copy' })).toMatchObject({ text: '显示文字' })
  await dialog.press({ key: 'share-go' })
  expect(w.copied, 'the desktop gives a plugin no clipboard: nothing pretends to copy').toEqual([])
  expect(await dialog.find({ type: 'Text', text: '选中后复制' }), 'the text is shown to select instead').toBeDefined()
  const term = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-dialog', props: { ...PANE, title: '分享' } })
  await term.press({ key: 'share-go' })
  await term.unmount()
  expect(w.copied, 'the terminal copies: nothing waits and nothing was made yet, the one line').toEqual(['feat/x · 开发流程 · build'])
  await dialog.press({ key: 'what-journal' })
  await dialog.press({ key: 'how-file' })
  await dialog.press({ key: 'share-go' })
  expect(w.sent.filter((r) => r.op === 'export').at(-1)).toMatchObject({ kind: 'journal', format: 'geml', strip: true })
  await dialog.unmount()
})

test('a reply that ends asking: the band puts the question first with its answers on every surface, a press answers as the person, and the board opens on 此刻', async ($, on) => {
  world(on)
  const said: string[] = []
  on('prompt.submit', ($, e) => { said.push(e.text); return { text: e.text } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await start($, on)
  await $.prompt.submit({ text: '把版本改成 1.2.3', wait: false, origin: COMPOSER })
  const registered = await $.tool.call({ tool: 'mcp__gemflow__ask', tool_use_id: 'q1', question: '要强推覆盖 origin 上的 feat/x。推吗？', options: ['暂不', '推'], recommended: '推' })
  expect(String(registered.text ?? registered.result)).toMatch(/^Registered/)
  await $.turn.complete({ answer: '改好了，提交在本地。\n\n要强推覆盖 origin 上的 feat/x。推吗？', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'gemflow', surface, component: 'AbovePrompt', props: BAND })
    expect(shown((await band.drawn()) as unknown as Drawn).join(' '), surface).toMatch(/待决定：要强推覆盖 origin 上的 feat\/x。推吗？/)
    expect(await band.find({ type: 'Button', key: 'attention-0-推' }), surface).toBeDefined()
    await band.unmount()
  }
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'attention-0-推' })
  await band.unmount()
  expect(said.at(-1), 'the press said it as the person, with what it answers').toBe('要强推覆盖 origin 上的 feat/x。推吗？：推')
  // Answered: the question no longer leads.
  expect(await bandText($)).not.toMatch(/推吗/)
  await $.tool.call({ tool: 'mcp__gemflow__ask', tool_use_id: 'q2', question: '新分支要不要开 PR？', options: ['要', '不要'] })
  await $.tool.call({ tool: 'mcp__gemflow__ask', tool_use_id: 'q3', question: '#32 关不关？', options: ['关', '不关'] })
  await $.turn.complete({ answer: '还要你定两件事：\n1. 新分支要不要开 PR？\n2. #32 关不关？', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '此刻' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '新分支要不要开 PR？' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '#32 关不关？' })).toBeDefined()
  await pane.unmount()
  // Two to settle: the band asks the first with its own answers, then the second; the last answer says both.
  const two = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(shown((await two.drawn()) as unknown as Drawn).join(' ')).toMatch(/定 1\/2：新分支要不要开 PR/)
  await two.press({ key: 'attention-0-0-要' })
  expect(said.at(-1), 'one answer of two: kept, not said yet').toBe('要强推覆盖 origin 上的 feat/x。推吗？：推')
  expect(shown((await two.drawn()) as unknown as Drawn).join(' ')).toMatch(/定 2\/2：#32 关不关/)
  await two.press({ key: 'attention-1-0-关' })
  await two.unmount()
  expect(said.at(-1), 'the last answer says them all').toBe('新分支要不要开 PR？：要\n#32 关不关？：关')
  // A question the model did not register: a grey hint, nothing to press.
  await $.turn.complete({ answer: '做完了。\n\n要不要顺手把文档也改了？', durationMs: 5, isAborted: false, turnId: 't3', reason: 'answer' })
  const hint = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(shown((await hint.drawn()) as unknown as Drawn).join(' ')).toMatch(/可能待决定：要不要顺手把文档也改了？/)
  expect((await hint.findAll({ type: 'Button' })).map((b) => b.key).filter((k) => k.startsWith('attention-')), 'no answers to press').toEqual([])
  await hint.unmount()
})

test('a question too long for one row is drawn whole, however many rows it takes, its answers on a row of their own; the mark still opens the board', async ($, on) => {
  const w = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await start($, on)
  const question = '要不要把状态带的问题识别改成只认问句，陈述句不再挂成待决定，也不会出现同意和暂不两个按钮，看板上的此刻卡片同样只列问句？'
  await $.tool.call({ tool: 'mcp__gemflow__ask', tool_use_id: 'q1', question, options: ['要', '不要'] })
  await $.turn.complete({ answer: `改好了。\n\n${question}`, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'gemflow', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 60 } })
    const drawn = shown((await band.drawn()) as unknown as Drawn).join('')
    expect(drawn.replace(/\s/g, ''), surface).toContain(`待决定：${question}`.replace(/\s/g, ''))
    expect(await band.find({ type: 'Button', key: 'attention-0-要' }), surface).toBeDefined()
    const opened = w.opened
    await band.press({ key: 'band-mark-open' })
    expect(w.opened, surface).toBe(opened + 1)
    await band.unmount()
  }
})

test('where the session runs: the board says the machine, the checkout and the branch; with Remote Control in play it says so, and the band names the machine', async ($, on) => {
  world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.detach', ($, e) => ({ clientId: e.clientId }))
  const clock = await start($, on)
  await clock.advance(1)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const head = async (): Promise<string> => {
    const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
    const line = shown((await pane.drawn()) as unknown as Drawn).find((x) => x.startsWith('运行于')) ?? ''
    await pane.unmount()
    return line
  }
  expect(await head()).toBe('运行于 build-box · app · feat/x')
  expect(await bandText($), 'at the machine: the band does not name it').not.toMatch(/@build-box/)
  await $.session.attach({ surface: 'mobile', clientId: 'phone-1' })
  expect(await head(), 'a phone attached').toBe('运行于 build-box · app · feat/x · 远程控制')
  expect(await bandText($)).toMatch(/@build-box/)
  await $.session.detach({ surface: 'mobile', clientId: 'phone-1', reason: 'detach' })
  expect(await head(), 'the phone left').toBe('运行于 build-box · app · feat/x')
  await $.prompt.submit({ text: '推', wait: false, origin: { kind: 'bridge' } })
  expect(await head(), 'a prompt over Remote Control').toBe('运行于 build-box · app · feat/x · 远程控制')
  await $.prompt.submit({ text: '同意', wait: false, origin: COMPOSER })
  expect(await head(), 'the next one typed at the machine').toBe('运行于 build-box · app · feat/x')
})

test('a step pressed on the board says what became of it: being done once it goes in, not offered again until that turn ends; 重载插件 runs the command itself', async ($, on) => {
  const w = world(on)
  w.prs = [{ number: 32, branch: 'feat/y', green: true, failing: [] }]
  const said: string[] = []
  const ran: string[] = []
  on('prompt.submit', ($, e) => { said.push(e.text); return { text: e.text } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', ($, e) => { ran.push(e.command); return {} })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  const asked: string[] = []
  let reply = '取消'
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e.questions as { question: string }[])[0]!
    asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: reply } }, text: reply }
  })
  const clock = await start($, on)
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b9', command: 'cp -r dist ~/.claude/local-marketplaces/geml-dev/gemflow/' })
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const board = () => $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  let pane = await board()
  expect(await pane.find({ type: 'Button', key: 'attention-0-合并' })).toBeDefined()
  // A merge cannot be taken back: the press asks first, and 取消 says nothing.
  await pane.press({ key: 'attention-0-合并' })
  expect(asked.at(-1)).toBe('合并 #32？此操作不可撤销。')
  expect(said.includes('合并 #32'), 'cancelled: nothing said').toBe(false)
  reply = '合并'
  await pane.press({ key: 'attention-0-合并' })
  await pane.unmount()
  expect(said.at(-1), 'the press said it as the person').toBe('合并 #32')
  pane = await board()
  expect(await pane.find({ type: 'Text', text: '进行中 合并 #32' }), 'the card says what became of the press').toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'attention-0-合并' }), 'and does not offer it again meanwhile').toBeUndefined()
  await pane.unmount()
  await $.turn.complete({ answer: '合并好了。', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  pane = await board()
  expect(await pane.find({ type: 'Text', text: '进行中 合并 #32' }), 'its turn ended').toBeUndefined()
  await pane.press({ key: 'attention-0-重载插件' })
  await pane.unmount()
  expect(ran, '重载插件 runs /reload-plugins, nothing to copy and paste').toEqual(['reload-plugins'])
})

test('a reload the engine cannot run here (a remote connection) is not offered again: the band names it, with no button', async ($, on) => {
  const w = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', () => ({ text: "/reload-plugins isn't available over a remote connection in this session." }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  const clock = await start($, on)
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b9', command: 'cp -r dist ~/.claude/local-marketplaces/geml-dev/gemflow/' })
  await $.turn.complete({ answer: '同步好了。', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const band = () => $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  let b = await band()
  expect(await b.find({ type: 'Button', key: 'attention-0-重载插件' })).toBeDefined()
  await b.press({ key: 'attention-0-重载插件' })
  await b.unmount()
  expect(w.toasts.at(-1)).toBe('要在本机重载插件')
  b = await band()
  expect(await b.find({ type: 'Button', key: 'attention-0-重载插件' }), 'no button that cannot work').toBeUndefined()
  expect(shown((await b.drawn()) as unknown as Drawn).join(' ')).toMatch(/需在本机重载/)
  await b.unmount()
})

test('a tool call redraws neither the band nor the board: with both drawn, the reads it sets off are only its own, so a press is not lost to a redraw while the model works', async ($, on) => {
  world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  let reads = 0
  on('state.get', ($, e, next) => { reads++; return next(e) })
  const clock = await start($, on)
  await clock.advance(1)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const calls = async (from: number): Promise<number> => {
    await clock.advance(1)
    reads = 0
    for (let i = from; i < from + 5; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `c${i}`, command: 'ls' })
    await clock.advance(1)
    return reads
  }
  const alone = await calls(0)
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  const drawn = await calls(5)
  await band.unmount()
  await pane.unmount()
  expect(drawn, 'the same reads as with nothing drawn: no redraw').toBe(alone)
})

test('the session tab keeps its history past a restart: the prompts go into the store under the session, and a load with none held reads them back', async ($, on) => {
  const w = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = await start($, on)
  await $.prompt.submit({ text: '先把会话的历史存住。', wait: false, origin: COMPOSER })
  await $.turn.complete({ answer: '存好了。', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  const kept = w.store.get('prompts:sess-1234567890') as { text: string }[] | undefined
  expect(kept?.map((p) => p.text), 'kept under the session').toEqual(['先把会话的历史存住。'])
  expect(w.store.get('prompts:sessions')).toEqual(['sess-1234567890'])
})

test('a session resumed after the app restarted shows the prompts the store kept for it, on the session tab drawn as the prototype has it', async ($, on) => {
  const w = world(on)
  w.store.set('prompts:sess-1234567890', [
    { id: 'p1-a', at: '2026-10-16T09:00:00.000Z', text: '三天前的那句', uuid: 'row-a', tools: 3, refusals: 0, entered: [], signals: [], did: '做完了。' },
    { id: 'p2-b', at: '2026-10-19T09:00:00.000Z', text: '今天的这句', uuid: 'row-b', tools: 1, refusals: 0, entered: [], signals: [] },
  ])
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Button', key: 'open-prompt-p1-a' }), 'the older prompt is back').toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'open-prompt-p2-b' })).toBeDefined()
  // The icons stand at each row's right; on the desktop, which cannot scroll the conversation, there is no 跳转.
  expect(await pane.find({ type: 'Button', key: 'split-p1-a' }), 'split, at the row').toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'remove-p1-a' }), 'delete, at the row').toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'locate-p1-a' })).toBeUndefined()
  // The row's press is a blank laid over it, painted over what it spans: the icons stand outside that box, or a click on one unfolds the row.
  const drawn = (await pane.drawn()) as unknown as Drawn
  const span = spanOf(drawn, 'open-prompt-p1-a')
  expect(span, 'the row takes the press').toBeDefined()
  expect([holds(span!, 'split-p1-a'), holds(span!, 'remove-p1-a'), holds(span!, 'fold-prompt-p1-a')], 'the box the press spans holds no icon').toEqual([false, false, false])
  // Each icon takes the press on both of the row's lines, its name shown below the row, never over the press.
  expect(await pane.find({ type: 'Button', key: 'split-p1-a-2' }), "the icon's second line").toBeDefined()
  const name = spanOf(drawn, 'split-p1-a')?.children?.find((c): c is Drawn => typeof c !== 'string' && c.props?.display === 'none')
  expect(name?.props?.top).toBe(2)
  // The triangle is a press of its own, the row's: it unfolds the turn.
  await pane.press({ key: 'fold-prompt-p1-a' })
  await pane.unmount()
  const again = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(JSON.stringify(await again.drawn()), 'the press unfolds the turn: its answer, which no record holds here').toContain('没有记下回答')
  await again.unmount()
})

const LOGS = `${ROOT}/.geml/sessions`
const OWN_LOG = `${LOGS}/claude-code-sess-1234567890.geml`
const events = (text: string | undefined) => (text ?? '').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)

test('the project record: a prompt opens a turn in this session\'s log, the model notes its decisions, the answer closes it; the directory keeps itself out of git', async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = await start($, on)
  await clock.advance(1)
  await $.prompt.submit({ text: '按项目组织会话', wait: false, origin: COMPOSER })
  expect(w.files.get(`${LOGS}/.gitignore`)).toBe('*\n')
  const noted = await $.tool.call({ tool: 'mcp__gemflow__note', tool_use_id: 'n1', decisions: ['每会话一个文件', ' '] })
  expect(String(noted.text ?? noted.result)).toMatch(/^Recorded 1 decision; the project's other sessions will see it\./)
  await $.turn.complete({ answer: '好了，按项目记。', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  expect(events(w.files.get(OWN_LOG)).map((x) => [x.t, x.turn ?? null, x.text ?? x.host])).toEqual([
    ['session', null, 'claude-code'], ['prompt', 1, '按项目组织会话'], ['decision', 1, '每会话一个文件'], ['answer', 1, '好了，按项目记。'],
  ])
})

test('a page the Artifact tool published is an artifact of the work item, named by its title; the model records a link of its own with the artifact tool', async ($, on) => {
  const w = world(on)
  const said = 'Published C:/s/page.html at https://claude.ai/artifact/AbC123 (Version 2, version id 1792086025-315b) Icon: "layout".'
  on('tool.call', { tool: 'Artifact' }, () => ({ result: said, text: said }))
  const clock = await start($, on)
  await clock.advance(1)
  await $.tool.call({ tool: 'Artifact', tool_use_id: 'a1', file_path: 'C:/s/page.html', title: '界面示意' })
  await $.tool.call({ tool: 'Artifact', tool_use_id: 'a2', action: 'read', url: 'https://claude.ai/artifact/AbC123' })
  await clock.advance(1)
  expect(w.sent.filter((r) => r.op === 'artifact').map((r) => [r.kind, r.where, r.version, r.name, r.page])).toEqual([['link', 'https://claude.ai/artifact/AbC123', '2', '界面示意', 'C:/s/page.html']])
  const recorded = await $.tool.call({ tool: 'mcp__gemflow__artifact', tool_use_id: 'p1', kind: 'link', where: 'https://docs.example.com/d/1', name: '方案' })
  expect(String(recorded.text ?? recorded.result)).toMatch(/^Recorded the link/)
  const refused = await $.tool.call({ tool: 'mcp__gemflow__artifact', tool_use_id: 'p2', kind: 'video', where: 'x' })
  expect(String(refused.text ?? refused.result)).toMatch(/^Nothing recorded/)
  expect(w.sent.filter((r) => r.op === 'artifact').length).toBe(2)
})

test('a page or a picture written outside the project is an artifact at the turn\'s end; a script there is not', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' }, text: 'written' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = await start($, on)
  await clock.advance(1)
  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/tmp/scratch/icon-a.svg', content: '<svg/>' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'w2', file_path: '/tmp/scratch/tool.mjs', content: 'export {}' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'w3', file_path: '/tmp/scratch/icon-a.svg', content: '<svg></svg>' })
  await clock.advance(1)
  await $.turn.complete({ answer: '画了一版图标。', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  expect(w.sent.filter((r) => r.op === 'artifacts').map((r) => r.elsewhere ?? null)).toEqual([['/tmp/scratch/icon-a.svg']])
  await $.turn.complete({ answer: '没再写。', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(1)
  expect(w.sent.filter((r) => r.op === 'artifacts').map((r) => r.elsewhere ?? null), 'each turn its own').toEqual([['/tmp/scratch/icon-a.svg'], null])
})

test("the first start with a shared record reads the host's transcripts into it, one by one; the session's own turns go before its log and onto its tab, marked; the band says the outcome once; done once", async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  w.transcripts = [{ file: '/t/own.jsonl', id: 'sess-1234567890', size: 10 }, { file: '/t/old.jsonl', id: 'old', size: 20 }, { file: '/t/bad.jsonl', id: 'bad', size: 5 }]
  w.backfills.set('/t/own.jsonl', { id: 'sess-1234567890', turns: 1, files: 0, links: 0, transcript: { id: 'sess-1234567890', started: '2026-10-20T01:00:00Z', last: '2026-10-20T01:00:12Z', turns: [{ uuid: 'u1', at: '2026-10-20T01:00:00Z', text: '产物不是产品，叫artifacts', kind: 'person', answer: '改好了：products 改名 artifacts。\n细节。', answerAt: '2026-10-20T01:00:12Z', files: [], links: [], uploads: [] }] } })
  w.backfills.set('/t/old.jsonl', { id: 'old', turns: 1, files: 1, links: 0 })
  w.backfills.set('/t/bad.jsonl', 'cannot read bad.jsonl')
  // The old session's log, as the bridge wrote it.
  w.files.set(`${LOGS}/claude-code-old.jsonl`, [
    { t: 'session', id: 'old', host: 'claude-code', at: '2026-10-19T08:12:00Z', branch: 'main', backfilled: true, scheduled: 'weekly-geml-docs-review' },
    { t: 'prompt', turn: 1, at: '2026-10-19T08:12:00Z', text: '<scheduled-task name="weekly-geml-docs-review">审文档</scheduled-task>', uuid: 'x1', backfilled: true, kind: 'scheduled' },
    { t: 'answer', turn: 1, at: '2026-10-19T08:20:00Z', text: '审完了。没问题。' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const clock = await start($, on)
  await clock.advance(10_000)
  expect(w.sent.filter((r) => r.op === 'backfill-one').map((r) => [r.file, r.own ?? false])).toEqual([['/t/own.jsonl', true], ['/t/old.jsonl', false], ['/t/bad.jsonl', false]])
  expect(await bandText($)).toMatch(/初始化完毕。欢迎使用。（1 个会话读不了）/)
  expect(w.store.get(`init:${LOGS}`)).toBe(true)
  const ownLog = w.files.get(`${LOGS}/claude-code-sess-1234567890.geml`) ?? ''
  expect(ownLog).toContain('"uuid":"u1"')
  expect(ownLog).toContain('"backfilled":true')
  expect(ownLog).toContain('改好了：products 改名 artifacts。')
  // The next prompt takes the outcome down; it is recorded after the backfilled turn, which keeps its place.
  await $.prompt.submit({ text: '继续', wait: false, origin: COMPOSER })
  expect(await bandText($)).not.toMatch(/初始化/)
  const after = w.files.get(`${LOGS}/claude-code-sess-1234567890.geml`) ?? ''
  expect(after.indexOf('产物不是产品')).toBeLessThan(after.indexOf('"text":"继续"'))
  // Done once: another start reads nothing again.
  const before = w.sent.filter((r) => r.op === 'backfill-list').length
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.sent.filter((r) => r.op === 'backfill-list').length).toBe(before)
})

test("turns removed or split away with the split-session skill leave the sessions tab and this session's log; split ones go into the new session's log; a prompt from the last two minutes stays", async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  w.store.set(`init:${LOGS}`, true)
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    const command = String((e as { command?: string }).command)
    const stdout = command.includes('--turns 2') ? '{\n  "created": { "cliId": "new-1", "title": "x" }\n}\n' : 'backing up…\n{\n  "turns": [{ "n": 1 }],\n  "removed": true\n}\n'
    return { result: { stdout, stderr: '', interrupted: false }, text: stdout }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = await start($, on)
  for (const [text, uuid] of [['产物不是产品', 'u1'], ['提交改动', 'u2'], ['推', 'u3']] as const) {
    await $.prompt.submit({ text, wait: false, origin: COMPOSER })
    await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text }] }, door: 'prompt', origin: COMPOSER, uuid })
    await $.turn.complete({ answer: `${text}：做了。`, durationMs: 5, isAborted: false, turnId: `t-${uuid}`, reason: 'answer' })
    await clock.advance(60_000)
  }
  await clock.advance(3 * 60_000)
  expect(w.files.get(OWN_LOG) ?? '').toContain('"text":"产物不是产品"')
  // The transcript now holds only the second and third rows: the first turn was removed.
  w.turnIds = ['u2', 'u3']
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'node /p/skills/split-session/split-session.mjs remove --turns 1' })
  await clock.advance(2_000)
  const log1 = w.files.get(OWN_LOG) ?? ''
  expect(log1).not.toContain('产物不是产品')
  expect(log1).toContain('"text":"提交改动"')
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  const words = shown((await pane.drawn()) as unknown as Drawn).join(' ')
  expect(words).toContain('提交改动')
  expect(words, 'the removed turn left the tab').not.toContain('产物不是产品')
  await pane.unmount()
  // Split: the second turn goes to a new session (the last turn stays).
  w.turnIds = ['u3']
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'node /p/skills/split-session/split-session.mjs split --turns 2 --title "x"' })
  await clock.advance(2_000)
  const log2 = w.files.get(OWN_LOG) ?? ''
  expect(log2).not.toContain('提交改动')
  expect(log2).toContain('"text":"推"')
  const moved = w.files.get(`${LOGS}/claude-code-new-1.geml`) ?? ''
  expect(moved).toContain('"id":"new-1"')
  expect(moved).toContain('"turn":1,"at":')
  expect(moved).toContain('"text":"提交改动"')
  expect(moved).toContain('提交改动：做了。')
  // A prompt the transcript lacks but which is only seconds old stays: its row may not be written yet.
  await $.prompt.submit({ text: '最新', wait: false, origin: COMPOSER })
  await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: '最新' }] }, door: 'prompt', origin: COMPOSER, uuid: 'u4' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: 'node /p/skills/split-session/split-session.mjs remove --turns 9' })
  await clock.advance(2_000)
  expect(w.files.get(OWN_LOG) ?? '').toContain('"text":"最新"')
  // Two reads that disagree (the file was changing): nothing moves.
  w.turnIdsQueue = [[], ['u3']]
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b5', command: 'node /p/skills/split-session/split-session.mjs remove --turns 9' })
  await clock.advance(2_000)
  expect(w.files.get(OWN_LOG) ?? '', 'a changing transcript is no fact').toContain('"text":"推"')
  // A dry run changes nothing.
  w.turnIds = []
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b4', command: 'node /p/skills/split-session/split-session.mjs remove --turns 3 --dry-run' })
  await clock.advance(2_000)
  expect(w.files.get(OWN_LOG) ?? '').toContain('"text":"推"')
})

test('the other sessions\' decisions come beside the person\'s prompt, once each; this session\'s own never', async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => { contexts.push(e.context); return { text: e.text } })
  const clock = await start($, on)
  await clock.advance(1)
  const at = new Date(clock.now()).toISOString()
  w.files.set(`${LOGS}/codex-cx1.jsonl`, [
    { t: 'session', id: 'cx1', host: 'codex', at, branch: 'feat/y' },
    { t: 'prompt', turn: 1, at, text: 'runtime 的 PR 能合吗' },
    { t: 'decision', turn: 1, at, text: '合并前先跑三平台 CI' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  await clock.advance(1000)
  await $.prompt.submit({ text: '接着做会话页', wait: false, origin: COMPOSER })
  const first = (contexts.at(-1) ?? []).join('\n')
  expect(first).toContain('[gemflow] 本项目其他会话记下的决定：')
  expect(first).toMatch(/- 合并前先跑三平台 CI（Codex · feat\/y，\d\d:\d\d）/)
  await $.tool.call({ tool: 'mcp__gemflow__note', tool_use_id: 'n1', decisions: ['我自己的决定'] })
  await clock.advance(1000)
  await $.prompt.submit({ text: '再来一句', wait: false, origin: COMPOSER })
  expect((contexts.at(-1) ?? []).join('\n'), 'heard once; its own never').not.toContain('[gemflow] 本项目其他会话')
})

test('the session tab across the project: the decisions, a file two sessions changed in the error colour, another session unfolding; a decision pressed goes into the prompt box', async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  const filled: string[] = []
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true, box: { text: e.text, cursor: e.text.length } } })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: `${ROOT}/hooks/register.tsx` }, text: 'edited' }))
  const clock = await start($, on)
  await clock.advance(1)
  const at = new Date(clock.now()).toISOString()
  w.files.set(`${LOGS}/codex-cx1.jsonl`, [
    { t: 'session', id: 'cx1', host: 'codex', at, branch: 'feat/y' },
    { t: 'prompt', turn: 1, at, text: 'runtime 的 PR 能合吗' },
    { t: 'decision', turn: 1, at, text: '合并前先跑三平台 CI' },
    { t: 'file', turn: 1, at, path: 'hooks/register.tsx', branch: 'feat/y' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  await $.prompt.submit({ text: '改状态带', wait: false, origin: COMPOSER })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${ROOT}/hooks/register.tsx`, old_string: 'a', new_string: 'b' })
  await clock.advance(1)
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  await clock.advance(60_000)
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  for (const heading of ['决定', '本会话', '其他会话']) expect(await pane.find({ type: 'Text', text: heading }), heading).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'export-cx1' }), 'the other session exports from its heading').toBeDefined()
  await pane.press({ key: 'go-session-cx1' })
  await pane.unmount()
  const again = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await again.find({ type: 'Button', key: 'open-other-cx1-1' }), 'the other session unfolds to its turns').toBeDefined()
  const decision = (await again.findAll({ type: 'Button' })).find((b) => String(b.key).startsWith('go-decision-cx1-'))
  expect(decision).toBeDefined()
  await again.press({ key: String(decision!.key) })
  await again.unmount()
  expect(filled.at(-1)).toBe('参照 Codex · feat/y：合并前先跑三平台 CI\n')
})

test('on the desktop, where the conversation cannot be scrolled, a press on the row unfolds the turn: its whole prompt and the answer its log holds', async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = await start($, on)
  await clock.advance(1)
  await $.prompt.submit({ text: '把会话页改成整行可点', wait: false, origin: COMPOSER })
  await $.turn.complete({ answer: '**改好了**，整行都能点。', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  const board = () => $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  let pane = await board()
  const pick = (await pane.findAll({ type: 'Button' })).find((b) => String(b.key).startsWith('open-prompt-'))
  expect(pick).toBeDefined()
  const id = String(pick!.key).slice('open-prompt-'.length)
  expect(await pane.find({ type: 'Button', key: `locate-${id}` }), 'no 跳转 where nothing scrolls').toBeUndefined()
  await pane.press({ key: `open-2-prompt-${id}` }).catch(async () => pane.press({ key: `open-prompt-${id}` }))
  await pane.unmount()
  pane = await board()
  expect(JSON.stringify(await pane.drawn()), 'the answer, from the log').toContain('**改好了**，整行都能点。')
  // The same press folds it again.
  await pane.press({ key: `open-prompt-${id}` })
  await pane.unmount()
  pane = await board()
  expect(JSON.stringify(await pane.drawn()), 'folded').not.toContain('**改好了**，整行都能点。')
  await pane.unmount()
})

test('a session\'s first prompt is in its log though the slower facts have not come; a background task\'s notification is no prompt', async ($, on) => {
  const w = world(on)
  w.sessionsDir = LOGS
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await start($, on)
  await $.prompt.submit({ text: '给我看下 sessions 下的内容', wait: false, origin: COMPOSER })
  await $.prompt.submit({ text: '<task-notification>后台任务完成</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(events(w.files.get(OWN_LOG)).filter((x) => x.t === 'prompt').map((x) => x.text)).toEqual(['给我看下 sessions 下的内容'])
  await $.command.run({ command: 'gemflow', args: 'board sessions', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(JSON.stringify(await pane.drawn()), 'the session tab lists no notification').not.toContain('task-notification')
  await pane.unmount()
})
