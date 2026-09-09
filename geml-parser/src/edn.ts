// AN EDN SUBSET, for the `data` block's `edn` format (§3.2).
//
// Why a subset, and why written out rather than pulled in: EDN's value domain
// is larger than the one §3.2 has, so a reader has to DECIDE how each extra
// kind lands in the value tree.
//
// THIS READING IS NOT IN THE SPEC, deliberately. §3.2 reserves the name `edn`
// so a processor without an engine degrades the same way it does for `yaml` and
// `toml` — but unlike `yaml`, no subset and no reading are mandated, because
// `edn` has exactly one consumer here (the Logseq integration) and a reading
// pinned by one use case is a reading the second one has to live with. So this
// is THIS PROCESSOR'S reading, and it can change until there is a second user
// to calibrate it against; the cost, stated plainly, is that another processor
// with an `edn` engine could read the same body differently until it is
// specified. That is the trade §0.1 already makes for everything else here:
// move with the first genuine use case rather than guess ahead of it.
//
// In the subset, and how each kind reads:
//   nil / true / false          -> null / boolean
//   integers, floats            -> number
//   strings                     -> string
//   keywords  `:k`, `:ns/k`     -> the string WITH its colon, `":k"`
//   vectors   `[…]`             -> array
//   sets      `#{…}`            -> {"$set": [ … ]}
//   maps      `{…}`             -> object
//   `#uuid "…"`                 -> {"$uuid": "…"}
//   `#inst "…"`                 -> {"$inst": "…"}
//   `;` comments, `#_` discard, and commas as whitespace
//
// A keyword keeps its colon because a keyword is NOT a string — `:x` and `"x"`
// are different EDN values, and erasing the difference would make the reading
// non-reversible and the round trip a lie. The `$`-prefixed wrappers exist for
// the same reason: `#uuid "x"` is not the string `"x"`.
//
// That choice costs two refusals, both named below: a STRING key beginning with
// `:` would collide with a keyword of that name, and one beginning with `$`
// would collide with a wrapper. Refusing them keeps the encoding injective.
//
// Refused, each with its own sentence: lists `(…)`, symbols, characters `\a`,
// bignums `42N` / `1.0M`, ratios `1/3`, tagged literals other than uuid and
// inst, and the two string-key shapes above. Refusing by name is the point —
// a reader that guessed would be the divergence the subset prevents.
//
// Zero dependencies, like the rest of this parser: it is bundled into a browser
// extension, where an EDN library would be both weight and supply chain.
import { type DataValue } from "./geml.js";

export type EdnResult = { value: DataValue } | { error: string; line: number };

