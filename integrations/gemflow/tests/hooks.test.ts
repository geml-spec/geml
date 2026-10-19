// The hooks module under the engine's own test host. A scripted bridge
// answers `process.run`; nothing here touches a disk or starts a process.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROOT = '/work/app'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const PANE = { title: 'Gemflow', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
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
    /** The open pull requests the attention answer carries. */
    prs: [] as { number: number; branch: string; green: boolean; failing: string[] }[],
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
    tools: ROWS, backlog: null, items: [{ id: 'feat/x', state: w.state, rev: w.rev, at: '2026-10-12T09:00:00Z', paused: w.paused }], timeline: w.timeline, clocks: [], tree: 'tree:1',
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
    if (req.op === 'board') return { v: 1, ok: true, shell: shell(), board: board(), todo: w.todo }
    if (req.op === 'refresh') return { v: 1, ok: true, shell: shell(), todo: w.todo }
    if (req.op === 'attention') return { v: 1, ok: true, shell: shell(), attention: { ahead: [], prs: w.prs }, host: { name: 'build-box', platform: 'linux', user: 'dev', branch: 'feat/x' } }
    return { v: 1, ok: true, shell: shell(), ...(req.op === 'before' ? { recorded: false } : {}), ...(req.op === 'after' ? handoff(req) : {}) }
  }
  const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  on('process.run', ($, e) => {
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
  on('fs.read', ($, e) => (posix(e.path) === `${ROOT}/.geml/context.geml`
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
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.notify', ($, e) => { w.notified.push(e.text); return { value: { isSent: true, channel: 'test' } } })
  on('ui.copy', ($, e) => { w.copied.push(e.text); return { value: { isCopied: true } } })
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => { w.store.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: 'zh_CN.UTF-8' }))
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

type Drawn = { type: string; props?: Record<string, unknown>; children?: (Drawn | string)[] }

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
  expect(w.registered).toEqual(['status', 'move', 'set'])

  const tests = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', tool: 'Bash', callId: 'b1', exitCode: 0, isError: false, gitOperation: false, input: { command: 'npm test' } })
  expect(tests.context).toEqual(['[gemflow] stage #review · rev 3'])

  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(seen).toBeUndefined()

  const opened = await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(opened.text).toBe('已打开 Gemflow 看板。')
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await pane.press({ key: 'tab-flow' })
  await pane.press({ key: 'advance-review→done' })
  expect(w.sent.filter((r) => r.op === 'advance').at(-1)).toMatchObject({ to: 'done' })

  await $.prompt.submit({ text: 'and now?', wait: false, origin: COMPOSER })
  expect(seen).toEqual(['[gemflow] stage #done · rev 4'])
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
  await start($, on)
  const refused = await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(refused.deny ?? refused.text ?? '').toMatch(/Edit is edit, which is used only in #build; the workflow is in #review/)
  expect(w.sent.at(-1)).toMatchObject({ op: 'before', tool: 'Edit', input: { file_path: `${ROOT}/a.ts` } })
  w.bridge = false
  const passed = await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(passed.text).toBe('edited')
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /桥接没有应答/ })).toBeDefined()
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
  expect(await bandText($, 'desktop')).toBe('[　　] 我在做 feat/x · build 看板 [　　　　]')
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
    for (const key of ['tab-sessions', 'tab-flow', 'tab-items', 'tab-journal', 'tab-tools', 'dialog-share', 'dialog-settings', 'dialog-upgrade', 'dialog-about', 'pause']) {
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
    expect(await pane.find({ type: 'Text', text: '没有要你做的事' }), `the work items first, nothing waiting: ${await texts()}`).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '在做 · build' }), await texts()).toBeDefined()
    await pane.press({ key: 'tab-flow' })
    // #build's transition waits on its guard: drawn, not offered, since a person's advance would be refused.
    expect(await pane.find({ type: 'Button', key: 'advance-build→review' })).toBeUndefined()
    // The picture is the parser's drawing where a surface draws pictures, boxes and lines on the terminal.
    if (surface === 'terminal') expect(await pane.find({ type: 'Text', text: /→ #review {2}自动 {2}要求 tests-pass and pr-open（未满足）/ }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '这里能用' }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Edit · Write' }), await texts()).toBeDefined()
    await pane.press({ key: 'tab-tools' })
    expect(await pane.find({ type: 'Button', text: 'npm test' }), await texts()).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '跑测试（首选）' }), await texts()).toBeDefined()
    await pane.press({ key: 'tab-journal' })
    expect(await pane.find({ type: 'Text', text: /还没有记录/ })).toBeDefined()
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
  expect(seen).toEqual(['[gemflow] stage #review · rev 3'])
  await $.prompt.submit({ text: 'and?', wait: false, origin: COMPOSER })
  expect(seen).toBeUndefined()
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
  expect(seen).toEqual(['[gemflow] stage #review · rev 5'])
})

