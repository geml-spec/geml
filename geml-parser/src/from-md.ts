// GEML reference parser — Markdown → GEML conversion.
//
// Markdown's inline syntax (emphasis/strong/strike, code, links, images,
// footnotes) is already a subset of GEML's (§5), so inline text passes through
// unchanged. The work is mapping block constructs onto GEML's single typed-block
// primitive (§3):
//
//   YAML frontmatter      -> === meta            (data)
//   ``` fenced code        -> === code {lang=…}   (raw)
//   $$ … $$ math block     -> === math            (raw)
//   > blockquote           -> === note            (flow)
//   GFM pipe table         -> === table           (visual body, §6)
//   setext heading         -> ATX heading (§1: GEML headings are ATX-only)
//   thematic break (---/***) -> dropped           (§1: not part of GEML)
//
// Anything else (ATX headings, lists, paragraphs) is already valid GEML.

export interface ConvertResult {
  geml: string;
  notes: string[]; // non-fatal remarks (dropped constructs, raw HTML, …)
}

// Pick a fence length longer than any run of `=` that appears alone on a body
// line (leading indentation included), so the close fence stays unambiguous
// (§3 equal-length close rule) and the body's own `=` fences nest safely.
function fenceFor(body: string[]): string {
  let max = 2;
  for (const l of body) {
    const m = /^\s*(=+)\s*$/.exec(l);
    if (m) max = Math.max(max, m[1]!.length);
  }
  return "=".repeat(Math.max(3, max + 1));
}

