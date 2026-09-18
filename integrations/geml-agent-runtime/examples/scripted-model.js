// A model that does not exist: a pi agent provider whose "stream" replays a
// fixed script of tool calls, read from the JSON file named by
// `GEML_DEMO_SCRIPT`.
//
// Everything else in the run is real — pi agent's own agent loop, its tool
// pipeline (the `bash` calls really run), its session persistence, and the
// supervisor extension beside this one. Only the LLM is replaced, so a
// walkthrough needs no API key and produces the same ledger every time. Point
// `--model` at a real provider instead and the same statechart governs a real
// model; nothing in the supervisor knows the difference.
//
// It also records, for every turn, the tool names the model was actually
// offered. That list IS gate 1 seen from the model's side: what reached the
// request, not what we hoped had.
import { readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const SCRIPT = JSON.parse(readFileSync(process.env["GEML_DEMO_SCRIPT"], "utf8"));
const TRACE = process.env["GEML_DEMO_TRACE"];
const trace = [];
const schemas = [];

export default function scriptedModel(pi) {
  pi.registerProvider("stub", {
    name: "scripted stub",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "not-used",
    api: "anthropic-messages",
    models: [{
      id: "script",
      name: "Scripted walkthrough (no network)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      // One stream call per assistant turn, so the number of assistant
      // messages already in the context is this turn's index.
      const turn = context.messages.filter((m) => m.role === "assistant").length;
      const step = SCRIPT[turn] ?? { why: "off the end of the script", text: "(script exhausted)" };
      const offered = (context.tools ?? []).map((t) => t.name).sort();

      // The tools as the request carries them, schemas and all. Set
      // GEML_DEMO_TOOLS to see what a state actually offers the model - it is
      // also how the scripts here were written against pi agent's real
      // parameter names rather than against a guess at them.
      if (process.env["GEML_DEMO_TOOLS"]) {
        schemas.push({ turn, tools: context.tools ?? [] });
        writeFileSync(process.env["GEML_DEMO_TOOLS"], `${JSON.stringify(schemas, null, 2)}\n`);
      }

      trace.push({
        turn,
        why: step.why,
        toolsOffered: offered,
        does: step.call ? `${step.call[0]} ${JSON.stringify(step.call[1])}` : "text",
      });
      if (TRACE) writeFileSync(TRACE, `${JSON.stringify(trace, null, 2)}\n`);

      const message = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };

      (async () => {
        stream.push({ type: "start", partial: message });

        if (step.call) {
          const [name, args] = step.call;
          const toolCall = { type: "toolCall", id: `call_${turn}`, name, arguments: args };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
        } else {
          message.content.push({ type: "text", text: step.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message });
          message.stopReason = "stop";
        }

        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })();

      return stream;
    },
  });
}
