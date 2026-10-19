// The Pi adapter: an extension on one side, the Supervisor on the other.
//
// Pi's extension model is an event registry, not a microkernel: `pi.on` and
// `pi.registerTool` return no disposer and there is no per-agent scope, so a
// supervision lives for a SESSION and `session_start` opens a new one (its
// `reason` says whether that is a fresh run, a resume or a fork).
//
// No gate is decided here. The supervisor answers (core/supervisor.ts) and
// this module only translates:
//   before a call     sup.gate()            -> tool_call -> { block, reason }, or nothing
//   the verbs' shape  verbSpecs()           -> registered once, at load, with the widest schema the workflow admits
//   a verb            sup.invoke()          -> a thrown Error the model reads
//   a finished call   sup.observeCommand()  -> tool_result: a command's error as its exit status, another tool's error
//
// One difference from DSH is structural: `move`'s `to` enum covers the whole
// workflow because a tool cannot be re-registered mid-session, and the state
// instruction plus snapshot are refreshed once per user turn
// (`before_agent_start`) rather than once per step, with each verb's own
// result carrying the delta in between.
import { dirname, join } from "node:path";
import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendOrCreate, exists, readText, realPath } from "../../host-fs.js";
import { readDictionaryFile } from "../../dictionary-io.js";
import { commandOf } from "../../core/command-line.js";
import { PI_TOOLS } from "../../core/host-tools.js";
import { writtenProjectPath } from "../../core/written.js";
import { hasErrors, loadStatechart, modelVars, type Statechart } from "../../core/statechart.js";
import { metaFor, openRun, Supervisor } from "../../core/supervisor.js";
import { toParamEntry, type ParamEntry, type ParamSpec, type ToolSpec } from "../../core/tools.js";
import { journalFromEntries, SNAPSHOT_ENTRY, type BranchEntry } from "./journal-entries.js";
import { docReader, resolveWorkflow } from "../../workspace.js";

/** Read from the environment at load time; see `readSettings`. */
export interface PiSettings {
  /**
   * The active workflow, resolved at load time as `gemflow` resolves it
   * (`GEMFLOW_STATECHART`, else the workflow the project's `.geml/project.geml`
   * names, else its only workflow, `.geml/workflows/<name>.geml` in the
   * project's home): its file, absolute, or why there is none.
   */
  workflow: ReturnType<typeof resolveWorkflow>;
  /** Where journals go; when absent, next to the session files. */
  journalDir?: string;
}

/** One verb as Pi registers it. Pi has no output schema, so ToolSpec's is dropped. */
export type PiVerb = Pick<ToolSpec, "name" | "description" | "parameters">;

/** One ParamEntry as JSON Schema, wrapped so TypeBox validates it verbatim. */
function entrySchema(entry: ParamEntry): TSchema {
  const schema: Record<string, unknown> = { type: entry.type, description: entry.description };
  if (entry.enum) schema["enum"] = [...entry.enum];
  if (entry.items !== undefined) schema["items"] = entry.items;
  if (entry.properties !== undefined) schema["properties"] = entry.properties;
  if (entry.additionalProperties !== undefined) schema["additionalProperties"] = entry.additionalProperties;
  return Type.Unsafe(schema);
}

/**
 * A ToolSpec's parameters as TypeBox, which is what Pi registers tools with.
 * The projection is exact: `required` becomes TypeBox's required list, anything
 * else becomes `Type.Optional`, and every keyword the core spec set (`enum`
 * above all) survives into the schema Pi validates against - so the shape is
 * enforced by the host, not merely described to the model.
 */
export function toTypeBox(parameters: ParamSpec): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const [name, entry] of Object.entries(parameters)) {
    properties[name] = entry.required ? entrySchema(entry) : Type.Optional(entrySchema(entry));
  }
  return Type.Object(properties);
}

/** Every target any state can reach: move's domain on this host. */
export function everyTarget(sc: Statechart): string[] {
  return [...new Set(sc.transitions.map((t) => t.to))].sort();
}

/**
 * The three verbs as Pi registers them: one registration per verb for the whole
 * session, with the widest schema the workflow admits. Narrowing to the state
 * is `Supervisor.invoke`'s job.
 */
