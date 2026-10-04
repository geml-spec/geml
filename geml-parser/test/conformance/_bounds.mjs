// The boundary cases for the fixed bounds of GEML (§9.2) and of the geml-media
// profile (§8.1) — and of geml-style, whose frame nesting is bounded by the
// core's `chain-depth` — made from each specification's table of fixed bounds, so that
// each value is stated in one place and a case cannot sit on an edge the table
// has moved.
//
//   node _bounds.mjs           exit 1 if a case file holds other boundary cases
//   node _bounds.mjs --write   rewrite them in place
//
// A boundary case carries `bound`, the name of the bound it sits on. In each
// file named below, the cases with a `bound` are exactly the ones made here, in
// this order, standing where the first of them stood.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

/** A specification's table of fixed bounds — the one whose header is Name | Value — as name → number. */
export function readBounds(text) {
  const lines = text.split("\n");
  const heads = lines.flatMap((l, i) => (/^\|\s*(Name|名字)\s*\|\s*(Value|值)\s*\|/.test(l) ? [i] : []));
  if (heads.length !== 1) throw new Error(`expected one table of fixed bounds, found ${heads.length}`);
  const out = {};
  for (const l of lines.slice(heads[0] + 2)) {
    const m = /^\|\s*`([a-z-]+)`\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\b/.exec(l);
    if (!m) break;
    out[m[1]] = Number(m[2].replaceAll(",", ""));
  }
  return out;
}

export const SPEC = join(repo, "spec", "GEML-spec.md");
export const MEDIA_PROFILE = join(repo, "spec", "profiles", "geml-media", "geml-media-profile.md");

const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");
const nest = (n, open, inner, close) => open.repeat(n) + inner + close.repeat(n);
/** Spreadsheet column letters: 1 → A, 27 → AA. */
const letters = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** The core suite's boundary cases, by file, for the bounds in `b`. */
export function coreCases(b) {
  const D = b["data-depth"], C = b["table-cells"], L = b["chain-depth"];
  const data = (body, attrs = "") => `=== data {#d${attrs}}\n${body}\n===\n`;
  const yaml = (body) => `=== data {#y format=yaml}\n${body}\n===\n`;
  const bound = (name, rest) => ({ name: rest.name, bound: name, ...rest });

  // One column past: R rows of one cell under a row C/R + 1 cells wide.
  const R = Math.round(Math.sqrt(C)), W = Math.floor(C / R) + 1;
  const wide = `=== table {#t format=csv header=0}\n${Array(W).fill("v").join(",")}\n${"v\n".repeat(R - 1)}===\n`;

  const chain = (n) => {
    let s = "=== table {#t format=csv header=1}\nId, N\na, 1\n===\n";
    for (let i = 1; i <= n; i++) s += `\n=== view {#v${i} src=#${i === 1 ? "t" : `v${i - 1}`}}\n===\n`;
    return s;
  };
  const rows = ' view(["Id","N"] ["a","1"])';

  return {
    "data.json": [
      bound("data-depth", { name: `data: a value tree ${D} containers deep is data (§3.2)`,
        geml: data(nest(D, "[", "1", "]")), want: `data(${nest(D, "[", "1", "]")})`, diagnostics: [] }),
      bound("data-depth", { name: `data: a sequence inside ${D} others is outside the value tree — data-parse (§3.2, §9.2)`,
        geml: data(nest(D + 1, "[", "1", "]")), want: "block:data", diagnostics: ["data-parse:error"] }),
      bound("data-depth", { name: "data: the depth bound holds for each jsonl line",
        geml: data(`1\n${nest(D + 1, "[", "1", "]")}`, " format=jsonl"), want: "block:data", diagnostics: ["data-parse:error"] }),
      bound("data-depth", { name: "data: a map counts as a container like a sequence",
        geml: data(nest(D + 1, '{"a":', "1", "}")), want: "block:data", diagnostics: ["data-parse:error"] }),
    ],
    "yaml.json": [
      bound("data-depth", { name: `yaml: a value tree ${D} containers deep reads`,
        geml: yaml(`${"- ".repeat(D)}x`), want: `data(${nest(D, "[", '"x"', "]")})`, diagnostics: [] }),
      bound("data-depth", { name: `yaml: a sequence inside ${D} others is data-parse, as in json (§3.2)`,
        geml: yaml(`${"- ".repeat(D + 1)}x`), want: "block:data", diagnostics: ["data-parse:error"] }),
      bound("data-depth", { name: `yaml: an empty \`[]\` inside ${D} containers is the ${ordinal(D + 1)}`,
        geml: yaml(`${"- ".repeat(D)}[]`), want: "block:data", diagnostics: ["data-parse:error"] }),
    ],
    "views.json": [
      bound("table-cells", { name: `table: ${W} columns over ${R} rows is one column past table-cells — table-too-large, no rows, no ragged rows reported (§6, §9.2)`,
        geml: wide, want: `table(${JSON.stringify(Array.from({ length: W }, (_, i) => letters(i + 1)))})`, diagnostics: ["table-too-large:error"] }),
      bound("chain-depth", { name: `view: a chain of ${L} views publishes at its end (§6.1, §9.3)`,
        geml: chain(L), want: `table(["Id","N"] ["a","1"])${rows.repeat(L)}`, diagnostics: [] }),
      bound("chain-depth", { name: `view: the ${ordinal(L + 1)} view of a chain is view-source-too-deep and publishes no rows (§6.1, §9.3)`,
        geml: chain(L + 1), want: `table(["Id","N"] ["a","1"])${rows.repeat(L)} view([])`, diagnostics: ["view-source-too-deep:error"] }),
    ],
  };
}

