// The MCP tool table and JSON-RPC dispatch, independent of where documents
// live. A HOST supplies the answers to three questions — how a tool call names
// its document and how that text is read, where a validated write lands, and
// which documents can be searched — and this module supplies everything else:
// the eleven tools' names, descriptions and schemas, the write pipeline that
// validates a result before the host sees it, and the newline-delimited
// JSON-RPC 2.0 handling the stdio server speaks.
//
// One host exists today: mcp.ts binds a confined root directory on disk (the
// `geml mcp` stdio server: `file` is a path under `--root`, a write is saved
// to `.gemlhistory` and then to the file). The seam is drawn so that a host
// which keeps no files at all — the document travelling in the call, a write
// coming back in the result — needs nothing from this module but a second
// `McpHost`.
//
// The verbs run IN-PROCESS (verbs.ts). Until this module existed the server
// started a CLI child per tool call and fished a JSON frame out of its stderr;
// the tool table was *defined* as CLI equivalences and stays so — each tool is
// still named after the verb it wraps — but the equivalence is now a function
// call.
import { type Diagnostic, type ParseOptions, type UnitPart, parse, PARSER_VERSION } from "./geml.js";
import {
  type Content, type FindHit, type HistoryReader, type InFmt, type OutFmt, type VerbContext,
  VerbError, add, del, formatFindRows, get, list, rename, revert, set, transform,
} from "./verbs.js";
import { BARE_LINE } from "./selector.js";

// One version for the whole package: `geml --version` and the MCP handshake
// must not disagree. This used to be its own literal and had drifted to 0.1.0
// against a 1.4.x package — invisible to everyone except the user reading their
// client's server list.
export const SERVER_VERSION = PARSER_VERSION;

// ---------------------------------------------------------------------------
// The contract with a host
// ---------------------------------------------------------------------------

/** A document a tool call named, opened by the host. */
export interface OpenedDoc {
  /** The document text. */
  text: string;
  /** How the caller named it — echoed back in results (a root-relative path, or the inline `name`). */
  file: string;
  /** What the verbs see as the document's name: messages, `self`, the `.geml`/`.md` rule. */
  label: string;
  /** Resolution and side remarks for the verbs. */
  ctx: VerbContext;
  /** Where the host collects what the verbs say through `ctx.note` during this call. */
  notes?: string[];
  /** Independent validation of a write's RESULT — what the server itself checks before saving. */
  validate: ParseOptions;
  /** The root `--view` chains and the Markdown export are confined to, when the host has one. */
  root?: string;
}

/** The `.gemlhistory` side of one document, for hosts that keep one. */
export interface HistoryAccess {
  exists(): boolean;
  list(): unknown[];
  resolve(rev: string): { id: string; text: string };
  reader: HistoryReader;
  /** Word a history-layer failure without a stack or an absolute path. */
  historyError(e: unknown): string;
}

export interface McpHost {
  /** How a tool call names its document: `file` under a root, or the text itself as `source`. */
  docArg: "path" | "inline";
  /** A sentence appended to every tool description, for what this host cannot do. Empty for the disk. */
  docNote: string;
  /** The sentence a refusal ends with: what did NOT happen. */
  unchangedHint: string;
  open(args: Record<string, any>): OpenedDoc;
  /** Land a validated write. Returns what the result should carry: a revision id, or the document itself. */
  write(doc: OpenedDoc, text: string, summary: string): { revision?: string; document?: string };
  /** `geml_find`: the hits, with `file` in the coordinates the host's other tools accept. */
  find(args: Record<string, any>): FindHit[];
  /** `geml_check`: resolution for its optional reference `root`. */
  checkOpts(doc: OpenedDoc, root: unknown): ParseOptions;
  /** Present when the host keeps `.gemlhistory` sidecars — enables `geml_history` and `geml_revert`. */
  history?(doc: OpenedDoc): HistoryAccess;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface WriteResult {
  ok: boolean;
  file: string;
  diagnostics: Diagnostic[];
  hint?: string;
  revision?: string;
  document?: string;
  /** What the verb said about a write that went through: a block it dropped, an address it changed. */
  notes?: string[];
}

function refuse(file: string, diagnostics: Diagnostic[], hint: string): WriteResult {
  return { ok: false, file, diagnostics, hint };
}

export const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));

// ---------------------------------------------------------------------------
// The write pipeline: produce -> validate -> save -> write
// ---------------------------------------------------------------------------

