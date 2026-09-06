// A YAML SUBSET, for the `data` block's reserved `yaml` format (§3.2).
//
// Why a subset, stated up front: full YAML 1.2 is an enormous grammar, and the
// places it is large are exactly the places two implementations diverge —
// implicit typing (`yes` is a boolean in 1.1 and a string in 1.2), anchors and
// aliases, tags, merge keys, multi-document streams, flow collections with
// unquoted keys. A reference parser that guessed at those would make a document
// mean one thing here and another elsewhere, which is the failure the whole
// format exists to avoid. So this engine reads the part of YAML that maps
// exactly onto the value domain §3.2 already has — the same scalars, sequences
// and maps JSON gives — and REFUSES the rest by name instead of guessing.
//
// In the subset:
//   - block mappings (`key: value`), nested by indentation
//   - block sequences (`- item`), nested, including `- key: value`
//   - plain, single-quoted and double-quoted scalars
//   - block scalars: `|`, `|-`, `>`, `>-`
//   - comments, blank lines, and a leading `---`
//   - `[]` and `{}` as the empty sequence and the empty map
//   - YAML 1.2 **core schema** typing: `null`/`~`/empty → null, `true`/`false`
//     → boolean, JSON-shaped numbers → number, everything else a string. So
//     `yes`, `no`, `on`, `off` are STRINGS, as 1.2 says and 1.1 did not.
//
// Refused, each with its own sentence: anchors (`&`), aliases (`*`), tags (`!`),
// merge keys (`<<`), a second document, flow collections other than the two
// empty forms, and a tab used for indentation (which YAML forbids).
//
// Zero dependencies, like the rest of this parser: it is bundled into a browser
// extension, where a YAML library would be both weight and supply chain.
import { type DataValue } from "./geml.js";

export type YamlResult = { value: DataValue } | { error: string; line: number };

interface Line {
  /** 0-based index in the body, for diagnostics. */
  n: number;
  indent: number;
  text: string;
}

// The core schema's own numeric forms, not JSON's narrower ones: a document
// that writes `port: +80` or `mask: 0x1F` means a number, and reading it as the
// string "+80" would be the silent wrong answer this engine exists to avoid.
// `Number()` already reads every form these match, `0o`/`0x` included.
const INT = /^[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
/** `.inf` and `.nan` ARE core-schema floats — and have no value here (§3.2's domain is JSON's). */
const NON_FINITE = /^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/;

/** Strip a comment: a `#` at the start, or one preceded by whitespace, outside quotes. */
function stripComment(s: string): string {
  let qc: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (qc) {
      if (c === qc) qc = null;
      else if (qc === '"' && c === "\\") i++;
      continue;
    }
    if (c === '"' || c === "'") { qc = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
  }
  return s;
}

/** The core-schema reading of a plain scalar (§3.2's value domain, YAML 1.2). */
function plainScalar(raw: string): DataValue {
  const t = raw.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (INT.test(t) || FLOAT.test(t)) return Number(t);
  return t;
}

/** A quoted scalar, or null when `s` is not quoted. */
function quotedScalar(s: string): string | null {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    // YAML's single quotes take no escapes but `''` for one quote.
    return t.slice(1, -1).split("''").join("'");
  }
  return null;
}

/** Where a mapping key ends: the first `:` that is followed by space or ends the line. */
function keyEnd(s: string): number {
  let qc: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (qc) {
      if (c === qc) qc = null;
      else if (qc === '"' && c === "\\") i++;
      continue;
    }
    if (c === '"' || c === "'") { qc = c; continue; }
    if (c === ":" && (i + 1 === s.length || /\s/.test(s[i + 1]!))) return i;
  }
  return -1;
}

// Nesting is bounded. `- - - …` and indentation nest without limit in the
// grammar, and each level here is a JavaScript frame: six thousand of them, in a
// twelve-kilobyte body, ran the stack out and threw a RangeError straight
// through parse() — a crash, where every other malformed body earns a diagnostic
// and where the parser's own lists (5000 deep) and blocks (1000 deep) already
// answer with one. Generous for anything a person writes as config; far below
// where V8 gives up.
const MAX_DEPTH = 200;

class Refusal extends Error {
  constructor(message: string, readonly line: number) { super(message); }
}