/** geml-media/v1's boundary cases, for the bounds in its §8.1 table. */
export function mediaCases(b) {
  const T = b["max-time"], P = b["apart-tolerance"];
  const zero = "0".repeat(64);
  const head = '=== meta\nprofile = "geml-media/v1"\n===\n';
  const asset = (id, rest) => `\n=== media-asset {#${id} src=${id}.${rest.startsWith("kind=video") ? "mp4" : "png"} ${rest.replace(/^kind=(\w+)/, `kind=$1 sha256=${zero}`)}}\n===\n`;
  const two = (n) => String(n).padStart(2, "0");
  const timecode = (s) => `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:00`;
  // Each cut is within the bound and two of them end past it.
  const H = Math.floor(T / 2) + 1;
  const comp = (id, other) => `\n==== media-comp {#${id} size=100x100}\n` +
    `\n=== media-layer {#${id}-a src=#a x=0 y=0}\n===\n` +
    `\n=== media-layer {#${id}-${other} src=#${other}}\n===\n` +
    `\n=== media-interaction {#${id}-place a=#${id}-a:p b=#${id}-${other}:p kind=contact}\n===\n` +
    `\n=== media-interaction {#${id}-verify a=#${id}-a:q b=#${id}-${other}:q kind=contact}\n===\n\n====\n`;
  const unknown = (n) => Array(n).fill("unknown-block-type:warning");
  return [
    { name: "every time is at most max-time, and so is where a cut ends — media-time-out-of-range", bound: "max-time",
      geml: head + asset("v", `kind=video duration=${T}`) + asset("w", `kind=video duration=${T + 1}`) +
        '\n==== media {#tl tracks="v:video" fps=24}\n' +
        `\n=== media-clip {#c1 track=v src=#v in=0 out=${H}}\n===\n` +
        `\n=== media-clip {#c2 track=v src=#v in=0 out=${H}}\n===\n` +
        `\n=== media-clip {#c3 track=v src=#v in=0 out="${timecode(T + 1)}"}\n===\n\n====\n`,
      addresses: { declared: ["#meta", "#v", "#w", "#tl", "#c1", "#c2", "#c3"], undeclared: ["#meta", "#v", "#w", "#tl"] },
      diagnostics: { declared: [], undeclared: unknown(3) },
      checks: ["media-file-missing:warning", "media-file-missing:warning", ...Array(3).fill("media-time-out-of-range:error")] },
    { name: "an interaction that only verifies may end up apart-tolerance apart, and no further — media-interaction-apart", bound: "apart-tolerance",
      geml: head + asset("a", 'kind=image points="p:0,0 q:10,0"') + asset("b", `kind=image points="p:0,0 q:${10 + P},0"`) +
        asset("c", `kind=image points="p:0,0 q:${10 + P + 1},0"`) + comp("at", "b") + comp("past", "c"),
      addresses: {
        declared: ["#meta", "#a", "#b", "#c", ...["at", "past"].flatMap((id) => [`#${id}`, `#${id}-a`, `#${id}-${id === "at" ? "b" : "c"}`, `#${id}-place`, `#${id}-verify`])],
        undeclared: ["#meta", "#a", "#b", "#c", "#at", "#past"] },
      diagnostics: { declared: [], undeclared: unknown(5) },
      checks: [...Array(3).fill("media-file-missing:warning"), "media-interaction-apart:warning"] },
  ];
}