test('a registration the engine refuses: the start goes on, and the band says which', async ($, on) => {
  const w = world(on)
  w.refuse = { set: 'a tool named set is already registered' }
  await start($, on)
  expect(w.sent.map((r) => r.op)).toEqual(['status', 'refresh', 'board', 'attention'])
  expect(w.registered).toEqual(['status', 'move'])
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
  expect(down.text).toMatch(/^看板打不开：桥接没有应答（[^）]*timed out after 15000 ms）$/)
  const stale = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await stale.press({ key: 'tab-flow' })
  expect(await stale.find({ type: 'Text', text: /^gemflow：桥接没有应答/ })).toBeDefined()
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
  expect(await pane.find({ type: 'Text', text: /^gemflow：看板画不出来（/ })).toBeDefined()
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
  expect(seen, 'the next prompt carries the session\'s own stage: nothing marked the other item\'s as delivered').toEqual(['[gemflow] stage #build · rev 0'])
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
  expect(seen).toEqual(['[gemflow] stage #build · rev 0'])
  w.item = 'feat/y'
  const there = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git switch -c feat/y' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', delivered: 'feat/x@0' })
  expect(there.context).toEqual(['[gemflow] now on feat/y · #build (new work item)\n[gemflow] stage #build · rev 0'])
  await $.prompt.submit({ text: 'and?', wait: false, origin: COMPOSER })
  expect(seen, 'handed over with the result: the next prompt does not repeat it').toBeUndefined()
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
  expect(w.notified).toEqual(['等你验收：feat/x\nreview'])
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Svg' })).toBeDefined()
  expect(await bandText($, 'desktop')).toBe('[　　] 验收 feat/x [通过] 看板 [　　　　]')
  expect((await band.findAll({ type: 'Button' })).map((b) => b.key)).toEqual(['band-mark-open', 'title', 'approve-done', 'board'])
  await band.press({ key: 'approve-done' })
  expect(w.sent.filter((r) => r.op === 'advance').at(-1)).toMatchObject({ to: 'done' })
  expect(w.state).toBe('done')
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '没有要你做的事' }), 'approved: nothing waits').toBeDefined()
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

test('pause and resume from the board header; the band says so and offers only resume', async ($, on) => {
  const w = world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await pane.press({ key: 'pause' })
  expect(w.sent.filter((r) => r.op === 'pause')).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: 'build · 已暂停' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'resume' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'pause' })).toBeUndefined()
  expect(await bandText($)).toBe('» 已暂停 feat/x · 模型推不动，证据照记 [继续] [看板]')
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
  const dialog = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-dialog', props: { ...PANE, title: '设置' } })
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

