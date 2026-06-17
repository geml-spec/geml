// Shared attribute-object and value typing (§4), used by the block scanner
// and the inline parser.

export type Value = string | number | boolean;

export interface Attrs {
  id?: string;
  classes: string[];
  attrs: Record<string, Value>;
}

// §4 value typing: quoted -> string, true/false -> boolean, integer/float
// syntax -> number, any other bare word -> string. No arrays/dates/tables.
export function coerce(raw: string): Value {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1); // quoted -> always string
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return parseFloat(t);
  return t; // bare word -> string
}

// Split on whitespace while keeping double-quoted spans intact.
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
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
    }
  }
  return out;
}