export function verbSpecs(sc: Statechart): PiVerb[] {
  const widest = everyTarget(sc);
  const specs: PiVerb[] = [
    {
      name: "gemflow_status",
      description: "Where the workflow stands: the state, the variables, the ways out and whether their guards hold, and the stage's own text. Read-only.",
      parameters: {},
    },
    {
      name: "gemflow_move",
      description:
        "Take a transition out of the current state: one whose guard is a sentence you judge, or one with no guard. Not every target below is reachable from the current state — the stage text lists the ones that are; a machine-judged transition is taken on its own when its guard holds, and one that needs a person is theirs. A move that is not a transition is refused and nothing is recorded.",
      parameters: {
        to: { type: "string", required: true, description: "The target state, written without the leading #.", ...(widest.length ? { enum: widest } : {}) },
      },
    },
  ];
  // set's parameters are the union of every variable the model may write.
  const names = modelVars(sc);
  if (names.length) {
    const parameters: ParamSpec = {};
    for (const name of names) {
      const schema = sc.varsSchema.properties?.[name];
      if (schema) parameters[name] = toParamEntry(name, schema);
    }
    specs.push({
      name: "gemflow_set",
      description: "Record one or more of this workflow's variables. Send only the ones you are changing; the rest keep their values. A variable with a source is evidence and not yours; a value of the wrong type is rejected and nothing is written.",
      parameters,
    });
  }
  return specs;
}

/** `cwd` is the directory Pi was started in: the project the workflow is looked for in. */
export function readSettings(env: Record<string, string | undefined>, cwd: string = process.cwd()): PiSettings {
  const journalDir = env["GEMFLOW_JOURNAL_DIR"];
  return {
    workflow: resolveWorkflow(cwd, env),
    ...(journalDir ? { journalDir } : {}),
  };
}

/**
 * The extension. Default-exported as Pi's `ExtensionFactory`.
 *
 * The workflow is read HERE, at load time, because the three verbs have to be
 * registered before the first session starts and their schemas come from it.
 * That is also why the workflow is found from the environment and the working
 * directory rather than a CLI flag: flags are not parsed yet at this point. No
 * workflow, no registrations and no tool listeners - the Pi equivalent of DSH's
 * `onMissing: skip`. No workflow at all is just as quiet: most projects an
 * installed extension meets do not use gemflow, and a notice on every session
 * would be noise. Several workflows with none chosen, or one named wrongly, is
 * a setup to fix, and each session says so.
 */
