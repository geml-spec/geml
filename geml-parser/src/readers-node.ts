// GEML reference parser — loading the format readers a run is handed (§3.2).
//
// A reader is code, so it comes from whoever invokes the processor — the CLI's
// `--reader <module>`, an MCP server's own arguments — and never from a
// document (§9.1). This is the Node side of that: import each module, take its
// default export's `readers` list, and refuse a set that cannot be used
// together before any document is read. Kept out of geml.ts so the browser
// bundle, which has no modules to import, never meets it.

import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { type FormatReader, readerProblems } from "./geml.js";

/** The readers the modules at `paths` export, checked against each other. */
export async function loadReaders(paths: readonly string[]): Promise<FormatReader[]> {
  const out: FormatReader[] = [];
  for (const p of paths) {
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(resolvePath(p)).href);
    } catch (e) {
      throw new Error(`--reader ${p}: cannot load it (${e instanceof Error ? e.message : String(e)})`);
    }
    const list = (mod as { default?: { readers?: unknown } } | null)?.default?.readers;
    if (!Array.isArray(list)) throw new Error(`--reader ${p}: its default export has no \`readers\` list`);
    out.push(...(list as FormatReader[]));
  }
  const problems = readerProblems(out);
  if (problems.length > 0) throw new Error(`--reader: ${problems.join("; ")}`);
  return out;
}

/**
 * `args` with every `--reader <module>` pair taken out, and the modules they
 * named. The pairs are the run's, not a verb's: lifting them before a verb
 * reads its own arguments keeps a module path from being taken for a file.
 */
export function liftReaderFlags(args: readonly string[]): { args: string[]; paths: string[] } | { error: string } {
  const rest: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { rest.push(...args.slice(i)); break; }
    if (a === "--reader") {
      const p = args[i + 1];
      if (p === undefined || p.startsWith("-")) return { error: "--reader needs a module path" };
      paths.push(p);
      i++;
      continue;
    }
    if (a.startsWith("--reader=")) return { error: `--reader takes its module as the next argument: --reader ${a.slice("--reader=".length)}` };
    rest.push(a);
  }
  return { args: rest, paths };
}