export function parseYaml(body: string[]): YamlResult {
  const lines: Line[] = [];
  let sawDocStart = false;
  for (let i = 0; i < body.length; i++) {
    const raw = body[i]!;
    const content = stripComment(raw);
    if (content.trim() === "") continue;
    if (/^\s*---\s*$/.test(content)) {
      if (sawDocStart || lines.length > 0) {
        return { error: "a second document starts here; a `yaml` body is one document in this subset", line: i };
      }
      sawDocStart = true;
      continue;
    }
    if (/^\s*\.\.\.\s*$/.test(content)) continue; // an end-of-document marker is harmless
    const indent = content.length - content.replace(/^[ \t]+/, "").length;
    if (/^ *\t/.test(content)) {
      return { error: "a tab indents this line; YAML forbids tabs in indentation", line: i };
    }
    lines.push({ n: i, indent, text: content.trim() });
  }
  if (lines.length === 0) return { value: null };

  let p = 0;
  const peek = (): Line | undefined => lines[p];

  const refuseExtras = (text: string, n: number): void => {
    const t = text.trim();
    if (t.startsWith("&")) throw new Refusal("an anchor (`&name`) is outside this subset — write the value where it is used", n);
    if (t.startsWith("*")) throw new Refusal("an alias (`*name`) is outside this subset — write the value where it is used", n);
    if (t.startsWith("!")) throw new Refusal("a tag (`!name`) is outside this subset — the value domain is scalars, sequences and maps", n);
    if (NON_FINITE.test(t)) {
      throw new Refusal("`.inf` and `.nan` are outside this subset — the value domain here has no infinity and no NaN", n);
    }
    if (/^\{.+\}$|^\[.+\]$/.test(t)) {
      throw new Refusal("a flow collection is outside this subset — write it in block form (only `[]` and `{}` are read, as the empty sequence and map)", n);
    }
  };

  // A scalar written on the same line as its key or dash, or a block scalar
  // whose lines follow at a deeper indent.
  function inlineValue(text: string, at: number, parentIndent: number): DataValue {
    const t = text.trim();
    if (t === "[]") return [];
    if (t === "{}") return {};
    refuseExtras(t, at);
    const blockScalar = /^([|>])([-+]?)$/.exec(t);
    if (blockScalar) {
      const fold = blockScalar[1] === ">";
      const chomp = blockScalar[2]!; // `[-+]?` always participates, empty or not
      // A block scalar is TEXT, and `lines` is not the text: every line in it had
      // its `# comment` stripped and its blank lines dropped before parsing
      // began, which is right for structure and wrong for a literal — `|` with
      // `hello # not a comment` lost the tail, and a blank line inside a literal
      // vanished. The extent is still decided from `lines` (indent deeper than
      // the parent), but the content is read back from the RAW body over that
      // range, blank lines included.
      let first = -1;
      let last = -1;
      while (p < lines.length && lines[p]!.indent > parentIndent) {
        if (first < 0) first = lines[p]!.n;
        last = lines[p]!.n;
        p++;
      }
      if (first < 0) return chomp === "-" ? "" : "\n";
      const rawLines = body.slice(first, last + 1).map((r) => r.replace(/\r$/, ""));
      const base = Math.min(...rawLines.filter((r) => r.trim() !== "").map((r) => r.length - r.replace(/^[ \t]+/, "").length));
      const parts = rawLines.map((r) => (r.trim() === "" ? "" : r.slice(base)));
      let s = fold ? parts.join(" ") : parts.join("\n");
      if (chomp !== "-") s += "\n";
      return s;
    }
    const q = quotedScalar(t);
    const v = q === null ? plainScalar(t) : q;
    // `.inf` is refused by name above; `1e999` reached the same value through
    // Number() and came out as Infinity, which JSON then wrote as null. The
    // value domain here is JSON's (§3.2), and JSON has no infinity by any spelling.
    if (typeof v === "number" && !Number.isFinite(v)) throw new Refusal(`\`${t}\` has no finite value — the value domain here has no infinity`, at);
    return v;
  }

  // The block at `indent`: a mapping, or a sequence, decided by its first line.
  function parseBlock(indent: number, depth: number): DataValue {
    // Every caller has already checked there is a line here: the top level
    // returns early on an empty body, and the two nested calls guard on `p`.
    const first = peek()!;
    if (depth > MAX_DEPTH) throw new Refusal(`nesting deeper than ${MAX_DEPTH} levels is outside this subset`, first.n);
    if (first.text === "-" || first.text.startsWith("- ")) return parseSeq(indent, depth);
    return parseMap(indent, depth);
  }

  function parseSeq(indent: number, depth: number): DataValue {
    const out: DataValue[] = [];
    while (p < lines.length) {
      const l = peek()!;
      if (l.indent < indent) break;
      if (l.indent > indent) throw new Refusal("this line is indented deeper than the sequence it belongs to", l.n);
      if (l.text !== "-" && !l.text.startsWith("- ")) break;
      const rest = l.text === "-" ? "" : l.text.slice(2).trim();
      const at = l.n;
      p++;
      if (rest === "") {
        // The item's content follows, deeper.
        if (p < lines.length && lines[p]!.indent > indent) out.push(parseBlock(lines[p]!.indent, depth + 1));
        else out.push(null);
        continue;
      }
      // `- key: value` is a sequence item that is a mapping, and `- - 1` one
      // that is a sequence: in both the nested block starts at the column the
      // content does, which is where its own continuation lines will sit. So
      // put the content back as a line at that column and parse a block there.
      if (rest === "-" || rest.startsWith("- ") || keyEnd(rest) >= 0) {
        const afterDash = l.text.slice(1);
        const inner = indent + 1 + (afterDash.length - afterDash.replace(/^ +/, "").length);
        lines.splice(p, 0, { n: at, indent: inner, text: rest });
        out.push(parseBlock(inner, depth + 1));
        continue;
      }
      out.push(inlineValue(rest, at, indent));
    }
    return out;
  }

  function parseMap(indent: number, depth: number): DataValue {
    const out: { [k: string]: DataValue } = {};
    // `out[key] = v` with key `__proto__` does not set a key: it REPLACES the
    // object's prototype, so a `__proto__:` mapping made every later lookup
    // inherit from the author's value tree and JSON.stringify dropped the key.
    // Defined as an own property instead, it is data like any other key.
    const setKey = (k: string, v: DataValue): void => {
      if (k === "__proto__") Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      else out[k] = v;
    };
    while (p < lines.length) {
      const l = peek()!;
      if (l.indent < indent) break;
      if (l.indent > indent) throw new Refusal("this line is indented deeper than the mapping it belongs to", l.n);
      if (l.text === "-" || l.text.startsWith("- ")) break;
      const cut = keyEnd(l.text);
      if (cut < 0) throw new Refusal(`\`${l.text.slice(0, 40)}\` is neither a mapping entry (\`key: value\`) nor a sequence item (\`- value\`)`, l.n);
      const rawKey = l.text.slice(0, cut).trim();
      if (rawKey.startsWith("<<")) throw new Refusal("a merge key (`<<`) is outside this subset — write the keys out", l.n);
      // "Refused by name" applied to values only: `&a k: 1`, `*a: 1` and `!!str k: 1`
      // were read as the literal keys `&a k`, `*a`, `!!str k`. A key is a scalar
      // too, and the same spellings are outside the subset there.
      refuseExtras(rawKey, l.n);
      const qk = quotedScalar(rawKey);
      const key = qk === null ? rawKey : qk;
      const rest = l.text.slice(cut + 1).trim();
      const at = l.n;
      p++;
      if (rest === "") {
        if (p < lines.length && lines[p]!.indent > indent) setKey(key, parseBlock(lines[p]!.indent, depth + 1));
        else if (p < lines.length && lines[p]!.indent === indent && (lines[p]!.text === "-" || lines[p]!.text.startsWith("- "))) {
          // A sequence may sit at the SAME indent as its key, which is the
          // shape most YAML in the wild is written in.
          setKey(key, parseSeq(indent, depth + 1));
        } else setKey(key, null);
        continue;
      }
      setKey(key, inlineValue(rest, at, indent));
    }
    return out;
  }

  try {
    const value = parseBlock(lines[0]!.indent, 0);
    if (p < lines.length) {
      return { error: `\`${lines[p]!.text.slice(0, 40)}\` is not part of the document above it`, line: lines[p]!.n };
    }
    return { value };
  } catch (e) {
    if (e instanceof Refusal) return { error: e.message, line: e.line };
    throw e;
  }
}
