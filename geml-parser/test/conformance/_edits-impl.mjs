// The reference parser's adapter for the `edits` cases: each case's `op` is
// turned into one call of verbs.ts over an in-memory host — the document is
// `geml`, other documents are `files`, a revert's sidecar is `history` — and
// the verb's answer or refusal is returned in the shape `_edits.mjs` compares.
// No file is read from disk except the sidecar `revert` needs, which the
// history layer reads by path: it is written to a scratch directory per call.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VerbError, ViewError, add, check, del, findInSource, get, list, rename, replace, revert, set, transform,
} from "../../dist/verbs.js";
import { firstChangedContent, resolveContent } from "../../dist/history.js";
import { manifest } from "./_edits.mjs";

const isMarkdown = (name) => /\.(md|markdown)$/i.test(name);
const inFmtOf = (name) => (isMarkdown(name) ? "md" : /\.json$/i.test(name) ? "json" : "geml");
const codes = (ds) => ds.map((d) => `${d.code}:${d.severity}`);

/** A context over the case's in-memory files: resolution for the parse, `--view` reads, and silent notes. */
function contextOf(files) {
  const docOpts = (file) => ({
    resolveDoc: (d) => (Object.hasOwn(files, d) ? files[d] : null),
    docExists: (d) => Object.hasOwn(files, d),
    markdown: isMarkdown(file),
  });
  return {
    docOpts,
    note: () => {},
    files: {
      readConfined(rel) {
        if (!/\.geml$/i.test(rel)) throw new ViewError("embed-target-not-geml", `embed-target-not-geml: \`${rel}\` is not a \`.geml\` document`);
        if (!Object.hasOwn(files, rel)) throw new ViewError("unresolvable-document", `unresolvable-document: cannot resolve \`${rel}\``);
        return files[rel];
      },
      shownPath: (rel) => rel,
    },
  };
}

const raw = (text) => ({ kind: "raw", text: text ?? "" });
const partFlag = (part) => (part === undefined || part === "whole" ? undefined : `--${part}`);

export function run(c) {
  const file = c.file ?? "doc.geml";
  const source = c.geml;
  const files = c.files ?? {};
  const ctx = contextOf(files);
  const op = c.op;
  try {
    switch (op.verb) {
      case "list":
        return { rows: JSON.parse(list(source, file, true, ctx, op.within)) };
      case "find":
        return {
          hits: findInSource(source, file, op.pattern, {
            sensitive: !!op.case, withLine: !!op.head,
            within: op.within === undefined ? undefined : { selector: op.within, ctx },
          }),
        };
      case "get": {
        const part = op.part ?? "whole";
        const r = get(source, file, op.address, { part, partFlag: partFlag(part), json: false, view: false, within: op.within }, ctx);
        return { output: r.output };
      }
      case "check":
        return { diagnostics: codes(check(source, file, ctx, op.root).diagnostics) };
      case "to": {
        const r = transform(source, file, { inFmt: op.from ?? inFmtOf(file), outFmt: op.to, fragment: false }, ctx);
        return { output: r.output };
      }
      case "replace":
        return { text: replace(source, file, op.old, op.new, op.within, ctx).text };
      case "set": {
        const part = op.part ?? "whole";
        const named = part === "whole" ? [] : [`--${part}`];
        return { text: set(source, file, op.address, { part, named, content: raw(op.content) }, ctx).text };
      }
      case "add":
        return { text: add(source, file, { content: raw(op.content), append: !!op.append, before: op.before, after: op.after }, ctx).text };
      case "delete":
        return { text: del(source, file, op.addresses, ctx).text };
      case "rename":
        return { text: rename(source, file, op.old, op.new, {}, ctx).text };
      case "revert": {
        // The history layer reads a sidecar by path: give it the case's one.
        const dir = mkdtempSync(join(tmpdir(), "geml-edits-"));
        const historyPath = join(dir, "doc.gemlhistory");
        try {
          if (c.history !== undefined) writeFileSync(historyPath, c.history, "utf8");
          const history = {
            resolve: (sel) => resolveContent(historyPath, sel),
            firstChanged: (current, pick) => firstChangedContent(historyPath, current, pick),
          };
          const r = revert(source, file, op.address, {
            rev: op.rev ?? "-1", dryRun: false, headOnly: !!op.head,
            before: op.before, after: op.after, append: !!op.append,
            history, historyError: (e) => String(e?.message ?? e),
          }, ctx);
          if (r.kind === "unchanged") return { unchanged: true };
          if (r.kind === "write") return { text: r.text };
          return { output: r.preview ?? "" };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      default:
        throw new Error(`unknown verb ${op.verb}`);
    }
  } catch (e) {
    if (!(e instanceof VerbError)) throw e;
    const out = { refused: e.reason, message: e.message };
    if (e.diagnostics) out.diagnostics = codes(e.diagnostics);
    return out;
  }
}

export const impl = { label: "reference parser (edits)", has: new Set(Object.keys(manifest.capabilities)), run };