// `danglingIsWarning` marks the tools for which a reference left pointing at
// nothing is reported but not blocking. Deleting a referenced block is a
// legitimate, deliberate act (the CLI documents it as "a warning, not a
// refusal") — the caller is told what broke and decides. Every OTHER new error
// blocks the write.
interface WriteSpec {
  doc: OpenedDoc;
  /** The verb: the mutated document, or a VerbError refusing it. */
  produce: () => string;
  summary: string;        // history summary for the saved PRE-write state
  danglingIsWarning?: boolean;
}

function applyWrite(host: McpHost, spec: WriteSpec): WriteResult {
  const { doc } = spec;
  const before = doc.text;
  const errorKey = (d: Diagnostic) => `${d.code}:${d.message}`;
  const preexisting = new Set(
    parse(before, doc.validate).diagnostics
      .filter((d) => d.severity === "error")
      .map(errorKey),
  );

  // 1. Produce the mutated document WITHOUT touching anything. The verb runs
  //    its pre-write check and, refusing, reports every diagnostic with its
  //    Appendix A code.
  let after: string;
  try {
    after = spec.produce();
  } catch (e) {
    if (!(e instanceof VerbError)) throw e;
    const diagnostics = e.diagnostics ?? [];
    // A refusal caused ENTIRELY by errors the document already had is worth
    // saying out loud: the model did not break anything, and retrying this
    // edit will keep failing until the pre-existing errors are repaired.
    const stale = diagnostics.length > 0 && diagnostics.every((d) => preexisting.has(errorKey(d)));
    const why = stale
      ? "These errors were ALREADY in the document before this edit — your content did not cause them. Repair them first (geml_check lists them); until then no write to this document can be validated."
      : host.unchangedHint;
    return refuse(doc.file, diagnostics, `${e.message}. ${why}`);
  }

  // A verb that produced nothing must never be read as "the new document is
  // empty" — an empty document parses clean, so validation below would wave it
  // through and the write would destroy the file.
  if (before.trim() !== "" && after.trim() === "") {
    return refuse(doc.file, [], `the command produced no output, so nothing was written. ${host.unchangedHint}`);
  }

  // 2. Validate the RESULT independently of the verb. This is what catches the
  //    tools the verb lets through — deleting a referenced block, above all.
  const diags = parse(after, doc.validate).diagnostics;
  let blocking = diags.filter((d) => d.severity === "error" && !preexisting.has(errorKey(d)));
  if (spec.danglingIsWarning) {
    blocking = blocking.filter(
      (d) => d.code !== "unresolved-reference" && d.code !== "unresolved-footnote",
    );
  }
  if (blocking.length) return refuse(doc.file, blocking, host.unchangedHint);

  if (after === before) {
    return { ok: true, file: doc.file, diagnostics: diags, hint: "No change: the document already had this content." };
  }

  // 3. Save the PRE-write state so this edit is revertible, then write — both
  //    the host's business.
  const landed = host.write(doc, after, spec.summary);
  return { ok: true, file: doc.file, diagnostics: diags, ...landed, ...(doc.notes?.length ? { notes: doc.notes } : {}) };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// MCP tool annotations (protocol 2025-03-26 on): what a call does to the world,
// as data a client can act on without reading prose — a read-only tool can run
// without a confirmation prompt, a destructive one should get one. The protocol
// calls them HINTS a client should not trust from an untrusted server; these
// restate what each tool's code does. Every tool here touches documents under
// the server root and nothing else, so none is open-world. `title` is the
// display name, carried at the top level of the listing as well.
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}
export const reads = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, openWorldHint: false });
const writes = (title: string, o: { destructive: boolean; idempotent: boolean }): ToolAnnotations =>
  ({ title, readOnlyHint: false, destructiveHint: o.destructive, idempotentHint: o.idempotent, openWorldHint: false });

export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: ToolAnnotations;
  run: (args: Record<string, any>) => unknown;
}

// What every write tool returns, said once so each description can point at it.
const WRITE_RESULT = " Returns `{ok, file, diagnostics, revision}`, with `notes` when the write did something to say out loud (a block it dropped, an address it changed); a refusal is `ok: false` with a `hint`, and the file is unchanged.";

const hashId = (id: string) => (id.startsWith("#") ? id : `#${id}`);

