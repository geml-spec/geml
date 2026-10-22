// What a press on the band or the board means (spec §8.2): one union the hooks
// module switches on. Node-free: the pure modules build these, the hooks
// module runs them — through the bridge, the engine's `$`, or its own state.
import type { Lesson } from "../../core/dictionary.js";

export type BoardTab = "sessions" | "flow" | "items" | "journal" | "tools";
export type JournalFilter = "all" | "artifacts" | "evidence" | "moves" | "refusals" | "depends";
export type Dialog = "settings" | "upgrade" | "about" | "share";
/** What the share dialog shares, and how. */
export type ShareWhat = "status" | "journal" | "session" | "workflow";
export type ShareHow = "copy" | "file" | "pr";

/** The question a press that cannot be taken back asks before it acts, and the word that says yes. */
export interface Confirm { question: string; yes: string }

export type BoardAction =
  /**
   * A person's way out. `file`: the work item it is taken on, under a `file:`
   * unit, when that is not the current one. `say`: what the person chose, in
   * their words, sent into the conversation once it is taken, so the model
   * hears of it.
   */
  | { op: "advance"; to: string; file?: string; say?: string }
  | { op: "mark"; variable: string; checked: boolean }
  | { op: "bind"; id: string }
  | { op: "refresh" }
  | { op: "pause" }
  | { op: "resume" }
  /** A person's word about keys, into the dictionary. */
  | { op: "learn"; lessons: Lesson[]; confirm?: Confirm }
  /** Let the next call judged on these keys through, once; nothing is learned. */
  | { op: "pass-once"; keys: string[] }
  /** Start the bridge again after a failure. */
  | { op: "retry" }
  /** Show a tab; the journal's with `filter`. */
  | { op: "tab"; tab: BoardTab; filter?: JournalFilter }
  | { op: "filter"; filter: JournalFilter }
  /** Open one journal entry's menu (its key), or close it. */
  | { op: "expand"; entry: string | null }
  /** Show one journal entry's evidence under it (its key), or none. */
  | { op: "evidence"; entry: string | null }
  /** A person takes the work item back to an earlier revision: the recorded state and variables only, never what was done. */
  | { op: "rollback"; rev: number }
  /** Show one state of the flow below the picture: its uses and tools. */
  | { op: "flow-state"; id: string }
  /** Open the list of workflows to switch to, or close it. */
  | { op: "flow-switch"; open: boolean }
  /** Open a tool row's menu (its key), or close it. */
  | { op: "tool-menu"; key: string | null }
  /** Show the field that names a new use for a tool (its key), or hide it. */
  | { op: "tool-name"; key: string | null }
  /** What the tools tab is narrowed to, as typed. */
  | { op: "tool-search"; query: string }
  /** List a group's tools that did not run, or fold them. */
  | { op: "tool-fold"; group: string; open: boolean }
  /** Ask for the newest version again. */
  | { op: "check-update" }
  /** Make a new work item's file (a matter) and put away the suggestion it answers. */
  | { op: "new-item"; path: string; title: string; text: string; dismiss?: string }
  /** The turn's judgement: take what it picked, drop it, or take back what it took. */
  | { op: "judge-yes" }
  /** Take the judgement's n-th other likely pick instead. */
  | { op: "judge-pick"; n: number }
  | { op: "judge-no" }
  | { op: "judge-undo" }
  /** Put a suggestion away: it is not asked again. */
  | { op: "dismiss"; key: string }
  /** Bring a card put away back (a branch held back, from 已暂缓): nothing is said. */
  | { op: "undismiss"; key: string }
  /** List the closed (or the dropped) work items, or only count them; list every document the work item changed, or the newest two. */
  | { op: "fold"; what: "done" | "dropped" | "docs" | "held"; open: boolean }
  /** Open the menu under an artifact (`<kind>:<name>`), or close it. */
  | { op: "artifact-menu"; key: string | null }
  /** Close a merged work item: its worktree and its local branch removed, by the model, once the person said yes. */
  | { op: "close-item"; id: string; worktree?: string }
  /** On the sessions tab: a session's record written as GEML where the press asks — `own`, or another session's id. */
  | { op: "export"; session: string }
  | { op: "dialog"; dialog: Dialog | null }
  | { op: "open-board"; tab?: BoardTab }
  | { op: "use"; workflow: string }
  | { op: "add"; workflow: string }
  /** Write a workflow directory or file from a path into the project's .geml/workflows/. */
  | { op: "import"; path: string }
  | { op: "setting"; key: string; value: string | boolean }
  | { op: "copy"; text: string }
  /** Words sent into the conversation as the person's own, as if typed: an answer on the band, a step it offers; `dismiss` puts its card away first (a branch held back), `toast` says where it went. */
  | { op: "say"; text: string; confirm?: Confirm; dismiss?: string; toast?: string }
  /** One answer of several asked in one reply, the `index`-th: kept until every one is answered, then all said in one prompt. */
  | { op: "pick"; index: number; answer: string }
  /** A slash command run as if the person typed it (`/reload-plugins`), once the session is idle. */
  | { op: "command"; command: string }
  /** Another session's decision put in the prompt box, so the next prompt names it. */
  | { op: "use-decision"; text: string; from: string }
  /** Unfold another session's turns on the session tab (its id), or fold them. */
  | { op: "session-open"; id: string | null }
  /** The sessions tab: list every other session, or fold the rest after the first few. */
  | { op: "sessions-more"; all: boolean }
  /** The sessions tab: draw thirty more of this session's turns. */
  | { op: "turns-more" }
  /** Show a turn's whole prompt and answer on the session tab (its prompt's id), or fold it. */
  | { op: "expand-turn"; id: string | null }
  /** Show the session's prompts of one flow (its title), or all. */
  | { op: "session-flow"; flow: string | null }
  /** Unfold a run of turns in another flow (its first prompt's id), or fold it. */
  | { op: "session-run"; id: string; open: boolean }
  /** Scroll the conversation to this prompt's row. */
  | { op: "locate"; id: string; uuid?: string }
  /** Ask the model to move this prompt's turn and every turn after it (the last one stays) into a new session, with the split-session skill; a person says yes first. */
  | { op: "split"; id: string }
  /** Ask the model to move this prompt's one turn into a session of its own, with the split-session skill; a person says yes first. */
  | { op: "remove"; id: string }
  /** Under a `file:` unit, make this file the current work item (the shell's last written file). */
  | { op: "switch-file"; file: string; say?: string }
  | { op: "share"; what: ShareWhat; how: ShareHow; strip: boolean };

/** A button as the pure modules describe it: its address, its label, whether it is the main one, and what it does. */
export interface Pressable { key: string; label: string; primary?: boolean; action: BoardAction; /** A menu entry's weight: one that destroys, one that only closes. */ tone?: "danger" | "quiet" }
