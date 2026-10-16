// One real DSH agent with real tools, for tests that must exercise the actual
// tool pipeline rather than a stand-in. No model is involved: tool calls go in
// through `ctx.tools.execute`, which is the same pipeline the loop dispatches
// through — pre-execute, the monotonic guards, the body, post-execute.
import { Context } from "@deepseek-ai/cordis";
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { brandString } from "@deepseek-ai/dsh-brand";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stand up a context, a real agent, and a few global tools.
 * @param tools names to register globally
 * @param failing which of them throw when called
 */
export async function world({ tools = ["read_file", "grep", "pay_refund"], failing = [] } = {}) {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  const harness = await mountAgentLoopTestHarness(ctx);

  for (const name of tools) {
    ctx.tools.register(defineTool({
      name,
      description: `The ${name} tool.`,
      // No `required: false` — DSH accepts `required` only as `true`, and an
      // optional parameter simply omits it.
      parameters: { x: { type: "string", description: "anything" } },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        if (failing.includes(name)) throw new Error(`${name} failed`);
        return `${name} ok`;
      },
    }));
  }

  const dir = mkdtempSync(join(tmpdir(), "geml-agent-plugin-"));
  const agent = await harness.create(SessionId("t-" + Math.random().toString(36).slice(2, 8)), {}, { cwd: dir });

  let n = 0;
  const call = (name, args = {}) => ctx.tools.execute({
    callId: brandString(`c${++n}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });
  const visible = () => ctx.tools.schemas(agent).map((s) => s.name).sort();
  const schemaOf = (name) => ctx.tools.schemas(agent).find((s) => s.name === name);
  const dispose = async () => {
    await ctx.root.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  };

  return { ctx, agent, dir, call, visible, schemaOf, dispose };
}