// `geml get`/`geml set` take a full block SELECTOR, not only an id: a content
// address reaches a block the author never named, which is the whole point of
// `geml_list` now reporting one for those. So a value that is ALREADY a
// selector must pass through untouched — hashId would turn `@a3f9c1d2` into
// `#@a3f9c1d2` and address nothing. A bare word is still an id, so the
// long-standing "id with or without #" contract is unchanged.
//
// The parameter is still NAMED `id`: renaming it to `selector` would break
// every registered client for a cosmetic gain, and both design docs park that
// rename as a follow-up. The other verbs keep hashId — their CLI counterparts
// (add/delete/rename/revert) take ids only, so accepting a selector here would
// promise something the CLI would then refuse.
// A selector starts with `#` (id or heading line), `@` (content address), or a
// `=` fence run (type filter), or is a position `L27` / `L27-58` — the range
// `geml_list` prints on every row. Anything else is a bare id. The position is
// checked by the selector's own pattern: prefixed, `#L27` would ask for a block
// NAMED L27, which is how a real id of that spelling stays reachable.
const selectorArg = (s: string) => {
  const t = s.trim();
  // `{…}` is a selector already (`{#id}`, `{@<hex>}`, `{lang=py}`); prefixing
  // it would turn every braced form into an id no block has.
  return /^([#@{]|={3,})/.test(t) || BARE_LINE.test(t) ? t : `#${s}`;
};

// The parts a `part` argument names: the same four regions the CLI's
// --head/--intro/--body select. geml_get and geml_set take this ONE list for
// both their schema enum and their validation, so the schema can never offer a
// value the tool then refuses — which is what happened to `intro` while the
// enum and the check were written out separately.
const PARTS: readonly UnitPart[] = ["whole", "head", "intro", "body"];

// A `part` argument, validated. A client is free to ignore the schema, so the
// enum is enforced here too, and a bad value is refused by name.
function partArg(v: unknown): UnitPart {
  const part = v ?? "whole";
  if (!PARTS.includes(part as UnitPart)) throw new Error(`part must be ${PARTS.join("|")}, got \`${String(part)}\``);
  return part as UnitPart;
}

// A `within` argument (geml_get, geml_list, geml_find): a selector naming the
// blocks to look inside, as the CLI's `--within`. A value that is not a
// selector is refused rather than ignored: a scope that quietly widens to the
// whole document is the failure §7 of the selector design exists to prevent.
export function withinArg(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") throw new Error("`within` must be a selector, e.g. `#install` or `=== table`");
  return v;
}
const WITHIN_ARG = { type: "string", description: "Optional: only look inside the blocks this selector names, e.g. `#install` for a section or `=== table` for every table. It takes the same selector forms as geml_get's `id`." };

// The CLI flag that names a part, for the verbs' messages; `whole` names none.
const partFlagOf = (part: UnitPart): string | undefined => (part === "whole" ? undefined : `--${part}`);

const FILE_ARG = { type: "string", description: "Document path relative to the server's --root directory, e.g. notes/spec.geml" };
const SOURCE_ARG = { type: "string", description: "The document's full text. This server keeps no files: what you send is the document." };
const NAME_ARG = { type: "string", description: "The document's file name, e.g. notes/spec.geml or README.md — it decides whether the text is read as GEML or as Markdown (a `.md` name), and it is how the document is called in messages. Default: document.geml." };

// How a tool's schema names the document, per host. The rest of every schema
// is shared, so the two surfaces cannot drift apart on anything but this.
function docProps(host: McpHost): { props: Record<string, unknown>; required: string[] } {
  return host.docArg === "path"
    ? { props: { file: FILE_ARG }, required: ["file"] }
    : { props: { source: SOURCE_ARG, name: NAME_ARG }, required: ["source"] };
}

// The formats `geml_to` accepts, inferred as the CLI infers them.
function inFmtOf(name: string, from: string | undefined): InFmt {
  if (from !== undefined) return from as InFmt;
  if (/\.(md|markdown)$/i.test(name)) return "md";
  if (/\.json$/i.test(name)) return "json";
  return "geml";
}

/** The document tools for one host: eleven on a disk, nine where nothing is kept. */
export function toolsFor(host: McpHost): Tool[] {
  const d = docProps(host);
  const schema = (props: Record<string, unknown>, required: string[] = []): unknown =>
    ({ type: "object", properties: { ...d.props, ...props }, required: [...d.required, ...required] });
  const note = host.docNote;

  const tools: Tool[] = [
    // ----- read -----
    {
      name: "geml_list",
      description:
        "List every addressable block in a GEML document — its address, kind and heading text — in one call, with no paging. Call this FIRST: what it returns is what every other tool here addresses, and it is cheaper and more reliable than reading the file to see what is in it. Rows marked `anon` have no `#id`; geml_get and geml_set take their `address` as `id`, while the other write tools need a real id, so give such a block one first. A file that is not under the server root is an error." + note,
      inputSchema: schema({ within: WITHIN_ARG }),
      annotations: reads("List the blocks of a document"),
      run: (args) => {
        const doc = host.open(args);
        return list(doc.text, doc.label, true, doc.ctx, withinArg(args.within)).trim();
      },
    },
    {
      name: "geml_find",
      description:
        (host.docArg === "path"
          ? "Search block CONTENT across the served documents; each hit is one `<file>\\t<address>` row. geml_list says what a document contains, this says which block holds the words — as an address that pastes straight into geml_get or geml_set, not a line number the next edit invalidates. The address is the innermost block holding the match, and a block matching on many lines is reported once. Substring, case-insensitive unless `case` is true. Omit `path` to search every `*.geml` and `*.md` under the server root; a file you name is searched whatever its extension, a directory walks `*.geml` and `*.md`. No match is an empty result, not an error."
          : "Search block CONTENT in the document; each hit is one `<name>\\t<address>` row. geml_list says what a document contains, this says which block holds the words — as an address that pastes straight into geml_get or geml_set, not a line number the next edit invalidates. The address is the innermost block holding the match, and a block matching on many lines is reported once. Substring, case-insensitive unless `case` is true. No match is an empty result, not an error.") + note,
      inputSchema: host.docArg === "path"
        ? {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text to look for inside block bodies" },
            path: { type: "string", description: "Optional file or directory under the server root; default: the whole root" },
            case: { type: "boolean", description: "Match case exactly (default: case-insensitive)" },
            head: { type: "boolean", description: "Add the matching line as a third column" },
            within: WITHIN_ARG,
          },
          required: ["pattern"],
        }
        : schema({
          pattern: { type: "string", description: "Text to look for inside block bodies" },
          case: { type: "boolean", description: "Match case exactly (default: case-insensitive)" },
          head: { type: "boolean", description: "Add the matching line as a third column" },
          within: WITHIN_ARG,
        }, ["pattern"]),
      annotations: reads("Find the blocks that hold some text"),
      run: (args) => {
        if (typeof args.pattern !== "string" || args.pattern === "") throw new Error("`pattern` is required");
        return formatFindRows(host.find(args), !!args.head).trim();
      },
    },
    {
      name: "geml_get",
      description:
        "Read ONE block from a GEML document instead of the whole file: only that block comes back, typically a few percent of the document. Pass the `address` geml_list prints as `id` — it also reaches blocks with no `#id`; to locate a block by its words instead, use geml_find first. An `id` that matches nothing, or a file that is not under the server root, is an error naming it." + note,
      inputSchema: schema({
        id: {
          type: "string",
          description: "What to read: a block id (with or without `#`), a `## Heading` line (its whole section), `=== type` for every block of a type, `=== code {lang=py}` or `{.warn}` for every block carrying those attributes, a `@<hex>` content address for a block with no id, or `L27`/`L27-58` for the smallest block holding those lines — the forms `geml_list` prints, plus the line numbers an editor or a diff hunk speaks",
        },
        view: {
          type: "boolean",
          description: "Read THROUGH an `embed` block to the entity block it stands for, following a multi-layer chain to its end. An `embed` has no content of its own, so this is the only way to see what it points at; on any other block it changes nothing. Returns {from, content}: `from` names the document the content actually came from, and its references and relative paths resolve against THAT document, not this one.",
        },
        part: {
          type: "string",
          enum: [...PARTS],
          description: "How much of the block to return (default: whole). For a SECTION these cut it three ways: `head` is the heading line, `intro` everything under it up to its first subheading, `body` everything under it — so `body` always contains `intro`, and equals it when the section has no subheading. Reach for `intro` to read a section's opening without pulling its subsections into the conversation; a whole `#id` on a top-level heading is often the entire document. Only a heading has an intro. `body` is usually what you want together with `view`.",
        },
        within: WITHIN_ARG,
      }, ["id"]),
      annotations: reads("Read one block"),
      run: (args) => {
        const doc = host.open(args);
        const sel = selectorArg(args.id);
        // Same name, same enum, same validation as `geml_set` — one concept for a
        // model to learn, and `body` is already taken there for the replacement text.
        const part = partArg(args.part);
        const partFlag = partFlagOf(part);
        const r = get(doc.text, doc.label, sel, { part, partFlag, json: false, view: !!args.view, root: doc.root, within: withinArg(args.within) }, doc.ctx);
        if (!args.view) return r.output;
        // Provenance is mandatory, and there is no stderr across an MCP call:
        // it travels as a field of its own.
        return { from: r.from[0] ?? null, content: r.output };
      },
    },
    {
      name: "geml_check",
      description:
        "Validate a GEML document without changing it: returns every diagnostic with a stable `code`, a severity and a line, and an empty list means the document is valid. Use it to confirm a document is sound before reporting work as finished. Every write through this server runs the same check before it lands, so a refused write already carries this information." + note,
      inputSchema: schema(host.docArg === "path"
        ? { root: { type: "string", description: "Directory (inside the server root) against which cross-document references resolve. Defaults to the server root itself. This is a REFERENCE root and is distinct from the server's own --root sandbox, which it can only narrow." } }
        : {}),
      annotations: reads("Validate a document"),
      run: (args) => {
        const doc = host.open(args);
        const parsed = parse(doc.text, host.checkOpts(doc, args.root));
        const errors = parsed.diagnostics.filter((x) => x.severity === "error").length;
        return {
          ok: errors === 0,
          file: doc.file,
          errors,
          warnings: parsed.diagnostics.length - errors,
          diagnostics: parsed.diagnostics,
        };
      },
    },
  ];

  if (host.history) {
    const history = host.history.bind(host);
    tools.push({
      name: "geml_history",
      // The name mirrors the CLI COMMAND PATH (`geml history`), not a verb: this
      // group's only read verb is `get`, and it is the only one that belongs on a
      // server an agent drives (`save` would insert hand-made revisions between
      // the automatic pre-write ones, and `restore` rewrites a whole file where
      // the agent already has block-level geml_revert). So there will be no second
      // history tool to disambiguate from, and `_get` would be a suffix that
      // distinguishes nothing — design §5.
      description:
        "Read a document's recorded history. WITHOUT `rev`: list every revision, newest first — each entry's `offset` is the selector `geml_revert` takes as `rev` (-1 is the revision before the current one), and an empty list means the document has no sidecar yet and nothing can be reverted. WITH `rev`: the full text of that one revision, for reading what the document looked like then without restoring it." + note,
      inputSchema: schema({
        rev: { type: "string", description: "Revision selector — `0` for the current tip, `-N` for N revisions back, or a revision id from the list. Omit it to get the list instead of one revision's text." },
      }),
      annotations: reads("Read a document's history"),
      run: (args) => {
        const doc = host.open(args);
        const h = history(doc);
        const rev = args.rev === undefined ? undefined : String(args.rev);
        if (!h.exists()) {
          // Naming a revision of a document that has no history at all is an
          // error, not an empty result: the caller asked for specific content.
          // The LIST tier stays a plain empty answer — "nothing yet" is a real,
          // useful state there.
          if (rev !== undefined) throw new Error(`no .gemlhistory sidecar for ${doc.file} yet, so revision ${rev} does not exist — the first write through this server creates one`);
          return { file: doc.file, revisions: [], note: "no .gemlhistory sidecar yet — the first write through this server creates one" };
        }
        if (rev === undefined) return { file: doc.file, revisions: h.list() };
        // resolve() is the CLI's own path for `geml history get <file> <rev>`,
        // so one selector grammar answers on both surfaces.
        const { id, text } = h.resolve(rev);
        return { file: doc.file, id, text };
      },
    });
  }

  tools.push({
    name: "geml_to",
    description:
      "Convert a WHOLE document and get the result back as text — the read half of the CLI's `geml <file> --to <fmt>`. `to: \"geml\"` on a Markdown file is the importer, the one thing the block tools cannot do; `to: \"md\"` projects a GEML document out (lossy); `to: \"json\"` returns the full document model, for when geml_list plus geml_get is not enough. Nothing is written — pass the result to geml_add or geml_set to land it. `to: \"html\"` also works but returns a whole self-contained page, usually tens of kilobytes this server cannot save: prefer the CLI (`geml <file> --to html -o out.html`) unless you want the markup in the conversation. A document with errors returns its diagnostics instead of a conversion, and a file that is not under the server root is an error." + note,
    inputSchema: schema({
      to: {
        type: "string",
        enum: ["json", "md", "geml", "html"],
        description: "Target format. Default is the CLI's: a GEML input becomes json, a Markdown input becomes geml. `html` is a whole page — large, and not writable from here.",
      },
      from: {
        type: "string",
        enum: ["geml", "md", "json"],
        description: "Override the input format, which is otherwise inferred from the extension (.md -> md, .json -> json, else geml).",
      },
    }),
    annotations: reads("Convert a whole document"),
    run: (args) => {
      const doc = host.open(args);
      // Enforce the enums here too: a client is free to ignore the schema, and a
      // typo'd format should come back as this server's clear error rather than
      // whatever the verb makes of it.
      const to = args.to === undefined ? undefined : String(args.to);
      const from = args.from === undefined ? undefined : String(args.from);
      if (to !== undefined && !["json", "md", "geml", "html"].includes(to)) throw new Error(`unknown \`to\` format: ${to} (want json | md | geml | html)`);
      if (from !== undefined && !["geml", "md", "json"].includes(from)) throw new Error(`unknown \`from\` format: ${from} (want geml | md | json)`);
      const inFmt = inFmtOf(doc.label, from);
      const outFmt: OutFmt = to !== undefined ? (to as OutFmt) : inFmt === "geml" ? "json" : "geml";
      // The transform resolves cross-document references from the document's
      // own directory (no `--root`), as the CLI's transform entry does.
      const r = transform(doc.text, doc.label, { inFmt, outFmt, fragment: false }, doc.ctx);
      // The transform exits 1 on a document with errors but still prints the
      // result; surface the diagnostics rather than the text in that case, so a
      // model is never handed the output of a document it was told nothing about.
      if (r.doc && r.doc.diagnostics.some((x) => x.severity === "error")) {
        const lines = [
          ...r.notes.map((n) => `note: ${n}`),
          ...r.doc.diagnostics.map((x) => `${x.severity}: ${x.message} (line ${x.line})`),
        ];
        throw new Error(lines.join("\n") || `could not convert ${doc.file}`);
      }
      return r.output;
    },
  });

  // ----- write -----
  const raw = (text: unknown): Content => ({ kind: "raw", text: typeof text === "string" ? text : "" });

  tools.push(
    {
      name: "geml_set",
      description:
        "Replace ONE block and leave every other byte untouched — prefer this to rewriting a file. For content that does not exist yet use geml_add; to remove a block, geml_delete. The replacement is validated before it is written: if it would break the document, nothing is written and the diagnostics come back — fix the body rather than resending it. Removing content is not refused: if the replacement drops blocks, the write goes through and the result names each one, so check it after shortening a section; geml_revert puts one back. `part` replaces the whole block (default), its head line, a section's `intro`, or its body. In a Markdown file a heading's anchor is its text, as on GitHub: new heading text gives the heading a new address, and the document's links to the old one follow in the same write. GEML content written over a Markdown heading or prose is converted to Markdown, as in geml_add; a GEML block already in the file stays GEML. An `id` that matches no block, or several, is refused." + WRITE_RESULT + note,
      inputSchema: schema({
        id: {
          type: "string",
          description: "Which block to replace: an id (with or without `#`), a `@<hex>` content address from `geml_list` for a block with no id, or `L27`/`L27-58` for the smallest block holding those lines. Must match exactly one block",
        },
        body: { type: "string", description: "The replacement text" },
        part: { type: "string", enum: [...PARTS], description: "What to replace (default: whole). `intro` replaces a section's opening — everything under the heading up to its first subheading — and leaves every subsection byte-identical, which is what makes a read-edit-write cycle on a long section safe. An empty intro (a subheading follows the heading immediately) is written into, so this also adds an opening where there was none." },
      }, ["id", "body"]),
      annotations: writes("Replace one block", { destructive: true, idempotent: true }),
      run: (args) => {
        const doc = host.open(args);
        const part = partArg(args.part);
        const flag = partFlagOf(part);
        return applyWrite(host, {
          doc,
          produce: () => set(doc.text, doc.label, selectorArg(args.id), { part, named: flag ? [flag] : [], content: raw(args.body) }, doc.ctx).text,
          summary: `mcp: before write to ${selectorArg(args.id)}`,
        });
      },
    },
    {
      name: "geml_add",
      description:
        "Insert new content — one or more blocks, or prose — at the end of the document (`position: append`) or before/after the block named by `anchor`. Use this for content that does not exist yet; to change a block that does, use geml_set. Ids inside the content are kept. In a `.md` file Markdown lands as written, and GEML content is converted to Markdown as `to: \"md\"` converts it, the result's `notes` saying so; content Markdown cannot hold, such as a view without its source, is refused. Like every write here it is validated first: a missing anchor, an id that clashes with an existing one, or content that would break the document is refused." + WRITE_RESULT + note,
      inputSchema: schema({
        content: { type: "string", description: "The GEML fragment to insert" },
        position: { type: "string", enum: ["append", "before", "after"], description: "Where to insert" },
        anchor: { type: "string", description: "Block id the insertion is relative to; required for before/after" },
      }, ["content", "position"]),
      annotations: writes("Insert new content", { destructive: false, idempotent: false }),
      run: (args) => {
        const doc = host.open(args);
        let where: { append: boolean; before?: string; after?: string };
        if (args.position === "append") where = { append: true };
        else if (args.position === "before" || args.position === "after") {
          if (!args.anchor) throw new Error(`position \`${args.position}\` needs an \`anchor\` block id`);
          where = { append: false, [args.position]: hashId(args.anchor) };
        } else throw new Error(`position must be append|before|after, got \`${args.position}\``);
        return applyWrite(host, {
          doc,
          produce: () => add(doc.text, doc.label, { content: raw(args.content), ...where }, doc.ctx).text,
          summary: `mcp: before insert (${args.position}${args.anchor ? " " + hashId(args.anchor) : ""})`,
        });
      },
    },
    {
      name: "geml_delete",
      description:
        "Remove one or more blocks by id. Each block takes the blank line that separated it from its neighbours, so deleting what geml_add inserted leaves the file as it was. To undo a deletion, geml_revert the removed id; to change a block rather than remove it, use geml_set. References left pointing at a removed block come back as diagnostics but do NOT block the deletion — read them, then repair the references or revert. An id that matches nothing is skipped, so repeating a call changes nothing." + WRITE_RESULT + note,
      inputSchema: schema({
        ids: { type: "array", items: { type: "string" }, description: "Block ids to remove" },
      }, ["ids"]),
      annotations: writes("Delete blocks", { destructive: true, idempotent: true }),
      run: (args) => {
        const doc = host.open(args);
        const ids: string[] = Array.isArray(args.ids) ? args.ids : [args.ids];
        if (!ids.length) throw new Error("`ids` must name at least one block");
        return applyWrite(host, {
          doc,
          produce: () => del(doc.text, doc.label, ids.map((i) => hashId(i)), doc.ctx).text,
          summary: `mcp: before delete ${ids.map((i) => hashId(i)).join(" ")}`,
          danglingIsWarning: true,
        });
      },
    },
    {
      name: "geml_rename",
      description:
        "Rename a block id AND every reference to it in the same document, in one id-boundary-safe write. Use this rather than geml_set or a text search-and-replace, which would also hit ids that merely share a prefix. A Markdown heading's anchor is its text, so it is renamed by changing the heading with geml_set (`part: head`), not here. An `old` id that does not exist, or a `new` one already taken, is refused." + WRITE_RESULT + note,
      inputSchema: schema({
        old: { type: "string", description: "Current id" },
        new: { type: "string", description: "New id" },
      }, ["old", "new"]),
      annotations: writes("Rename a block id", { destructive: false, idempotent: true }),
      run: (args) => {
        const doc = host.open(args);
        return applyWrite(host, {
          doc,
          produce: () => rename(doc.text, doc.label, hashId(args.old), hashId(args.new), {}, doc.ctx).text,
          summary: `mcp: before rename ${hashId(args.old)} -> ${hashId(args.new)}`,
        });
      },
    },
  );

  if (host.history) {
    const history = host.history.bind(host);
    tools.push({
      name: "geml_revert",
      description:
        "Undo ONE block, leaving every other block byte-for-byte unchanged — recover a single block after a bad edit without losing the good edits around it. `rev` defaults to undoing this block's LAST change (its previous distinct version), which holds even when other blocks were edited afterwards; or pass `0` for the tip, a `-N` offset, or a revision id from `geml_history`. Reverting across a revision where the block was deleted restores it; across one where it did not exist removes it. A `rev` that matches no revision, or a document with no history yet, is refused." + WRITE_RESULT + note,
      inputSchema: schema({
        id: { type: "string", description: "Block id to revert" },
        rev: { type: "string", description: "Revision selector: 0 (the tip) | -N (N revisions back) | id prefix. Omit to undo this block's last change (robust to edits of other blocks since)." },
      }, ["id"]),
      annotations: writes("Revert one block", { destructive: true, idempotent: false }),
      run: (args) => {
        const doc = host.open(args);
        const h = history(doc);
        // Default to `--rev changed`, NOT the tip (`0`) or the CLI's own `-1`. Each
        // write commits the PRE-write state, so the tip undoes the block only when
        // it was the MOST RECENT write — a later write to ANOTHER block moves the
        // tip, and the revert then silently degrades to a no-op (ok:true, nothing
        // undone). `changed` walks back to THIS block's previous distinct version,
        // so it undoes the block's last edit regardless of intervening writes.
        const rev = args.rev ? String(args.rev) : "changed";
        return applyWrite(host, {
          doc,
          produce: () => {
            const r = revert(doc.text, doc.label, hashId(String(args.id)), {
              rev, dryRun: false, headOnly: false, append: false,
              history: h.reader, historyError: (e) => h.historyError(e),
            }, doc.ctx);
            // A block already at that revision leaves the document as it is —
            // the pipeline reports that as "No change".
            return r.kind === "write" ? r.text : doc.text;
          },
          summary: `mcp: before revert ${hashId(String(args.id))}`,
        });
      },
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// newline-delimited JSON-RPC 2.0
// ---------------------------------------------------------------------------

const ok = (id: unknown, result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string): Record<string, unknown> =>
  ({ jsonrpc: "2.0", id, error: { code, message } });

// Every tool's inputSchema already declares the arguments it cannot work
// without. Enforce THAT list here, so a forgotten argument is refused by name
// rather than surfacing as whichever TypeError the verb happens to throw first:
// `geml_set` without `id` answered "Cannot read properties of undefined
// (reading 'trim')", which names neither the tool nor the argument and leaves a
// model guessing. One source for the schema and the check — the same rule the
// `part` enum follows.
function missingRequired(tool: Tool, args: Record<string, any>): string[] {
  const req = (tool.inputSchema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(req)) return [];
  return req.filter((k): k is string => typeof k === "string" && args[k] === undefined);
}

function callTool(name: unknown, args: unknown, tools: () => Tool[]): { result: Record<string, unknown> } | { unknown: true } {
  const tool = tools().find((t) => t.name === name);
  if (!tool) return { unknown: true };
  const given = (args as Record<string, any>) ?? {};
  const missing = missingRequired(tool, given);
  if (missing.length > 0) {
    const names = missing.map((m) => `\`${m}\``).join(", ");
    return { result: { content: [{ type: "text", text: `error: ${String(name)} needs ${names}` }], isError: true } };
  }
  try {
    const out = tool.run(given);
    // A refused write is a RESULT, not a protocol error: the model must be
    // able to read the diagnostics that refused it.
    const isError = typeof out === "object" && out !== null && (out as WriteResult).ok === false;
    return { result: { content: [{ type: "text", text: asText(out) }], ...(isError ? { isError: true } : {}) } };
  } catch (e) {
    return { result: { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true } };
  }
}

/** One parsed JSON-RPC message in; the reply out, or nothing for a notification. */
export function dispatch(msg: unknown, tools: () => Tool[]): Record<string, unknown> | undefined {
  const m = msg as any;
  const id = m?.id;
  const method = m?.method;
  const params = m?.params;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "geml", version: SERVER_VERSION },
    });
  }
  // Notifications get no response.
  if (typeof method === "string" && method.startsWith("notifications/")) return undefined;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    return ok(id, { tools: tools().map(({ name, description, inputSchema, annotations }) => ({ name, title: annotations.title, description, inputSchema, annotations })) });
  }
  if (method === "tools/call") {
    const r = callTool(params?.name, params?.arguments, tools);
    return "unknown" in r ? err(id, -32602, `unknown tool: ${params?.name}`) : ok(id, r.result);
  }
  return id !== undefined ? err(id, -32601, `method not found: ${method}`) : undefined;
}

/**
 * The stdio framing: one line in, zero or one line out through `write`.
 * `tools` is asked per message, because a host may add tools after start-up
 * (the stdio server loads the code-graph tools once it knows it has a graph).
 */
export function createHandler(tools: () => Tool[]): (line: string, write: (s: string) => void) => void {
  return (line, write) => {
    line = line.trim();
    if (!line) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    try {
      const reply = dispatch(msg, tools);
      if (reply) write(JSON.stringify(reply) + "\n");
    } catch (e) {
      if (msg?.id !== undefined) write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String((e as Error)?.message ?? e) } }) + "\n");
    }
  };
}