// Emit a typed block, auto-assigning a stable `#type-N` id (so converted blocks
// are referenceable) unless one was already supplied or the block is `meta`.
function emitBlock(out: string[], type: string, attrs: string, body: string[], ids?: Record<string, number>): void {
  if (ids && type !== "meta" && !attrs.includes("#")) {
    const n = (ids[type] = (ids[type] ?? 0) + 1);
    const idAttr = `#${type}-${n}`;
    attrs = attrs ? attrs.replace(/^\{/, `{${idAttr} `) : `{${idAttr}}`;
  }
  const fence = fenceFor(body);
  out.push(attrs ? `${fence} ${type} ${attrs}` : `${fence} ${type}`);
  out.push(...body);
  out.push(fence);
}

// Fenced-code info strings that denote a diagram DSL (§7) rather than code.
const DIAGRAM_LANGS = new Set(["mermaid", "graphviz", "dot", "d2", "plantuml"]);

// `key: value` (YAML-ish) -> `key=value`, quoting values that need it.
function metaLine(line: string): string | null {
  const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
  if (!m) return null;
  let v = m[2]!.trim();
  if (v === "") return `${m[1]}=""`;
  // Strip existing YAML quotes; re-quote only when the bare value would be
  // re-tokenized (contains whitespace or a quote).
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  const bareSafe = /^[^\s"]+$/.test(v);
  return bareSafe ? `${m[1]}=${v}` : `${m[1]}="${v.replace(/"/g, '\\"')}"`;
}

// Rewrite Markdown autolinks `<https://…>` / `<mailto:…>` into GEML links
// `[url](url)` (GEML has no autolink syntax). Inline code spans are left intact.
function autolinks(s: string): string {
  return s
    .split(/(`[^`]*`)/)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/<((?:https?|ftp):\/\/[^>\s]+)>/g, "[$1]($1)")
            .replace(/<mailto:([^>\s]+)>/g, "[$1](mailto:$1)"),
    )
    .join("");
}

// GitHub-style heading anchor: drop code backticks (keep content), lowercase,
// strip punctuation except `-`/`_`, collapse whitespace to hyphens. Used to keep
// converted headings' ids in sync with Markdown TOC links.
function githubSlug(text: string): string {
  return text
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const SETEXT_UL = /^=+\s*$/;
const SETEXT_DASH = /^-+\s*$/;
const THEMATIC = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function mdToGeml(source: string): ConvertResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const notes: string[] = [];
  const ids: Record<string, number> = {}; // per-type id counters for auto-ids
  let i = 0;

  // YAML frontmatter (must be the very first line).
  if (lines[0] === "---") {
    let j = 1;
    const meta: string[] = [];
    while (j < lines.length && lines[j] !== "---" && lines[j] !== "...") {
      const ml = metaLine(lines[j]!);
      if (ml) meta.push(ml);
      else if (lines[j]!.trim() !== "") notes.push(`frontmatter line not converted: ${lines[j]}`);
      j++;
    }
    if (j < lines.length) { // closing marker found -> it was frontmatter
      emitBlock(out, "meta", "", meta, ids);
      out.push("");
      i = j + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[2]!;
      const info = f[3]!.trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const raw = lines[j]!;
        // CommonMark: a closing fence is indented at most 3 spaces, uses the same
        // marker, and is at least as long as the opener. A more-indented run of
        // the same character is content — this is what lets a document *show*
        // nested ``` fences without ending the block early.
        const indent = raw.length - raw.trimStart().length;
        const c = raw.replace(/\s+$/, "").trimStart();
        if (indent <= 3 && c.length >= marker.length && c[0] === marker[0]! && /^[`~]+$/.test(c)) break;
        body.push(raw);
      }
      if (DIAGRAM_LANGS.has(info)) emitBlock(out, "diagram", `{format=${info}}`, body, ids);
      else emitBlock(out, "code", info ? `{lang=${info}}` : "", body, ids);
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    // Display math $$ … $$.
    if (line.trim() === "$$") {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j]!.trim() !== "$$"; j++) body.push(lines[j]!);
      emitBlock(out, "math", "", body, ids);
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    // Setext heading: a text line followed by `===` or `---` underline. Checked
    // before the thematic-break drop so dash underlines aren't lost.
    if (line.trim() !== "" && !THEMATIC.test(line) && i + 1 < lines.length) {
      const nxt = lines[i + 1]!;
      if (SETEXT_UL.test(nxt)) { out.push(`# ${line.trim()}`); i += 2; continue; }
      if (SETEXT_DASH.test(nxt)) { out.push(`## ${line.trim()}`); i += 2; continue; }
    }

    // Thematic break (---, ***, ___) -> dropped (not a GEML construct). Any
    // dash underline has already been consumed by the setext check above.
    if (THEMATIC.test(line)) {
      notes.push(`dropped thematic break at line ${i + 1}`);
      i++;
      continue;
    }

    // Footnote definition `[^id]: body` -> a flow `=== note {#id}` block so the
    // matching `[^id]` reference resolves at build time (§5.2). Continuation
    // lines (indented) are folded into the body.
    const fn = /^\[\^([^\]]+)\]:\s?(.*)$/.exec(line);
    if (fn) {
      const body = fn[2]!.trim() ? [fn[2]!.trim()] : [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^\s{2,}\S/.test(lines[j]!)) body.push(lines[j]!.replace(/^\s+/, ""));
        else if (lines[j]!.trim() === "") break;
        else break;
      }
      emitBlock(out, "note", `{#${fn[1]!.trim()}}`, body.map(autolinks), ids);
      i = j;
      continue;
    }

    // Blockquote -> === note (flow). Strips one `>` level per line.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      emitBlock(out, "note", "", body, ids);
      continue;
    }

    // GFM pipe table -> === table (visual body).
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && line.trim() !== "") {
      const body: string[] = [line];
      let j = i + 1;
      body.push(lines[j]!); // separator
      j++;
      while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") { body.push(lines[j]!); j++; }
      emitBlock(out, "table", "", body, ids);
      i = j;
      continue;
    }

    // ATX heading: pin an explicit id when it contains inline code. GEML's slug
    // rule (§4) drops code-span content, but a Markdown TOC was authored against
    // GitHub-style anchors (which keep it), so headings like `## 3. \`.x\` 文档`
    // would otherwise break their links. Pinning the GitHub slug keeps both sides
    // in agreement.
    const atx = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (atx && atx[2]!.includes("`") && !/\{[^}]*\}\s*$/.test(atx[2]!)) {
      const id = githubSlug(atx[2]!);
      if (id) { out.push(`${atx[1]} ${atx[2]} {#${id}}`); i++; continue; }
    }

    // Inline pass: rewrite autolinks to GEML links (outside code spans).
    const text = autolinks(line);

    // Raw HTML note — ignore `<…>` that sits inside an inline code span.
    if (/<[a-zA-Z/]/.test(text.replace(/`[^`]*`/g, ""))) {
      notes.push(`raw HTML kept as text at line ${i + 1}: ${line.trim().slice(0, 40)}`);
    }

    // Everything else (ATX headings, lists, paragraphs, blanks) is valid GEML.
    out.push(text);
    i++;
  }

  let geml = out.join("\n");
  if (!geml.endsWith("\n")) geml += "\n";
  return { geml, notes };
}
