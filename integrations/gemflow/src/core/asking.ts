// What a host asks a person about a call, and what the answer writes into the
// dictionary (spec §5.3, preferences). Gemflow asks about one thing only: a
// tool bound to a use that is not the use's preferred tool. Whether a command
// nobody classified is safe to run is the host's permission system's call,
// not a question Gemflow puts. Text in, lessons out; every host that can ask
// asks with these words, so the dictionary learns the same thing whichever
// host the person answered on. Node-free: the hooks module imports it.
import type { Lesson } from "./dictionary.js";

/** What an answer means for the call: let it through, write lessons and judge again, or refuse it as it stands. */
export type Answered = { kind: "pass" } | { kind: "learn"; lessons: Lesson[] } | { kind: "deny"; reason: string };

export interface Question { question: string; options: string[] }

const PREFER_ONCE = "这次允许";
const PREFER_DEFAULT = "以后默认用它";
const DENY = "拒绝";

/** The question for a tool that is bound to a use but is not the use's preferred tool. */
export function preferQuestion(key: string, use: string, preferredTool: string): Question {
  return { question: `gemflow：${use} 的首选是 ${preferredTool}，这次用 ${key}？`, options: [PREFER_ONCE, PREFER_DEFAULT, DENY] };
}

export function preferAnswer(answer: string | undefined, key: string, use: string, preferredTool: string): Answered {
  if (answer === PREFER_DEFAULT) return { kind: "learn", lessons: [{ kind: "default", key, use }] };
  if (answer === DENY) return { kind: "deny", reason: `use ${preferredTool} for ${use}, the preferred tool` };
  return { kind: "pass" };
}