/** geml-style/v1's view-model cases (`views`) on the core's `chain-depth`, which bounds frame nesting (§2.4). */
export function styleCases(core) {
  const L = core["chain-depth"];
  const shape = (id, slots) => ({ id, axis: "column", box: {}, variants: [], params: {}, slots });
  const chain = (n) => {
    let sheet = '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-screen {#page slots="#f1"}\n===\n';
    for (let i = 1; i <= n; i++) sheet += `\n=== style-frame {#f${i} slots="${i < n ? `#f${i + 1}` : "heading"}"}\n===\n`;
    return {
      files: { "site.style.geml": sheet, "d.geml": "# Title {#t}\n" },
      sheet: "site.style.geml",
      corpus: ["d.geml"],
      states: [],
      screens: [{ ...shape("page", [{ kind: "frame", frame: "f1" }]), bindings: [] }],
      frames: Array.from({ length: n }, (_, k) => shape(`f${k + 1}`, k + 1 < n
        ? [{ kind: "frame", frame: `f${k + 2}` }]
        : [{ kind: "blocks", selector: "heading", blocks: [{ doc: "d.geml", block: "#t" }] }])),
      bindings: [],
    };
  };
  return [
    { name: `frames may nest chain-depth (${L}) deep under a screen`, bound: "chain-depth", ...chain(L), diagnostics: [] },
    { name: `a frame ${L + 1} deep is past chain-depth — style-frame-too-deep, and the frames are still the view model's`, bound: "chain-depth",
      ...chain(L + 1), diagnostics: ["style-frame-too-deep:error"] },
  ];
}

/** `cases` with `made` standing where its boundary cases stood. */
export function placed(cases, made) {
  const at = cases.findIndex((c) => c.bound !== undefined);
  const rest = cases.filter((c) => c.bound === undefined);
  const i = at < 0 ? rest.length : cases.slice(0, at).filter((c) => c.bound === undefined).length;
  return [...rest.slice(0, i), ...made, ...rest.slice(i)];
}

const MEDIA_CASES = join(repo, "spec", "profiles", "geml-media", "conformance.json");
const STYLE_CASES = join(repo, "spec", "profiles", "geml-style", "conformance.json");

/** Each case file and the text it should hold, given the specifications' tables. */
export function expected(core = readBounds(readFileSync(SPEC, "utf8")), media = readBounds(readFileSync(MEDIA_PROFILE, "utf8"))) {
  const files = [
    ...Object.entries(coreCases(core)).map(([file, made]) => ({ path: join(here, file), made })),
    { path: MEDIA_CASES, made: mediaCases(media) },
    { path: STYLE_CASES, made: styleCases(core), key: "views" },
  ];
  return files.map(({ path, made, key = "cases" }) => {
    const text = readFileSync(path, "utf8");
    const json = JSON.parse(text);
    const out = Array.isArray(json) ? placed(json, made) : { ...json, [key]: placed(json[key], made) };
    return { path, text, want: JSON.stringify(out, null, 2) + "\n" };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  let stale = 0;
  for (const { path, text, want } of expected()) {
    if (text === want) continue;
    if (write) { writeFileSync(path, want); console.log(`wrote ${path}`); }
    else { stale++; console.log(`${path}: boundary cases differ from the table (node _bounds.mjs --write)`); }
  }
  process.exit(stale ? 1 : 0);
}