/** The wrapper keys this reading reserves. A string key may not begin with `$`. */
const WRAP_SET = "$set";
const WRAP_UUID = "$uuid";
const WRAP_INST = "$inst";

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",";
// EDN symbol/keyword constituents. Deliberately permissive: what matters here
// is finding the token's END, and anything that is not a legal name is refused
// by the caller with a sentence about what it actually was.
const isNameChar = (c: string): boolean => /[A-Za-z0-9*+!\-_?$%&=<>:#.'/]/.test(c);

class Reader {
  readonly text: string;
  i = 0;
  constructor(text: string) { this.text = text; }

  /** 0-based line of the current position, for diagnostics. */
  line(at = this.i): number {
    let n = 0;
    for (let k = 0; k < at && k < this.text.length; k++) if (this.text[k] === "\n") n++;
    return n;
  }

  /** Whitespace, commas, `;` comments and `#_` discards, in one pass. */
  skip(): void {
    for (;;) {
      while (this.i < this.text.length && isSpace(this.text[this.i]!)) this.i++;
      if (this.text[this.i] === ";") {
        while (this.i < this.text.length && this.text[this.i] !== "\n") this.i++;
        continue;
      }
      // `#_` discards the NEXT datum entirely — read it and throw it away.
      if (this.text[this.i] === "#" && this.text[this.i + 1] === "_") {
        this.i += 2;
        this.value(); // may throw Refusal, which is right: a discarded datum
        continue;     // outside the subset is still outside it
      }
      return;
    }
  }

  /** The one way this reader reports: a sentence plus the line it happened on. */
  refuse(what: string, at = this.i): never {
    throw new Refusal(what, this.line(at));
  }

  value(): DataValue {
    this.skip();
    if (this.i >= this.text.length) this.refuse("the body ends where a value was expected");
    const c = this.text[this.i]!;
    if (c === "{") return this.map();
    if (c === "[") return this.vector();
    if (c === "(") this.refuse("a list `(…)` — this reading has vectors and sets, not lists");
    if (c === '"') return this.string();
    if (c === "\\") this.refuse("a character literal `\\x`");
    if (c === "#") return this.dispatch();
    return this.atom();
  }

  map(): DataValue {
    const open = this.i;
    this.i++; // {
    const out: { [k: string]: DataValue } = {};
    for (;;) {
      this.skip();
      if (this.i >= this.text.length) this.refuse("a map that is never closed with `}`", open);
      if (this.text[this.i] === "}") { this.i++; return out; }
      const keyAt = this.i;
      // Whether the key was WRITTEN as a string literal, which `mapKey` cannot
      // tell afterwards: a keyword and a string both arrive as a JS string, and
      // the whole point of that check is telling `:x` from `":x"`.
      const wasString = this.text[this.i] === '"';
      const key = this.value();
      const name = this.mapKey(key, wasString, keyAt);
      this.skip();
      if (this.i >= this.text.length || this.text[this.i] === "}") {
        this.refuse(`the map key \`${name}\` has no value`, keyAt);
      }
      if (Object.prototype.hasOwnProperty.call(out, name)) {
        this.refuse(`the map has the key \`${name}\` twice`, keyAt);
      }
      out[name] = this.value();
    }
  }

  /**
   * A map key, as the object key it becomes. Keywords keep their colon, strings
   * stay bare — so a string may not LOOK like a keyword or a wrapper, or two
   * different EDN maps would encode to the same object.
   */
  mapKey(key: DataValue, wasString: boolean, at: number): string {
    if (typeof key !== "string") {
      this.refuse(`a map key that is ${describe(key)} — this reading has keyword and string keys`, at);
    }
    if (!wasString) return key; // a keyword; the colon is part of it
    if (key.startsWith(":")) {
      this.refuse(`the string key \`"${key}"\` — it would encode as the keyword \`${key}\` does`, at);
    }
    if (key.startsWith("$")) {
      this.refuse(`the string key \`"${key}"\` — a leading \`$\` is reserved for ${WRAP_UUID}/${WRAP_INST}/${WRAP_SET}`, at);
    }
    return key;
  }

  vector(): DataValue {
    const open = this.i;
    this.i++; // [
    const out: DataValue[] = [];
    for (;;) {
      this.skip();
      if (this.i >= this.text.length) this.refuse("a vector that is never closed with `]`", open);
      if (this.text[this.i] === "]") { this.i++; return out; }
      out.push(this.value());
    }
  }

  string(): string {
    const open = this.i;
    this.i++; // "
    let s = "";
    while (this.i < this.text.length) {
      const c = this.text[this.i]!;
      if (c === '"') { this.i++; return s; }
      if (c === "\\") {
        const e = this.text[this.i + 1];
        this.i += 2;
        if (e === "n") { s += "\n"; continue; }
        if (e === "t") { s += "\t"; continue; }
        if (e === "r") { s += "\r"; continue; }
        if (e === '"' || e === "\\") { s += e; continue; }
        if (e === "u") {
          const hex = this.text.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.refuse("a `\\u` escape without four hex digits", this.i);
          s += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          continue;
        }
        this.refuse(`the string escape \`\\${e ?? ""}\``, this.i - 2);
      }
      s += c;
      this.i++;
    }
    this.refuse("a string that is never closed", open);
  }

  /** `#{…}` a set, `#uuid`/`#inst` a tagged literal, anything else refused. */
  dispatch(): DataValue {
    const at = this.i;
    this.i++; // #
    if (this.text[this.i] === "{") {
      const open = this.i;
      this.i++;
      const members: DataValue[] = [];
      for (;;) {
        this.skip();
        if (this.i >= this.text.length) this.refuse("a set that is never closed with `}`", open);
        if (this.text[this.i] === "}") { this.i++; return { [WRAP_SET]: members }; }
        members.push(this.value());
      }
    }
    let j = this.i;
    while (j < this.text.length && isNameChar(this.text[j]!)) j++;
    const tag = this.text.slice(this.i, j);
    this.i = j;
    if (tag !== "uuid" && tag !== "inst") {
      this.refuse(tag === ""
        ? "a `#` that begins no set and no tag"
        : `the tagged literal \`#${tag}\` — this reading has \`#uuid\` and \`#inst\``, at);
    }
    this.skip();
    if (this.text[this.i] !== '"') this.refuse(`\`#${tag}\` without a string after it`, at);
    const s = this.string();
    return tag === "uuid" ? { [WRAP_UUID]: s } : { [WRAP_INST]: s };
  }

  /** nil, a boolean, a number, a keyword — or a refusal naming what it was. */
  atom(): DataValue {
    const at = this.i;
    let j = this.i;
    while (j < this.text.length && isNameChar(this.text[j]!)) j++;
    const t = this.text.slice(this.i, j);
    this.i = j;
    if (t === "") this.refuse(`the character \`${this.text[at]}\` begins no value this reading has`, at);
    if (t === "nil") return null;
    if (t === "true") return true;
    if (t === "false") return false;
    if (t.startsWith(":")) {
      if (t === ":") this.refuse("a bare `:` with no name after it", at);
      return t;
    }
    // Numbers, and the numeric shapes this reading refuses BY NAME rather than
    // rounding into a float: EDN's arbitrary-precision and ratio literals mean
    // something JSON's number cannot hold.
    if (/^[+-]?\d+[NM]$/.test(t) || /^[+-]?\d*\.\d+M$/.test(t)) {
      this.refuse(`the arbitrary-precision literal \`${t}\` — a JSON number cannot hold it`, at);
    }
    if (/^[+-]?\d+\/\d+$/.test(t)) this.refuse(`the ratio \`${t}\` — a JSON number cannot hold it`, at);
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return n;
      this.refuse(`the number \`${t}\` is not finite`, at);
    }
    this.refuse(`the symbol \`${t}\` — this reading has keywords, not symbols`, at);
  }
}