test('the session tab lists each prompt by day, newest first, with what its turn did, and exports them through the bridge', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
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
  await pane.press({ key: 'export-session-md' })
  const exported = w.sent.filter((r) => r.op === 'export').at(-1) as Req
  expect(exported).toMatchObject({ kind: 'text', format: 'md', name: 'session-sess-123' })
  expect(String(exported['text'])).toMatch(/^# 会话 sess-1234567890\n/)
  expect(String(exported['text'])).toContain('把测试补上，然后开 PR。')
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
  // The oldest turn, drawn last: its menu opens on a press.
  const id = String(picks[1]!.key).slice('open-prompt-'.length)
  expect(await pane.find({ type: 'Button', key: `locate-${id}` }), 'no actions until the turn is pressed').toBeUndefined()
  await pane.press({ key: `open-prompt-${id}` })
  await pane.press({ key: `locate-${id}` })
  // A transcript row is the surface's to move: the test host has none, so the module reports why nothing moved.
  expect(w.toasts.at(-1)).toBe('对话没有滚到那一处：no implementation for ui.scroll')
  await pane.press({ key: `open-prompt-${id}` })
  await pane.press({ key: `split-${id}` })
  expect(asked.at(-1)).toMatch(/拆到新会话（最后一轮留下）？$/)
  expect(prompted).toHaveLength(1)
  expect(prompted[0]).toContain('/skills/split-session/split-session.mjs')
  expect(prompted[0]).toContain('「把测试补上，然后开 PR。」')
  expect(prompted[0]).toContain('最后一轮除外')
  await pane.press({ key: `open-prompt-${id}` })
  await pane.press({ key: `remove-${id}` })
  expect(asked.at(-1)).toMatch(/单独的新会话（内容不丢）？$/)
  expect(prompted[1]).toContain('只把这一轮拆到新会话')
  expect(w.toasts.filter((x) => x === '已交给模型，结果看对话')).toHaveLength(2)
  await pane.press({ key: 'export-session-json' })
  const exported = w.sent.filter((r) => r.op === 'export').at(-1) as Req
  expect((JSON.parse(String(exported['text'])) as { prompts: { uuid?: string }[] }).prompts.map((p) => p.uuid), 'the export carries the rows\' ids').toEqual(stored)
  await pane.unmount()
})

test('share: where it stands is copied as text; the journal goes as a file', async ($, on) => {
  const w = world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const board = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await board.press({ key: 'dialog-share' })
  await board.unmount()
  const dialog = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-dialog', props: { ...PANE, title: '分享' } })
  expect(await dialog.find({ type: 'Text', text: 'feat/x · 开发流程 · build' }), 'the preview').toBeDefined()
  await dialog.press({ key: 'share-go' })
  expect(w.copied, 'nothing waits and nothing was made yet: the one line').toEqual(['feat/x · 开发流程 · build'])
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
  await $.turn.complete({ answer: '改好了，提交在本地。\n\n要强推覆盖 origin 上的 feat/x。推吗？', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'gemflow', surface, component: 'AbovePrompt', props: BAND })
    expect(shown((await band.drawn()) as unknown as Drawn).join(' '), surface).toMatch(/定 要强推覆盖 origin 上的 feat\/x。 推吗？/)
    expect(await band.find({ type: 'Button', key: 'attention-0-推' }), surface).toBeDefined()
    await band.unmount()
  }
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'attention-0-推' })
  await band.unmount()
  expect(said.at(-1), 'the press said it as the person').toBe('推')
  // Answered: the question no longer leads.
  expect(await bandText($)).not.toMatch(/推吗/)
  await $.turn.complete({ answer: '还要你定两件事：\n1. 新分支要不要开 PR\n2. #32 关不关', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  expect(await pane.find({ type: 'Text', text: '此刻' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '新分支要不要开 PR' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '#32 关不关' })).toBeDefined()
  await pane.unmount()
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
  await $.prompt.submit({ text: '好', wait: false, origin: COMPOSER })
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
  const clock = await start($, on)
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b9', command: 'cp -r dist ~/.claude/local-marketplaces/geml-dev/gemflow/' })
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  const board = () => $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  let pane = await board()
  expect(await pane.find({ type: 'Button', key: 'attention-0-合并' })).toBeDefined()
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