export default function gemflow(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const settings = readSettings(process.env, cwd);
  if ("error" in settings.workflow) {
    const { error, kind } = settings.workflow;
    if (kind !== "none") {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.notify(`gemflow: ${error}; this session is not supervised`, "warning");
      });
    }
    return;
  }
  const file = settings.workflow.path;
  const workflowDir = dirname(file);

  let text: string;
  try {
    text = readText(file);
  } catch {
    return;
  }

  const loaded = loadStatechart(text, file, { readDoc: docReader(workflowDir, cwd) });
  if (!loaded.statechart || hasErrors(loaded.diagnostics)) {
    // Reported through Pi's own notifier rather than the console: this is a TUI,
    // and a stray write corrupts its rendering. Nothing else is registered, so a
    // workflow that does not check out supervises nothing - the Pi equivalent
    // of DSH's `onMissing: skip`, with the reason visible.
    const errors = loaded.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${file}:${d.line}: ${d.code}: ${d.message}`);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`gemflow: the workflow does not check out - ${errors.join(" | ")}`, "error");
    });
    return;
  }
  const sc: Statechart = loaded.statechart;

  const now = (): string => new Date().toISOString();
  /** The most recent context Pi handed us; the question to the person needs one. */
  let current: ExtensionContext | undefined;
  let sup: Supervisor | undefined;
  const verbs = verbSpecs(sc);

  pi.on("session_start", (event, ctx) => {
    current = ctx;
    sup = undefined;

    const session = ctx.sessionManager.getSessionId();
    const dir = settings.journalDir ?? join(ctx.sessionManager.getSessionDir(), "gemflow");
    const journalPath = join(dir, `${session}.geml`);

    // The branch, not the file, is the recovery source: a file cannot express
    // a tree, and a forked session inherits its parent's entries.
    const entries = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
    const fromEntries = journalFromEntries(entries);
    const fromFile = exists(journalPath) ? readText(journalPath) : null;
    const journalText = fromEntries ?? fromFile;

    const opened = openRun({
      sc,
      item: `session:${session}`,
      workflowFile: file,
      journalText,
      source: event.reason,
      now: now(),
    });
    if (!opened.ok) {
      // A journal that contradicts itself is worse than none.
      ctx.ui.notify(`gemflow: ${journalPath}: ${opened.reason}; this session is not supervised`, "error");
      return;
    }

    // Keep the invariant the tests pin: the branch's entries concatenated ARE
    // the journal file. A fork starts with entries and no file, so the file is
    // seeded; a journal written by another host (or an older run) starts with a
    // file and no entries, so the file becomes the first entry.
    let fileHasContent = fromFile !== null;
    if (fromEntries !== null && fromFile === null) {
      appendOrCreate(journalPath, "", fromEntries);
      fileHasContent = true;
    } else if (fromEntries === null && fromFile !== null) {
      pi.appendEntry(SNAPSHOT_ENTRY, { block: fromFile });
    }

    const append = (block: string): void => {
      const written = fileHasContent ? block : opened.head + block;
      appendOrCreate(journalPath, "", written);
      pi.appendEntry(SNAPSHOT_ENTRY, { block: written });
      fileHasContent = true;
    };

    sup = new Supervisor(sc, opened.run, {
      append,
      now,
      tools: PI_TOOLS,
      // Read afresh for every decision: the person's answers go into the file.
      get dictionary() {
        return readDictionaryFile(file, sc);
      },
    });
    sup.setNotice(opened.notice);
    for (const block of opened.blocks) append(block);
  });

  // The gate before a call (spec §5.3). Deny-only: there is no return value
  // here that grants anything. A call no row of the dictionary takes goes
  // through; whether it is safe is pi's to judge, not the workflow's.
  pi.on("tool_call", async (event, ctx) => {
    current = ctx;
    if (!sup) return undefined;
    const input = event.input as Record<string, unknown>;
    const gate = sup.gate(event.toolName, event.toolCallId, input);
    if (gate.kind === "allow") return undefined;
    return { block: true, reason: gate.reason };
  });

  // A finished call is evidence for the use its key is bound to. Pi's result
  // carries no exit status, so a command that errored reads as exit 1 and a
  // clean one as 0. A file a write tool wrote is what the work made.
  pi.on("tool_result", (event, ctx) => {
    current = ctx;
    if (!sup) return;
    const meta = metaFor(now(), event.toolCallId);
    const input = event.input as Record<string, unknown>;
    if (PI_TOOLS.run.includes(event.toolName)) {
      const command = commandOf(input);
      if (command !== undefined) sup.observeCommand({ command, exitCode: event.isError ? 1 : 0 }, meta);
    } else sup.observeCall(event.toolName, input, !event.isError, meta);
    const written = PI_TOOLS.write.includes(event.toolName) && !event.isError ? writtenProjectPath(input, cwd, realPath) : undefined;
    if (written !== undefined) sup.recordWrite(event.toolName, written, event.toolCallId);
  });

  // The state's instruction and the snapshot, once per user turn. Appended to
  // the system prompt rather than sent as a message, so nothing accumulates in
  // the transcript and the model never reads a stale snapshot.
  pi.on("before_agent_start", (event, ctx) => {
    current = ctx;
    if (!sup) return undefined;
    // The clock's evidence, once per user turn: a stage held long enough moves on before the model reads it.
    sup.elapse(metaFor(now()));
    const instruction = sup.instruction();
    const body = instruction ? `${instruction}\n\n${sup.context()}` : sup.context();
    return { systemPrompt: `${event.systemPrompt}\n\n# gemflow\n\n${body}` };
  });

  for (const spec of verbs) {
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: toTypeBox(spec.parameters),
      execute: async (
        toolCallId: string,
        params: unknown,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<AgentToolResult<unknown>> => {
        current = ctx;
        if (!sup) throw new Error("gemflow: no workflow is supervising this session");
        if (spec.name === "gemflow_status") {
          const textOut = `${sup.instruction()}\n\n${sup.context()}`;
          return { content: [{ type: "text", text: textOut }], details: { text: textOut } };
        }
        const outcome = sup.invoke(spec.name, (params ?? {}) as Record<string, unknown>, metaFor(now(), toolCallId));
        if (!outcome.ok) throw new Error(outcome.reason);
        return { content: [{ type: "text", text: JSON.stringify(outcome.result) }], details: outcome.result };
      },
    });
  }
}
