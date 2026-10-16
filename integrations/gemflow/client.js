/**
 * Gemflow — the browser half for DeepSeek Harness's web GUI (spec §8.10).
 *
 * One tab type in the right Sidebar, "Gemflow", and its body: the board the
 * Claude Code plugin draws, with the same six tabs and the same words. The
 * rows come ready-made from the host half (`GET /api/gemflow/board`), built by
 * the same functions that build the Claude Code board; this file only draws
 * them and sends a press back (`POST /api/gemflow/act`). A tab, a filter and
 * an expanded entry are the tab's own state, asked for with the next read. A
 * file link opens the file through dsh's own session API, since a `file:`
 * link from an http page opens nothing in a browser.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell provides. Colours are the shell's theme variables.
 */
window.__ModuleLoader__.load({
  id: '@geml/gemflow',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const ID = '@geml/gemflow'
    const KIND = 'gemflow'
    const POLL_MS = 3000
    const inject = ['slots', 'locale', 'sidebarRightTabs']

    // The few words this file says itself; every word on the board comes from the host in the language asked for.
    const WORDS = {
      zh: { about: '流程、阶段、证据与记录', loading: '正在读取看板…', retry: '重试', none: '这个会话不在 Gemflow 的流程里', paused: '⏸ 已暂停', pause: '暂停', resume: '继续', refusals: '次拒绝', rev: '第 {0} 条修订', final: '已结束' },
      en: { about: 'the workflow, its stage, the evidence and the record', loading: 'reading the board…', retry: 'Retry', none: 'this session is in no Gemflow workflow', paused: '⏸ paused', pause: 'Pause', resume: 'Resume', refusals: 'refusals', rev: 'revision {0}', final: 'closed' },
      ja: { about: 'ワークフロー、段階、証拠と記録', loading: 'ボードを読み込み中…', retry: '再試行', none: 'このセッションは Gemflow のワークフローにありません', paused: '⏸ 一時停止中', pause: '一時停止', resume: '再開', refusals: '回の拒否', rev: 'リビジョン {0}', final: '終了' },
    }
    const langOf = ctx => {
      const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
      const value = String(snapshot?.active ?? ctx.locale?.locale ?? 'en').toLowerCase()
      return value.startsWith('zh') ? 'zh' : value.startsWith('ja') ? 'ja' : 'en'
    }
    const fill = (text, ...args) => text.replace(/\{(\d+)\}/g, (hole, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : hole))

    const TONE = {
      normal: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-tertiary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warning: 'var(--dsw-alias-state-warning-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      brand: '#E00A1E',
    }
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    /** One call on dsh's gateway: `POST /api/<ns>/<method>` with the client-request envelope the shell's own client sends. */
    async function remote(method, request) {
      const r = await fetchJson(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `gemflow-${Date.now().toString(36)}`, method, payload: { args: { request } } }) })
      if (r.result && r.result.ok === true) return { ok: true, value: r.result.value }
      return { ok: false, error: (r.result && r.result.error && r.result.error.message) || r.error || `HTTP ${r.status}` }
    }

    /** The local path a `file:` URL names. */
    const pathOf = href => { try { return decodeURIComponent(href.replace(/^file:\/\//, '')) } catch { return href } }

    async function fetchJson(url, init) {
      try {
        const r = await fetch(url, { credentials: 'same-origin', ...init })
        const body = await r.json().catch(() => null)
        if (body && typeof body === 'object') return { status: r.status, ...body }
        return { status: r.status, ok: false, error: `HTTP ${r.status}` }
      } catch (e) {
        return { status: 0, ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    function Button({ b, act, active }) {
      return h('button', {
        type: 'button',
        onClick: () => act(b.action),
        style: {
          padding: '2px 8px', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: '0.92em',
          border: `1px solid ${b.primary ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'}`,
          background: b.primary ? 'var(--dsw-alias-state-business-primary)' : active ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-2)',
          color: b.primary ? '#fff' : 'var(--dsw-alias-label-primary)',
          fontWeight: active ? 600 : 400,
        },
      }, b.label)
    }

    function Field({ row, act }) {
      const [value, setValue] = useState('')
      return h('div', { style: { padding: '2px 0' } }, h('input', {
        type: 'text', value, placeholder: row.placeholder, 'aria-label': row.placeholder,
        onChange: e => setValue(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter' && value.trim() !== '') { act({ op: 'input', field: row.field, value }); setValue('') } },
        style: { width: '100%', boxSizing: 'border-box', padding: '3px 8px', borderRadius: 6, font: 'inherit', fontSize: '0.92em', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
      }))
    }

    /** One row as the host built it: text with a tone, a button or a line of them, a link, a field. */
    function Row({ row, act, open }) {
      switch (row.kind) {
        case 'text':
          return h('div', { style: { color: TONE[row.tone] || TONE.normal, whiteSpace: 'pre-wrap', padding: '1px 0', fontFamily: /[│├└─]/.test(row.text) ? MONO : 'inherit' } }, row.text === ' ' ? ' ' : row.text)
        case 'button':
          return h('div', { style: { padding: '2px 0' } }, h(Button, { b: row, act }))
        case 'buttons':
          return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 0' } }, row.items.map(b => h(Button, { key: b.key, b, act })))
        case 'link':
          return h('div', { style: { padding: '1px 0' } },
            h('a', { href: row.href, onClick: e => { e.preventDefault(); open(pathOf(row.href)) }, style: { color: 'var(--dsw-alias-state-business-primary)' } }, row.label),
            h('span', { style: { color: TONE.dim, marginLeft: 6, fontFamily: MONO, fontSize: '0.85em', wordBreak: 'break-all' } }, pathOf(row.href)))
        case 'input':
          return h(Field, { row, act })
        case 'flow':
          // The picture as SVG, inline, so a click reaches us: a transition drawn as pressable carries its target.
          return h('div', {
            style: { padding: '4px 0' }, 'aria-label': 'flow', dangerouslySetInnerHTML: { __html: row.svg },
            onClick: e => { const g = e.target.closest && e.target.closest('g.tr.can'); if (g && g.dataset.to) act({ op: 'advance', to: g.dataset.to }) },
          })
        default:
          return null
      }
    }

    function Board(props) {
      const sessionId = props.sessionId ?? props.session?.id
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const visible = info?.tab?.visible ?? true
      const lang = props.lang
      const w = WORDS[lang] || WORDS.en
      const [tab, setTab] = useState('pending')
      const [filter, setFilter] = useState('all')
      const [expanded, setExpanded] = useState(null)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      // What the last press or open-file said when it failed; the next one replaces it, a poll leaves it.
      const [notice, setNotice] = useState(null)
      const [missing, setMissing] = useState(false)

      const load = useCallback(async () => {
        if (!sessionId) return
        const q = new URLSearchParams({ session: String(sessionId), tab, filter, lang })
        if (expanded) q.set('expanded', expanded)
        const body = await fetchJson(`/api/gemflow/board?${q.toString()}`)
        if (body.ok) { setData(body); setError(null); setMissing(false) }
        else if (body.status === 404) { setMissing(true); setError(null) }
        else setError(body.error || `HTTP ${body.status}`)
      }, [sessionId, tab, filter, expanded, lang])

      useEffect(() => {
        if (!visible) return undefined
        load()
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load, visible])

      const act = useCallback(async action => {
        switch (action.op) {
          case 'tab': setTab(action.tab); return
          case 'filter': setFilter(action.filter); return
          case 'expand': setExpanded(action.entry); return
          case 'refresh': load(); return
          default: {
            const r = await fetchJson('/api/gemflow/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: sessionId, action }) })
            setNotice(r.ok ? null : (r.error || `HTTP ${r.status}`))
            if (r.ok) load()
          }
        }
      }, [sessionId, load])

      // A file link: dsh opens the file with the machine's default application (session/openWorkspacePath);
      // a file no application claims is shown in the file manager instead.
      const open = useCallback(async path => {
        const opened = await remote('session/openWorkspacePath', { path })
        if (opened.ok) { setNotice(null); return }
        const shown = await remote('session/openWorkspacePath', { path, action: 'reveal' })
        setNotice(shown.ok ? null : opened.error)
      }, [])

      const box = { padding: '8px 12px', fontSize: '0.95em', lineHeight: 1.45, color: 'var(--dsw-alias-label-primary)' }
      if (missing) return h('div', { style: box }, h('div', { style: { color: TONE.dim } }, w.none))
      if (!data) return h('div', { style: box }, h('div', { style: { color: TONE.dim } }, error ? `gemflow: ${error}` : w.loading), error ? h('div', { style: { marginTop: 6 } }, h(Button, { b: { key: 'retry', label: w.retry, action: { op: 'refresh' } }, act })) : null)

      const hd = data.header
      const hold = hd.paused ? { key: 'resume', label: w.resume, primary: true, action: { op: 'resume' } } : { key: 'pause', label: w.pause, action: { op: 'pause' } }
      return h('div', { style: box },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: TONE.brand, fontWeight: 700 } }, 'G'),
          h('span', { style: { fontWeight: 600 } }, 'Gemflow'),
          hd.version ? h('span', { style: { color: TONE.dim } }, hd.version) : null),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
          h('span', { style: { fontFamily: MONO } }, `⧗ ${hd.item}`),
          hd.state ? h('span', null, hd.state.id) : null,
          h('span', { style: { color: TONE.dim } }, hd.workflow),
          hd.state ? h('span', { style: { color: TONE.dim } }, fill(w.rev, hd.state.rev)) : null,
          hd.state && hd.state.final ? h('span', { style: { color: TONE.success } }, w.final) : null,
          hd.refusals > 0 ? h('span', { style: { color: TONE.error } }, `${hd.refusals} ${w.refusals}`) : null,
          hd.paused ? h('span', { style: { color: TONE.warning } }, w.paused) : null,
          hd.state && !hd.state.final ? h(Button, { b: hold, act }) : null),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0', paddingBottom: 6, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          data.tabs.map(x => h(Button, { key: x.id, b: { key: `tab-${x.id}`, label: x.label, action: { op: 'tab', tab: x.id } }, act, active: x.id === tab }))),
        error ? h('div', { style: { color: TONE.error, marginBottom: 6 } }, `gemflow: ${error}`) : null,
        notice ? h('div', { style: { color: TONE.error, marginBottom: 6, whiteSpace: 'pre-wrap' } }, `gemflow: ${notice}`) : null,
        h('div', null, data.rows.map((row, i) => h(Row, { key: i, row, act, open }))))
    }

    function apply(ctx) {
      const lang = () => langOf(ctx)
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        title: () => 'Gemflow',
        guide: [{ order: 40, title: () => 'Gemflow', description: () => (WORDS[lang()] || WORDS.en).about }],
      }), 'gemflow: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, props => h(Board, { ...props, lang: lang() }))), 'gemflow: tab body')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'gemflow'
    return module.exports
  },
})