class Refusal extends Error {
  constructor(readonly what: string, readonly at: number) { super(what); }
}

function describe(v: DataValue): string {
  if (v === null) return "nil";
  if (Array.isArray(v)) return "a vector";
  if (typeof v === "object") return "a set or a tagged literal";
  return `the ${typeof v} \`${String(v)}\``;
}

/**
 * One EDN datum, as the value tree §3.2 has. A body with a second datum after
 * the first is refused: `data` holds ONE value, and `jsonl` is the shape for a
 * sequence of them.
 */
export function parseEdn(body: string[]): EdnResult {
  const r = new Reader(body.join("\n"));
  try {
    const value = r.value();
    r.skip();
    if (r.i < r.text.length) {
      return { error: "a second value after the first — a `data` block holds one", line: r.line() };
    }
    return { value };
  } catch (e) {
    if (e instanceof Refusal) return { error: e.what, line: e.at };
    throw e;
  }
}

// --- writing it back ---------------------------------------------------------

const isWrap = (v: DataValue, key: string): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length === 1 && Object.prototype.hasOwnProperty.call(v, key);

function scalar(v: DataValue): string {
  if (v === null) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // A keyword went in with its colon and comes back out with it; every other
  // string is quoted. This is the inverse of `mapKey`, which is why a bare
  // string beginning with `:` is refused on the way in.
  //
  // `render` handles every collection before delegating here, so a non-string
  // at this point is a value tree this module did not produce — JSON.stringify
  // is the honest answer for it rather than a cast that pretends otherwise.
  if (typeof v !== "string") return JSON.stringify(v);
  if (v.startsWith(":")) return v;
  return JSON.stringify(v);
}

/**
 * The value tree back to EDN text, laid out to be read: a map breaks one entry
 * per line and nests, vectors and sets stay inline. `geml set` writes through
 * this, so a coordinate write into an `edn` body re-emits EDN rather than
 * rewriting the block as JSON.
 */
export function serializeEdn(value: DataValue, indent = ""): string[] {
  return render(value, indent).split("\n");
}

function render(v: DataValue, indent: string): string {
  if (isWrap(v, WRAP_UUID)) return `#uuid ${JSON.stringify((v as { [k: string]: DataValue })[WRAP_UUID])}`;
  if (isWrap(v, WRAP_INST)) return `#inst ${JSON.stringify((v as { [k: string]: DataValue })[WRAP_INST])}`;
  if (isWrap(v, WRAP_SET)) {
    const members = (v as { [k: string]: DataValue })[WRAP_SET];
    if (!Array.isArray(members)) return `#{${render(members as DataValue, indent)}}`;
    return `#{${members.map((m) => render(m, indent)).join(" ")}}`;
  }
  if (Array.isArray(v)) return `[${v.map((m) => render(m, indent)).join(" ")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    const pad = indent + " ";
    const lines = entries.map(([k, val]) => {
      const key = k.startsWith(":") ? k : JSON.stringify(k);
      return pad + key + " " + render(val, pad + " ".repeat(key.length + 1));
    });
    return "{" + lines.join("\n").slice(pad.length) + "}";
  }
  return scalar(v);
}
