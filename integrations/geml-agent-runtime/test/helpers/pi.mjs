// A stand-in for Pi's ExtensionAPI, faithful where it matters.
//
// Pi's extension surface is a plain object interface - no kernel, no service
// container - so a recording double is the honest way to drive the adapter.
// What the double must get right is the PIPELINE, not the API shape:
//
//   tool_call (gate 3, may block)  ->  schema validation  ->  execute  ->  tool_result
//
// The validation step uses the REAL typebox, the same library Pi validates tool
// arguments with, so gate 2's enum is enforced here by the same code that would
// enforce it in production rather than by an assertion we wrote ourselves.
//
// `test/pi-parity.test.mjs` is what keeps this double honest about the shape.
import { Value } from "typebox/value";

export function fakePi({
  tools = ["read_file", "grep", "pay_refund"],
  hasUI = true,
  confirm = async () => true,
  sessionId = "s-1",
  dir,
  branch = [],
} = {}) {
  const handlers = new Map();
  const registered = [];
  const entries = [...branch];
  const messages = [];
  const notices = [];
  const globals = tools.map((name) => ({ name, description: `The ${name} tool.`, parameters: { type: "object" } }));
  let active = globals.map((t) => t.name);
  let calls = 0;

  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      registered.push(tool);
    },
    getAllTools() {
      return [...globals, ...registered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))];
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names) {
      // Pi ignores unknown names; so does this.
      const known = new Set(pi.getAllTools().map((t) => t.name));
      active = names.filter((n) => known.has(n));
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message) {
      messages.push(message);
    },
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    events: { emit() {}, on() {} },
  };

  const ctx = {
    hasUI,
    mode: hasUI ? "tui" : "print",
    cwd: dir,
    ui: {
      confirm: (title, message) => confirm(title, message),
      notify: (message, type) => notices.push({ message, type }),
      select: async () => undefined,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => dir,
      getCwd: () => dir,
      getBranch: () => [...entries],
      getEntries: () => [...entries],
      getLeafId: () => null,
    },
    isIdle: () => true,
    signal: undefined,
    getSystemPrompt: () => "",
  };

  /** Run every handler for one event, in registration order. */
  async function emit(event, payload) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  /** One turn's prompt assembly: the system prompt chains through handlers. */
  async function prompt(text = "do the thing", systemPrompt = "BASE") {
    let current = systemPrompt;
    for (const handler of handlers.get("before_agent_start") ?? []) {
      const out = await handler(
        { type: "before_agent_start", prompt: text, systemPrompt: current, systemPromptOptions: {} },
        ctx,
      );
      if (out?.systemPrompt !== undefined) current = out.systemPrompt;
    }
    return current;
  }

  /** The tool pipeline, in Pi's order. Returns Pi's own result shape. */
  async function callTool(name, input = {}) {
    const toolCallId = `call_${++calls}`;
    const event = { type: "tool_call", toolCallId, toolName: name, input };

    for (const handler of handlers.get("tool_call") ?? []) {
      const out = await handler(event, ctx);
      if (out?.block) return finish(name, toolCallId, input, [{ type: "text", text: out.reason ?? "blocked" }], true);
    }

    const tool = registered.find((t) => t.name === name);
    if (!tool) return finish(name, toolCallId, input, [{ type: "text", text: `no such tool: ${name}` }], true);

    // What Pi does with a tool's typebox schema before calling it.
    if (!Value.Check(tool.parameters, event.input)) {
      const errors = [...Value.Errors(tool.parameters, event.input)]
        .map((e) => `${e.instancePath || "/"} ${e.keyword}: ${e.message}`);
      return finish(name, toolCallId, input, [{ type: "text", text: errors.join("; ") }], true);
    }

    try {
      const result = await tool.execute(toolCallId, event.input, undefined, undefined, ctx);
      return finish(name, toolCallId, input, result.content, false, result.details, result.terminate);
    } catch (error) {
      return finish(name, toolCallId, input, [{ type: "text", text: String(error?.message ?? error) }], true);
    }
  }

  async function finish(toolName, toolCallId, input, content, isError, details, terminate) {
    await emit("tool_result", { type: "tool_result", toolName, toolCallId, input, content, isError, details });
    return { toolName, toolCallId, content, isError, details, terminate, text: JSON.stringify(content) };
  }

  /** A global tool the supervisor is gating: gate 3 runs, the body never fails. */
  async function callGlobal(name, { fails = false } = {}) {
    const toolCallId = `call_${++calls}`;
    for (const handler of handlers.get("tool_call") ?? []) {
      const out = await handler({ type: "tool_call", toolCallId, toolName: name, input: {} }, ctx);
      if (out?.block) return finish(name, toolCallId, {}, [{ type: "text", text: out.reason ?? "blocked" }], true);
    }
    if (!globals.some((t) => t.name === name)) {
      return finish(name, toolCallId, {}, [{ type: "text", text: `no such tool: ${name}` }], true);
    }
    return fails
      ? finish(name, toolCallId, {}, [{ type: "text", text: `${name} failed` }], true)
      : finish(name, toolCallId, {}, [{ type: "text", text: `${name} ok` }], false);
  }

  return {
    pi,
    ctx,
    emit,
    prompt,
    callTool,
    callGlobal,
    start: (reason = "startup") => emit("session_start", { type: "session_start", reason }),
    activeTools: () => [...active].sort(),
    registered: () => registered.map((t) => t.name),
    schemaOf: (name) => registered.find((t) => t.name === name)?.parameters,
    entries: () => [...entries],
    messages: () => [...messages],
    notices: () => [...notices],
    has: (event) => (handlers.get(event) ?? []).length > 0,
  };
}
