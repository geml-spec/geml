// Shared attribute-object and value typing (§4), used by the block scanner
// and the inline parser.

export type Value = string | number | boolean;

export interface Attrs {
  id?: string;
  classes: string[];
  attrs: Record<string, Value>;
  // Names written in the document that are not NAMEs (§4). Reported by the
  // caller that has a line number; `parseAttrs` stays pure. See `odd`.
  odd?: { kind: "id" | "class" | "flag" | "key"; name: string }[];
}

// §4: NAME = NAME-CHAR+, NAME-CHAR = LETTER | DIGIT | "-" | "_", LETTER being
// any Unicode letter. Ids, classes and attribute keys are all NAMEs; only
// VALUES may hold anything else.
const NAME = /^[\p{L}\p{N}_-]+$/u;

// Why this is worth a diagnostic: the attribute object is whitespace-separated,
// so `{#Trade-offs & Laws}` parses as the id `Trade-offs` plus two boolean flags
// named `&` and `Laws` — a legal parse of a document nobody meant to write, and
// silent, because a bare word IS how a flag is spelled. The id you addressed is
// then not the id you have. Naming what cannot be a NAME turns that into a
// question the author can answer.
export function oddNames(a: Attrs): { kind: "id" | "class" | "flag" | "key"; name: string }[] {
  const odd: { kind: "id" | "class" | "flag" | "key"; name: string }[] = [];
  if (a.id !== undefined && !NAME.test(a.id)) odd.push({ kind: "id", name: a.id });
  for (const c of a.classes) if (!NAME.test(c)) odd.push({ kind: "class", name: c });
  for (const [k, v] of Object.entries(a.attrs)) {
    if (NAME.test(k)) continue;
    odd.push({ kind: v === true ? "flag" : "key", name: k });
  }
  return odd;
}

// §4 value typing: quoted -> string, true/false -> boolean, integer/float
// syntax -> number, any other bare word -> string. No arrays/dates/tables.
// §4: inside a quoted value, `\"` is a quote and `\\` is a backslash — the only
// two escapes the grammar has. Any other `\x` is not an escape-seq (the grammar
// admits no bare backslash there), and is kept as written rather than dropped.
export function unescapeQuoted(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "\\" && i + 1 < inner.length && (inner[i + 1] === '"' || inner[i + 1] === "\\")) { out += inner[i + 1]; i++; continue; }
    out += c;
  }
  return out;
}

export function coerce(raw: string): Value {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return unescapeQuoted(t.slice(1, -1)); // quoted -> always string
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return parseFloat(t);
  return t; // bare word -> string
}

// Split on whitespace while keeping double-quoted spans intact. An escaped
// quote (§4 `\"`) does not end the span — it used to, and `caption="a \"b\""`
// then split into three tokens; the serializer, having no way to write a quote,
// emitted one unescaped and the round trip changed the block's attributes.
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuote && ch === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
      cur += ch + s[i + 1]!;
      i++;
    } else if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (!inQuote && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Parse `{#id .class key=val key2="a b"}` (braces included).
export function parseAttrs(src: string): Attrs {
  const inner = src.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Attrs = { classes: [], attrs: {} };
  for (const tok of tokenize(inner)) {
    if (tok.startsWith("#")) {
      out.id = tok.slice(1);
    } else if (tok.startsWith(".")) {
      out.classes.push(tok.slice(1));
    } else {
      const eq = tok.indexOf("=");
      if (eq > 0) out.attrs[tok.slice(0, eq)] = coerce(tok.slice(eq + 1));
      else out.attrs[tok] = true; // bare word -> boolean flag (e.g. `hidden`)
    }
  }
  return out;
}
