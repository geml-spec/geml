// The Pi adapter: an extension on one side, the Supervisor on the other.
//
// Pi's extension model is an event registry, not a microkernel: `pi.on` and
// `pi.registerTool` return no disposer and there is no per-agent scope, so a
// supervision lives for a SESSION and `session_start` opens a new one (its
// `reason` says whether that is a fresh run, a resume or a fork).
//
// No gate is decided here. Design 6.5 maps them:
//   1  visibility      sup.allowedGlobals() -> pi.setActiveTools()
//   2  argument domain sup.specs()          -> registered once, at load
//   3  cut-out         sup.deny()           -> tool_call -> { block, reason }
//   4  human           sup.invoke()         -> ctx.ui.confirm(), closed if !hasUI
//   5  verb validation sup.invoke()         -> a thrown Error the model reads
//
// Two differences from DSH are structural rather than accidental, and both are
// written down in design 6.5: the `to` enum covers the whole statechart because
// a tool cannot be re-registered mid-session, and the state instruction plus
// snapshot are refreshed once per user turn (`before_agent_start`) rather than
// once per step, with each verb's own result carrying the delta in between.
import { join, resolve } from "node:path";
import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendOrCreate, exists, readText } from "../../host-fs.js";
import { hasErrors, loadStatechart, type Statechart } from "../../core/statechart.js";
import { metaFor, openRun, Supervisor, VERBS, type ApprovalGate } from "../../core/supervisor.js";
import type { ParamEntry, ParamSpec, ToolSpec } from "../../core/tools.js";
import { ledgerFromEntries, SNAPSHOT_ENTRY, type BranchEntry } from "./ledger-entries.js";

/** How gate 1 is enforced. `guard-only` trades it away to keep the prompt cache. */
export type VisibilityMode = "active-tools" | "guard-only";

/** Read from the environment at load time; see `readSettings`. */
export interface PiSettings {
  /** Absolute path of the statechart, fixed at load time. */
  statechart: string;
  visibility: VisibilityMode;
  /** Where ledgers go; when absent, next to the session files. */
  ledgerDir?: string;
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
 * above all) survives into the schema Pi validates against - so gate 2 is
 * enforced by the host, not merely described to the model.
 */
export function toTypeBox(parameters: ParamSpec): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const [name, entry] of Object.entries(parameters)) {
    properties[name] = entry.required ? entrySchema(entry) : Type.Optional(entrySchema(entry));
  }
  return Type.Object(properties);
}

/** Every target any state can reach: gate 2's domain on this host (design 6.5). */
export function everyTarget(sc: Statechart): string[] {
  return [...new Set(sc.transitions.map((t) => t.to))].sort();
}

/**
 * The three verbs as Pi registers them: one registration per verb for the whole
 * session, with the widest schema the statechart admits. Narrowing to sigma is
 * `Supervisor.invoke`'s job.
 */
export function verbSpecs(sc: Statechart): PiVerb[] {
  const widest = everyTarget(sc);
  const specs: PiVerb[] = [];

  specs.push({
    name: "agent_transition",
    description:
      "Move this workflow to its next state. Not every target below is reachable from the current state: the state instruction lists the ones that are, and a move that is not a real edge, or whose guard does not hold, is refused and nothing is recorded.",
    parameters: {
      to: {
        type: "string",
        required: true,
        description: "The target state, written without the leading #.",
        ...(widest.length ? { enum: widest } : {}),
      },
    },
  });

  // agent_set's parameters are the union of every settable variable, for the
  // same reason: the per-state narrowing happens in the verb, not the schema.
  if (sc.vars?.properties) {
    const parameters: ParamSpec = {};
    for (const [name, schema] of Object.entries(sc.vars.properties)) {
      parameters[name] = {
        type: schema.type ?? "string",
        description: schema.description ?? `the ${name} variable`,
        ...(schema.enum ? { enum: [...schema.enum] } : {}),
        ...(schema.items !== undefined ? { items: schema.items } : {}),
        ...(schema.type === "object"
          ? { properties: schema.properties ?? {}, additionalProperties: schema.additionalProperties ?? false }
          : {}),
      };
    }
    if (Object.keys(parameters).length) {
      specs.push({
        name: "agent_set",
        description:
          "Record one or more of this workflow's variables. Send only the ones you are changing; the rest keep their values. A variable this state may not write, or a value that fails the workflow's schema, is rejected and nothing is written.",
        parameters,
      });
    }
  }

  specs.push({
    name: "agent_rollback",
    description:
      'Undo workflow state: restore the variables and the state of an earlier revision. "checkpoint" returns to the revision at which the current state was entered. This undoes RECORDED state only - it cannot undo an effect a tool already had in the outside world.',
    parameters: {
      to: {
        type: "string",
        required: true,
        description: 'A revision number as a string (for example "3"), or "checkpoint".',
      },
    },
  });

  return specs;
}

