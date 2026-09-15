// geml-code-graph tree-sitter export — the SYNTAX half of the fallback indexer.
//
//   GEML_SRC=<repo root> GEML_OUT=<raw dir> GEML_LANG=zig \
//     npx -y -p web-tree-sitter@<pin> -p tree-sitter-wasms@<pin> node treesitter-export.mjs
//
// Loads the language profile (codemap/treesitter/<lang>.mjs), parses every
// source file of that language with the grammar's wasm, and writes three raw
// JSONL tables plus meta.json into GEML_OUT:
//   defs.jsonl      {file, name, container:[…], pub, lineStart, lineEnd}
//   bindings.jsonl  {file, name, kind:import|alias|struct|self, target?, path?, scope:[…], line}
//   calls.jsonl     {file, line, caller:{name, container}, callee:[…segments]}
//   meta.json       {lang, files, parseErrors, defs, bindings, calls}
// Nothing here resolves a name or judges a confidence — that is
// codemap/adapters/treesitter.mjs, which reads these tables without ever
// touching the wasm. Same split as Joern's joern-export.sc → adapters/joern.mjs,
// so `refresh` replays this step like any other recorded indexer.
//
// The two libraries come from npx (or, in a checkout, from devDependencies) via
// codemap/npx-require.mjs. web-tree-sitter is pinned to 0.25.x on purpose: the
// grammar bundle was built by tree-sitter-cli 0.20, whose wasm carries the
// legacy `dylink` section; 0.27 accepts only `dylink.0` and refuses to load it,
// while 0.20–0.25 load both (verified). Anything newer than the code — a Zig
// release the grammar has not caught up with — shows up as parse errors, which
// are counted and reported, never hidden.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { collectSourceFiles } from "./detect.mjs";
import { makeExcluder } from "./exclude.mjs";
import { makeNpxResolver } from "./npx-require.mjs";

// A profile name is a file under codemap/treesitter/ — env-controlled, so it
// is validated before it can shape an import path.
const LANG_RE = /^[a-z][a-z0-9_-]*$/;
export const PROFILES = ["zig"];

export async function loadProfile(lang) {
  if (!LANG_RE.test(String(lang))) throw new Error(`GEML_LANG "${lang}" is not a profile name (have: ${PROFILES.join(", ")})`);
  try {
    return await import(`./treesitter/${lang}.mjs`);
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND") throw new Error(`GEML_LANG "${lang}": no tree-sitter profile (have: ${PROFILES.join(", ")})`);
    throw e;
  }
}

export async function loadGrammar(profile, resolver) {
  const ts = resolver("web-tree-sitter");
  if (!ts) throw new Error("cannot resolve web-tree-sitter — run this script via the npx recipe the build records (npx -y -p web-tree-sitter@… -p tree-sitter-wasms@… node treesitter-export.mjs)");
  const Parser = ts.Parser ?? ts.default ?? ts;
  await Parser.init();
  const Language = ts.Language ?? Parser.Language;
  let wasmPath = null;
  for (const cand of profile.wasm) { wasmPath = resolver.path(cand); if (wasmPath) break; }
  if (!wasmPath) throw new Error(`cannot resolve a ${profile.lang} grammar wasm (tried ${profile.wasm.join(", ")})`);
  const language = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, language, wasmPath };
}

// Parse every <lang> file under `src` (same walk + exclusions as detect/build)
// and write the raw tables into `out`. Returns the meta record.
export async function runExport({ src, out, lang, excludeGlobs = [], gitignore = true, resolver, log = console.error }) {
  const srcAbs = resolve(src);
  const outAbs = resolve(out);
  const profile = await loadProfile(lang);
  resolver ??= makeNpxResolver(srcAbs, import.meta.url);
  const { parser } = await loadGrammar(profile, resolver);

  const { files } = collectSourceFiles(srcAbs);
  const excluder = makeExcluder({ root: srcAbs, globs: excludeGlobs, gitignore, files, run: execFileSync });
  const mine = files.filter((f) => profile.exts.includes(f.slice(f.lastIndexOf(".") + 1).toLowerCase()) && !excluder(f));

  const defs = [], bindings = [], calls = [];
  let parseErrors = 0;
  for (const file of mine) {
    const text = readFileSync(join(srcAbs, ...file.split("/")), "utf8");
    const tree = parser.parse(text);
    const root = tree.rootNode;
    if (root.hasError) parseErrors++;
    for (const d of profile.definitions(root)) defs.push({ file, ...d });
    for (const b of profile.bindings(root, file)) bindings.push({ file, ...b });
    for (const c of profile.calls(root)) {
      if (!c.caller) continue; // file scope / test block: no node to hang the edge on
      // An `@import("x.zig").f()` head becomes a file (or a package) here, so
      // the adapter never needs the profile's import rule.
      const head = c.callee[0];
      if (head.startsWith("@import:")) {
        const target = profile.importTarget(head.slice("@import:".length), file);
        c.callee[0] = target ? `@file:${target}` : `@pkg:${head.slice("@import:".length)}`;
      }
      calls.push({ file, ...c });
    }
    tree.delete?.();
  }

  mkdirSync(outAbs, { recursive: true });
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(join(outAbs, "defs.jsonl"), jsonl(defs));
  writeFileSync(join(outAbs, "bindings.jsonl"), jsonl(bindings));
  writeFileSync(join(outAbs, "calls.jsonl"), jsonl(calls));
  const meta = { lang: profile.lang, files: mine.length, parseErrors, defs: defs.length, bindings: bindings.length, calls: calls.length };
  writeFileSync(join(outAbs, "meta.json"), JSON.stringify(meta) + "\n");
  log(`tree-sitter ${profile.lang}: ${mine.length} files, ${defs.length} fns, ${calls.length} call sites`
    + (parseErrors ? `, ${parseErrors} file(s) with syntax errors (grammar older than the code? their rows are partial)` : ""));
  return meta;
}

// CLI entry (env-driven, like joern-export.sc and sfc-virtualize.mjs).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { GEML_SRC, GEML_OUT, GEML_LANG, GEML_EXCLUDE, GEML_NO_GITIGNORE } = process.env;
  if (!GEML_SRC || !GEML_OUT || !GEML_LANG) {
    console.error("treesitter-export: GEML_SRC, GEML_OUT and GEML_LANG are required");
    process.exit(1);
  }
  try {
    await runExport({
      src: GEML_SRC, out: GEML_OUT, lang: GEML_LANG,
      excludeGlobs: GEML_EXCLUDE ? GEML_EXCLUDE.split("\n").filter(Boolean) : [],
      gitignore: !GEML_NO_GITIGNORE,
    });
  } catch (e) {
    console.error(`treesitter-export: ${e?.message ?? e}`);
    process.exit(1);
  }
}
