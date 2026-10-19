// `gemflow mcp`: the three model verbs (spec §8.5) over stdio MCP, for hosts
// with no Gemflow shell of their own (Codex, Grok, Gemini CLI, …). JSON-RPC
// 2.0, one message per line: initialize, ping, tools/list, tools/call. Each
// call opens the workspace fresh, so the server shares a project with the CLI
// and any other host. A verb that changes the stage appends the new #current
// text to its result: these hosts have no other channel for it. Nothing on
// such a host shows Gemflow its tool calls, so `status` reads git and the
// file variables afresh before it answers; `tool` evidence is never observed
// here, the dictionary never asked, and no call refused: every stage text this
// server returns ends with a line saying so.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { HOST_TOOLS, NO_TOOLS } from "./core/host-tools.js";
import { FLOW_TOOLS } from "./core/verb-specs.js";
import { NOTE_TOOL } from "./core/session-log.js";
import { latestSessionOf, recordDecisions } from "./session-store.js";
import { ghOncePerBranch } from "./host-git.js";
import { runVerb } from "./verbs.js";
import { openWorkspace } from "./workspace.js";

/** The package's version, read when a client asks: the bundle starts without a package.json beside it (the bundle test copies it alone). */
function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
const PROTOCOLS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

export interface McpOptions { root: string; host: string }
type Reply = Record<string, unknown>;

const result = (id: unknown, value: unknown): Reply => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (id: unknown, body: string, isError: boolean): Reply => result(id, { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) });

/** Closes every stage text this server returns: this host shows Gemflow no tool calls, so the tools a stage lists are advice, and `tool` evidence is never written here. */
const NO_ENFORCEMENT_NOTE = "(this host shows Gemflow no tool calls: nothing is refused here, and a variable whose source is a tool is never written — tell the person what you ran, so they can tick a variable the guard accepts)";
const withNote = (stage: string): string => `${stage}\n\n${NO_ENFORCEMENT_NOTE}`;

/** One parsed message in; the reply, or undefined for a notification. */
export async function answer(msg: unknown, o: McpOptions): Promise<Reply | undefined> {
  const m = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
  const id = m?.id ?? null;
  const method = m?.method;
  if (typeof method !== "string") return failure(id, -32600, "invalid request: `method` is required");
  if (method.startsWith("notifications/")) return undefined;
  if (method === "initialize") {
    const asked = m?.params?.["protocolVersion"];
    const version = typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[PROTOCOLS.length - 1];
    return result(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "gemflow", version: packageVersion() } });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: [...FLOW_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), { name: NOTE_TOOL.name, description: NOTE_TOOL.description, inputSchema: NOTE_TOOL.inputSchema }] });
  if (method !== "tools/call") return failure(id, -32601, `method not found: ${method}`);
  const name = m?.params?.["name"];
  // The note: this host's session that asked last (an MCP server is told no session; a host with hooks names it in the record), else one of the server's own.
  if (name === NOTE_TOOL.name) {
    const given = (m?.params?.["arguments"] as { decisions?: unknown } | undefined)?.decisions;
    const decisions = Array.isArray(given) ? given.filter((d): d is string => typeof d === "string") : [];
    try {
      const session = latestSessionOf(o.root, o.host) ?? `mcp-${process.pid}`;
      const n = recordDecisions(o.root, o.host, session, decisions);
      return text(id, n === 0 ? "Nothing recorded: decisions is a list of short sentences." : `Recorded ${n} decision${n === 1 ? "" : "s"}; the project's other sessions will see ${n === 1 ? "it" : "them"}.`, n === 0);
    } catch (e) {
      return text(id, `gemflow: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  const spec = FLOW_TOOLS.find((t) => t.name === name);
  if (spec === undefined) return failure(id, -32602, `unknown tool: ${String(name)}`);
  const raw = m?.params?.["arguments"];
  const args = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  try {
    // A host name is looked up as a key of its own, never as a property every object has (`constructor`).
    const opened = openWorkspace({ root: o.root, tools: Object.hasOwn(HOST_TOOLS, o.host) ? HOST_TOOLS[o.host]! : NO_TOOLS, gh: ghOncePerBranch() });
    if (!opened.ok) return text(id, `gemflow: ${opened.reason}`, true);
    // The one moment an MCP-only host lets Gemflow look: a merged PR or a file written since the last call may move the stage now; `status` then reports the stage it moved to.
    if (spec.name === "status") opened.ws.refresh();
    const a = runVerb(opened.ws, spec.name, args);
    return text(id, spec.name === "status" ? withNote(a.text) : a.context !== undefined ? `${a.text}\n\n${withNote(a.context)}` : a.text, !a.ok);
  } catch (e) {
    // A journal that cannot be read, a lock held past its timeout, a verb that kept conflicting: one line, never a crash.
    const message = e instanceof Error ? e.message : String(e);
    return text(id, message.startsWith("gemflow:") ? message : `gemflow: ${message}`, true);
  }
}

/** Serve stdin to stdout, one message at a time and in order; resolves when stdin closes and every answer is out. */
export function serveMcp(o: McpOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      const t = line.trim();
      if (t === "") return;
      let msg: unknown;
      try {
        msg = JSON.parse(t);
      } catch {
        process.stdout.write(`${JSON.stringify(failure(null, -32700, "parse error"))}\n`);
        return;
      }
      const reply = await answer(msg, o);
      if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
  return new Promise((resolveDone) => {
    rl.on("close", () => {
      void chain.then(() => resolveDone());
    });
  });
}