export function readSettings(env: Record<string, string | undefined>): PiSettings {
  const visibility: VisibilityMode = env["GEML_AGENT_VISIBILITY"] === "guard-only" ? "guard-only" : "active-tools";
  const ledgerDir = env["GEML_AGENT_LEDGER_DIR"];
  return {
    statechart: resolve(process.cwd(), env["GEML_AGENT_STATECHART"] ?? "agent.geml"),
    visibility,
    ...(ledgerDir ? { ledgerDir } : {}),
  };
}

/**
 * The extension. Default-exported as Pi's `ExtensionFactory`.
 *
 * The statechart is read HERE, at load time, because the three verbs have to be
 * registered before the first session starts and their schemas come from it.
 * That is also why the path is an environment variable rather than a CLI flag:
 * flags are not parsed yet at this point. No statechart, no registrations and
 * no listeners - the Pi equivalent of DSH's `onMissing: skip`.
 */
export default function gemlAgent(pi: ExtensionAPI): void {
  const settings = readSettings(process.env);

  let text: string;
  try {
    text = readText(settings.statechart);
  } catch {
    return;
  }

  // No `knownTools` here, on purpose: while an extension is loading, pi agent
  // refuses every action method ("Extension runtime not initialized"), and
  // `getAllTools` is one - measured, not guessed. The statechart still has to
  // be read now, because the verbs are registered from it, so the unknown-tool
  // warning moves to `session_start`, the first moment the registry can be
  // asked at all.
  const loaded = loadStatechart(text, settings.statechart);
  if (!loaded.statechart || hasErrors(loaded.diagnostics)) {
    // Reported through Pi's own notifier rather than the console: this is a TUI,
    // and a stray write corrupts its rendering. Nothing else is registered, so a
    // statechart that does not check out supervises nothing - the Pi equivalent
    // of DSH's `onMissing: skip`, with the reason visible.
    const errors = loaded.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${settings.statechart}:${d.line}: ${d.code}: ${d.message}`);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`geml-agent: the statechart does not check out - ${errors.join(" | ")}`, "error");
    });
    return;
  }
  const sc: Statechart = loaded.statechart;

  const now = (): string => new Date().toISOString();
  /** The most recent context Pi handed us; the approval dialog needs one. */
  let current: ExtensionContext | undefined;
  let sup: Supervisor | undefined;
  let warnedAboutTools = false;
  const verbs = verbSpecs(sc);
  const verbNames = verbs.map((v) => v.name);

  /**
   * Gate 4. `hasUI` is false in print and json modes - Pi's own words are that
   * extensions run but cannot prompt - so there is no one to ask and the answer
   * is no. A throwing dialog is also no.
   */
  const approve: ApprovalGate = async (req) => {
    const ctx = current;
    if (!ctx?.hasUI) return "denied";
    try {
      return (await ctx.ui.confirm("geml-agent", req.reason)) ? "allowed-once" : "denied";
    } catch {
      return "denied";
    }
  };

  /**
   * Gate 1. Pi's active set is the whole tool list, so the verbs go back in -
   * but only the ones sigma has a use for. DSH gets this for free by not
   * registering them (`specs()` returns null for a state with no outgoing edge
   * or no writable variable); here the registration is permanent, so the active
   * set is where that narrowing has to happen. Gate 5 refuses the call either
   * way, which is what makes `guard-only` safe rather than merely quieter.
   */
  function activeVerbs(): string[] {
    if (!sup) return [];
    const specs = sup.specs();
    return verbNames.filter((n) => {
      if (n === "agent_transition") return specs.transition !== null;
      if (n === "agent_set") return specs.set !== null;
      return true;
    });
  }

  function refresh(): void {
    if (!sup || settings.visibility === "guard-only") return;
    const registered = pi.getAllTools().map((t) => t.name);
    const visibility = sup.allowedGlobals(registered);
    const verbsNow = activeVerbs();
    if (visibility.kind === "unrestricted") {
      // No opinion about the host's tools: leave the user's active set alone,
      // and own only our own names.
      const others = pi.getActiveTools().filter((n) => !verbNames.includes(n));
      pi.setActiveTools([...new Set([...others, ...verbsNow])]);
      return;
    }
    const allow = visibility.kind === "allow" ? visibility.names : [];
    pi.setActiveTools([...allow, ...verbsNow]);
  }

  pi.on("session_start", (event, ctx) => {
    current = ctx;
    sup = undefined;

    // The unknown-tool warning `check` gives offline, given once per session
    // now that the registry can be asked: a state that names a tool nobody
    // registered simply admits nothing, which is easy to mistake for a bug in
    // the gate.
    if (!warnedAboutTools) {
      warnedAboutTools = true;
      const registered = new Set(pi.getAllTools().map((t) => t.name));
      const named: string[] = [
        ...(sc.defaultTools ?? []),
        ...[...sc.states.values()].flatMap((s) => s.tools ?? []),
      ];
      const missing = [...new Set(named)].filter((n) => !registered.has(n) && !VERBS.includes(n));
      if (missing.length) {
        ctx.ui.notify(`geml-agent: the statechart names ${missing.join(", ")}, which no tool provides here`, "warning");
      }
    }

    const session = ctx.sessionManager.getSessionId();
    const dir = settings.ledgerDir ?? join(ctx.sessionManager.getSessionDir(), "geml-agent");
    const ledgerPath = join(dir, `${session}.geml`);

    // The branch, not the file, is the recovery source (design 1.3): a file
    // cannot express a tree, and a forked session inherits its parent's entries.
    const entries = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
    const fromEntries = ledgerFromEntries(entries);
    const fromFile = exists(ledgerPath) ? readText(ledgerPath) : null;
    const ledgerText = fromEntries ?? fromFile;

    const opened = openRun({
      sc,
      session,
      statechartFile: settings.statechart,
      ledgerText,
      source: event.reason,
      now: now(),
    });
    if (!opened.ok) {
      // D-B2: a ledger that contradicts itself is worse than none.
      ctx.ui.notify(`geml-agent: ${ledgerPath}: ${opened.reason}; this session is not supervised`, "error");
      return;
    }

    // Keep the invariant the tests pin: the branch's entries concatenated ARE
    // the ledger file. A fork starts with entries and no file, so the file is
    // seeded; a ledger written by another host (or an older run) starts with a
    // file and no entries, so the file becomes the first entry.
    let fileHasContent = fromFile !== null;
    if (fromEntries !== null && fromFile === null) {
      appendOrCreate(ledgerPath, "", fromEntries);
      fileHasContent = true;
    } else if (fromEntries === null && fromFile !== null) {
      pi.appendEntry(SNAPSHOT_ENTRY, { block: fromFile });
    }

    const append = (block: string): void => {
      const written = fileHasContent ? block : opened.head + block;
      appendOrCreate(ledgerPath, "", written);
      pi.appendEntry(SNAPSHOT_ENTRY, { block: written });
      fileHasContent = true;
    };

    sup = new Supervisor(sc, opened.run, {
      append,
      approve,
      now,
      changed: () => refresh(),
      notify: (summary, body) => {
        pi.sendMessage({ customType: "geml-agent", content: body, display: true, details: { summary } });
      },
    });
    sup.setNotice(opened.notice);
    for (const block of opened.blocks) append(block);
    refresh();
  });

  // Gate 3. Deny-only: there is no return value here that grants anything.
  pi.on("tool_call", (event, ctx) => {
    current = ctx;
    if (!sup) return undefined;
    const reason = sup.deny(event.toolName, event.toolCallId);
    return reason === undefined ? undefined : { block: true, reason };
  });

  // An uncontrollable event: a tool failed. Pi's tool_result carries no error
  // code, so a call for a tool that never existed cannot be told apart here -
  // but a call this supervisor blocked can, because `deny` remembered it.
  pi.on("tool_result", (event, ctx) => {
    current = ctx;
    if (!sup) return;
    sup.onToolResult(
      { name: event.toolName, callId: event.toolCallId, isError: event.isError },
      metaFor(now(), event.toolCallId),
    );
  });

  // The state's instruction and the snapshot, once per user turn. Appended to
  // the system prompt rather than sent as a message, so nothing accumulates in
  // the transcript and the model never reads a stale snapshot.
  pi.on("before_agent_start", (event, ctx) => {
    current = ctx;
    if (!sup) return undefined;
    const instruction = sup.instruction();
    const body = instruction ? `${instruction}\n\n${sup.context()}` : sup.context();
    return { systemPrompt: `${event.systemPrompt}\n\n# geml-agent\n\n${body}` };
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
        if (!sup) throw new Error("geml-agent: no statechart is supervising this session");
        const outcome = await sup.invoke(spec.name, (params ?? {}) as Record<string, unknown>, metaFor(now(), toolCallId));
        if (!outcome.ok) throw new Error(outcome.reason);
        return {
          content: [{ type: "text", text: JSON.stringify(outcome.result) }],
          details: outcome.result,
          // Pi's equivalent of DSH's exec.concludeTurn(): stop after this batch.
          ...(outcome.concludesTurn ? { terminate: true } : {}),
        };
      },
    });
  }
}
