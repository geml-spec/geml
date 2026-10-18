// The values Gemflow's hooks module keeps in $.state. What the bridge answers
// is kept as JSON; the module reads it as the protocol's types
// (src/hosts/claude-code/protocol.ts) and the board's (actions.ts, inbox.ts,
// sessions.ts, settings.ts).
export type GemflowJson = null | boolean | number | string | readonly GemflowJson[] | { readonly [key: string]: GemflowJson }
export type GemflowTab = 'sessions' | 'flow' | 'items' | 'journal' | 'tools'

declare module 'claude-code' {
  interface PluginState {
    gemflow: {
      shell: GemflowJson
      board: GemflowJson
      problem: string | null
      node: string | null
      root: string | null
      delivered: string | null
      lastFile: string | null
      tab: GemflowTab
      /** Whether the work items tab lists the finished work items. */
      doneOpen: boolean
      /** The state the flow tab shows below its picture (its id). */
      flowState: string | null
      /** Whether the flow tab lists the workflows to switch to. */
      flowSwitch: boolean
      /** The tools tab's search, open menu, new-use field and listed groups (string[]). */
      toolQuery: string
      toolMenu: string | null
      toolNaming: string | null
      toolsOpen: GemflowJson
      /** How often each tool ran, by day (UsageBook): the stored book, and what this session added since it was stored. */
      usageBook: GemflowJson
      usagePending: GemflowJson
      /** The suggestions put away (string[]). */
      dismissed: GemflowJson
      /** The last turn's judgement (Judgement), or null. */
      judged: GemflowJson
      todo: GemflowJson
      boardProblem: string | null
      setup: string | null
      startedAt: number | null
      /** Rows a person let through for this session when asked about their use's preferred tool (string[]). */
      preferPassed: GemflowJson
      /** Keys a person let through once (string[]). */
      passes: GemflowJson
      /** The prompts the person sent this session (PromptRecord[]). */
      prompts: GemflowJson
      /** The prompt whose menu is open on the sessions tab (its id). */
      turnMenu: string | null
      /** The flow the sessions tab shows (its title), and the runs of another flow's turns unfolded (string[]). */
      sessionFlow: string | null
      sessionRuns: GemflowJson
      filter: string
      expanded: string | null
      /** The journal entry whose evidence shows (its row key). */
      evidence: string | null
      dialog: string | null
      /** The settings as stored (Settings). */
      settings: GemflowJson
      /** The newest published version ({ version } or { error }), once asked. */
      latest: GemflowJson
      /** Reasons notified recently (reason → ISO). */
      notified: GemflowJson
      /** The inbox keys already notified (string[]). */
      seenInbox: GemflowJson
      locale: string | null
      /** The bundled and installed workflows ({ bundled, installed }), once asked. */
      workflows: GemflowJson
      /** The share dialog's choice ({ what, how, strip }). */
      share: GemflowJson
      version: string | null
      /** The band's attention (attention.ts): the last reply ({ reply, replyAt, asked, memory, consumed }). */
      attention: GemflowJson
      /** The repository's facts for the band ({ ahead, prs }), as the bridge last read them. */
      facts: GemflowJson
      /** The facts as they stood when the last reply ended: what changed since is news for the model. */
      factsAtReply: GemflowJson
      /** A command changed the plugin's own folder since it was loaded: a reload shows it. */
      reload: boolean
    }
  }
}
