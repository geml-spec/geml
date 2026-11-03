// GEML format readers for Godot's text files (spec §3.2, "Engines supplied for
// a run"): a `data` block whose `src=` names a `.tscn`, `.tres`, `project.godot`
// or `.import` file is read through these, handed to geml by whoever runs it —
//
//   geml check design.geml --reader integrations/godot/src/reader.mjs
//
// — never by the document. A reader only READS: it returns the file as a value
// tree plus the extent of every value's text, and a coordinate edit is geml's
// own splice at that extent, read back through this same reader (§8.2(10)).
// So the one property everything rests on is that a reader reads the WHOLE
// file or throws: text it skipped would be text a write could not see.
//
// The value tree (a scene; a `.tres` has `header` and `resource` instead of
// `scene` and `nodes`):
//
//   scene        the [gd_scene …] header's attributes
//   ext          [ext_resource] by id      — { type, uid, path, … }
//   sub          [sub_resource] by id      — { "@type", …properties }
//   nodes        [node] by path from the root, the root being "."
//                                           — { "@type", "@unique_id", …properties }
//   connections  [connection] in file order — { signal, from, to, method, … }
//   editable     [editable] in file order   — { path }
//
// A config file (`project.godot`, `.import`, `.cfg`) is its sections by name,
// with any key before the first section at the top. A key written with `/`
// (`window/size/viewport_width`) is one key: Godot writes it that way, and a
// coordinate copied from the file should find it.
//
// Values: JSON's scalars and Godot's arrays and dictionaries become the tree's
// own; everything else Godot writes — `Vector2(240, 450)`, `ExtResource("1")`,
// `&"walk"`, `Array[int]([1])`, `inf` — stays the text it was written as, so a
// write puts back exactly what it is given. An integer past 2^53 stays text
// too: as a number it would read back as another one.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** A file the reader cannot read whole. Thrown, so geml refuses rather than guesses. */
export class GodotReadError extends Error {}

const key = (k) => (typeof k === "number" ? `[${k}]` : `[${JSON.stringify(k)}]`);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/**
 * Read Godot's text format. `kind` is "resource" for `.tscn`/`.tres` and
 * "config" for ConfigFile text. Returns the tree and a Map from a coordinate's
 * text (`["nodes"]["Player"]["speed"]`) to its [start, end) extent.
 */
export function parseGodot(text, kind) {
  let i = 0;
  const extents = new Map();
  const fail = (why) => {
    const line = text.slice(0, i).split("\n").length;
    throw new GodotReadError(`${why} (line ${line}: ${JSON.stringify(text.slice(i, i + 40))})`);
  };
  const ws = () => { while (i < text.length && " \t\r\n".includes(text[i])) i++; };
  const ident = () => { IDENT.lastIndex = i; const m = IDENT.exec(text); if (!m) return null; i += m[0].length; return m[0]; };

  // A string's decoded text. Godot escapes as C does, \u and \U included.
  function string() {
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("a string is never closed");
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c !== "\\") { out += c; i++; continue; }
      const e = text[i + 1];
      const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", "/": "/", "'": "'" }[e];
      if (simple !== undefined) { out += simple; i += 2; continue; }
      const width = e === "u" ? 4 : e === "U" ? 6 : 0;
      const hex = text.slice(i + 2, i + 2 + width);
      if (width === 0 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) fail(`\`\\${e}\` is not an escape Godot writes`);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 2 + width;
    }
  }

  // Skip one bracketed run — `(…)` or `[…]` — counting only its own brackets,
  // and stepping over strings whole so a `)` inside one does not end it.
  function balanced(open, close) {
    let depth = 0;
    do {
      if (i >= text.length) fail(`\`${open}\` is never closed`);
      const c = text[i];
      if (c === '"') { string(); continue; }
      if (c === open) depth++;
      else if (c === close) depth--;
      i++;
    } while (depth > 0);
  }

  // A dictionary key as a name: a string or a StringName is its text, a number
  // its digits, anything else the text it was written as.
  function keyName(v, start) {
    if (typeof v === "string") return /^&"/.test(text.slice(start, start + 2)) ? JSON.parse(text.slice(start + 1, i)) : v;
    if (typeof v === "number") return String(v);
    return text.slice(start, i);
  }

  function value(path) {
    ws();
    const start = i;
    const c = text[i];
    let v;
    if (c === "[") {
      i++; v = []; ws();
      while (text[i] !== "]") {
        if (i >= text.length) fail("an array is never closed");
        v.push(value(path + key(v.length))); ws();
        if (text[i] === ",") { i++; ws(); } else if (text[i] !== "]") fail("expected `,` or `]` in an array");
      }
      i++;
    } else if (c === "{") {
      i++; v = {}; ws();
      while (text[i] !== "}") {
        if (i >= text.length) fail("a dictionary is never closed");
        const ks = i;
        const k = keyName(value("\u0000"), ks); ws();
        if (Object.prototype.hasOwnProperty.call(v, k)) fail(`two keys of one dictionary read as \`${k}\``);
        if (text[i] !== ":") fail("expected `:` after a dictionary key");
        i++;
        v[k] = value(path + key(k)); ws();
        if (text[i] === ",") { i++; ws(); } else if (text[i] !== "}") fail("expected `,` or `}` in a dictionary");
      }
      i++;
    } else if (c === '"') {
      v = string();
    } else if ((c === "&" || c === "^") && text[i + 1] === '"') {
      i++; string(); v = text.slice(start, i);
    } else if (c === "-" || c === "." || (c >= "0" && c <= "9")) {
      if (text.startsWith("-inf", i)) { i += 4; v = "-inf"; }
      else {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(text);
        if (!m) fail("not a value");
        i += m[0].length;
        const n = Number(m[0]);
        v = /^-?\d+$/.test(m[0]) && !Number.isSafeInteger(n) ? m[0] : n;
      }
    } else {
      const word = ident();
      if (word === null) fail("not a value");
      if (text[i] === "[") balanced("[", "]"); // a typed collection: Array[int](…)
      if (text[i] === "(") { balanced("(", ")"); v = text.slice(start, i); }
      else if (word === "true" || word === "false") v = word === "true";
      else if (word === "null") v = null;
      else if (word === "inf" || word === "nan" || word === "inf_neg") v = word;
      else fail(`\`${word}\` is not a value`);
    }
    if (!path.includes("\u0000")) extents.set(path, [start, i]);
    return v;
  }

  // `[tag key=value …]`, ending its line. A config section's name is all of
  // what the brackets hold — `[preset.0.options]` — and carries no attributes.
  function header() {
    const at = i;
    i++;
    if (kind === "config") {
      const close = text.indexOf("]", i);
      const nl = text.indexOf("\n", i);
      if (close < 0 || (nl >= 0 && nl < close)) fail("a section header is never closed");
      const tag = text.slice(i, close);
      if (tag.trim() === "") fail("a section header has no name");
      i = close + 1;
      endOfLine();
      return { tag, attrs: {}, spans: {}, at };
    }
    const tag = ident();
    if (tag === null) fail("a section header has no name");
    const attrs = {};
    const spans = {};
    for (;;) {
      while (text[i] === " " || text[i] === "\t") i++;
      if (text[i] === "]") { i++; break; }
      const k = ident();
      if (k === null) fail("expected an attribute or `]` in a section header");
      if (text[i] !== "=") fail("expected `=` after a header attribute");
      i++;
      const s = i;
      attrs[k] = value("\u0000");
      spans[k] = [s, i];
    }
    endOfLine();
    return { tag, attrs, spans, at };
  }

  function endOfLine() {
    while (text[i] === " " || text[i] === "\t" || text[i] === "\r") i++;
    if (i < text.length && text[i] !== "\n") fail("more text after a value on the same line");
  }

  // A property's name: everything before ` = `, or a quoted string.
  function propertyName() {
    if (text[i] === '"') { const k = string(); while (text[i] === " ") i++; return k; }
    const eq = text.indexOf("=", i);
    const nl = text.indexOf("\n", i);
    if (eq < 0 || (nl >= 0 && nl < eq)) fail("a line that is neither a section nor `key = value`");
    const k = text.slice(i, eq).trim();
    if (k === "") fail("a property with no name");
    i = eq;
    return k;
  }

  const tree = {};
  let target = tree;
  let base = "";
  let sectionStart = -1;
  let sectionPath = null;
  const closeSection = (end) => {
    if (sectionPath === null) return;
    let e = end;
    while (e > sectionStart && " \t\r\n".includes(text[e - 1])) e--;
    extents.set(sectionPath, [sectionStart, e]);
  };

  const scene = { ext: {}, sub: {}, nodes: {}, connections: [], editable: [] };
  const instanced = new Set(); // node paths whose children come from another file
  let resourceFile = null;

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
    if (i >= text.length) break;
    if (kind === "config" && text[i] === ";") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (text[i] === "[") {
      closeSection(i);
      const h = header();
      sectionStart = h.at;
      // A section that also holds properties — a node, a sub-resource — keeps
      // its header's attributes under `@`-names: a script may export a
      // property called `type`, and VisualShaderNodeCompare has one, so the
      // header's `type` cannot share their namespace. No property name Godot
      // writes begins with `@`.
      const own = (path, attrs, spans, drop = [], mark = "") => {
        const o = {};
        for (const [k, v] of Object.entries(attrs)) if (!drop.includes(k)) { o[mark + k] = v; extents.set(path + key(mark + k), spans[k]); }
        return o;
      };
      if (kind === "config") {
        if (Object.prototype.hasOwnProperty.call(tree, h.tag)) fail(`a second [${h.tag}] section`);
        sectionPath = key(h.tag);
        tree[h.tag] = target = own(sectionPath, h.attrs, h.spans);
        base = sectionPath;
        continue;
      }
      if (resourceFile === null) {
        if (h.tag !== "gd_scene" && h.tag !== "gd_resource") fail("a scene or resource file begins with [gd_scene] or [gd_resource]");
        resourceFile = h.tag === "gd_scene" ? "scene" : "header";
        sectionPath = key(resourceFile);
        tree[resourceFile] = target = own(sectionPath, h.attrs, h.spans);
        base = sectionPath;
        continue;
      }
      const id = h.attrs.id === undefined ? undefined : String(h.attrs.id);
      if (h.tag === "ext_resource" || h.tag === "sub_resource") {
        const table = h.tag === "ext_resource" ? scene.ext : scene.sub;
        if (id === undefined) fail(`[${h.tag}] has no id`);
        if (Object.prototype.hasOwnProperty.call(table, id)) fail(`a second [${h.tag}] with id ${id}`);
        sectionPath = key(h.tag === "ext_resource" ? "ext" : "sub") + key(id);
        table[id] = target = own(sectionPath, h.attrs, h.spans, ["id"], h.tag === "sub_resource" ? "@" : "");
      } else if (h.tag === "node") {
        const { name, parent } = h.attrs;
        if (typeof name !== "string") fail("[node] has no name");
        const path = parent === undefined ? "." : parent === "." ? name : `${parent}/${name}`;
        if (Object.prototype.hasOwnProperty.call(scene.nodes, path)) fail(`a second node at \`${path}\``);
        sectionPath = key("nodes") + key(path);
        scene.nodes[path] = target = own(sectionPath, h.attrs, h.spans, ["name", "parent"], "@");
        if (h.attrs.instance !== undefined) instanced.add(path);
      } else if (h.tag === "connection" || h.tag === "editable") {
        const list = h.tag === "connection" ? scene.connections : scene.editable;
        sectionPath = key(h.tag === "connection" ? "connections" : "editable") + key(list.length);
        list.push(target = own(sectionPath, h.attrs, h.spans));
      } else if (h.tag === "resource") {
        if (Object.prototype.hasOwnProperty.call(tree, "resource")) fail("a second [resource] section");
        sectionPath = key("resource");
        tree.resource = target = {};
      } else {
        fail(`[${h.tag}] is not a section a scene or resource file has`);
      }
      base = sectionPath;
      continue;
    }
    // `key = value`, the value possibly spanning lines
    const k = propertyName();
    if (text[i] !== "=") fail("expected `=` after a property name");
    i++;
    if (Object.prototype.hasOwnProperty.call(target, k)) fail(`\`${k}\` is set twice in one section`);
    target[k] = value(base + key(k));
    endOfLine();
  }
  closeSection(text.length);

  if (kind === "resource") {
    if (resourceFile === null) fail("not a scene or resource file");
    if (resourceFile === "scene") Object.assign(tree, { ext: scene.ext, sub: scene.sub, nodes: scene.nodes, connections: scene.connections });
    else Object.assign(tree, { ext: scene.ext, sub: scene.sub });
    if (scene.editable.length > 0) tree.editable = scene.editable;
  }
  return { tree, extents, instanced };
}

// ---------------------------------------------------------------------------
// Godot's own reference rules, reported as the reader's diagnostics.
// ---------------------------------------------------------------------------

// An id never holds a `(`: leaving it out keeps a run of unclosed
// `ExtResource(` from rescanning the rest of the string at every one.
const RESOURCE_REF = /(Ext|Sub)Resource\(\s*"?([^"()\s]+)"?\s*\)/g;

// Whether `path` may name a node this file does not declare: one inside an
// instanced scene (editable children, or a connection reaching into it), or
// any node at all when the root itself is instanced — an inherited scene,
// whose base declares the rest.
function outsideThisFile(path, instanced) {
  if (instanced.has(".")) return true;
  for (const p of instanced) if (path === p || path.startsWith(`${p}/`)) return true;
  return false;
}

function projectRoot(file) {
  if (!file) return null;
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, "project.godot"))) return d;
    if (dirname(d) === d) return null;
  }
}

/** The four kinds of reference a scene file can leave dangling. */
export function diagnose(tree, instanced, file) {
  const out = [];
  (function walk(v, at) {
    if (typeof v === "string") {
      for (const m of v.matchAll(RESOURCE_REF)) {
        const table = m[1] === "Ext" ? tree.ext : tree.sub;
        if (table !== undefined && !Object.prototype.hasOwnProperty.call(table, m[2])) {
          out.push({ code: `unknown-${m[1].toLowerCase()}-resource`, at, message: `${m[1]}Resource("${m[2]}") names no [${m[1].toLowerCase()}_resource]` });
        }
      }
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, [...at, Array.isArray(v) ? Number(k) : k]);
    }
  })(tree, []);
  const nodes = tree.nodes ?? {};
  for (const [n, c] of (tree.connections ?? []).entries()) {
    for (const end of ["from", "to"]) {
      const p = c[end];
      if (typeof p === "string" && !Object.prototype.hasOwnProperty.call(nodes, p) && !outsideThisFile(p, instanced)) {
        out.push({ code: "connection-node-missing", at: ["connections", n, end], message: `no node \`${p}\`` });
      }
    }
  }
  for (const p of Object.keys(nodes)) {
    if (p === ".") continue;
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
    if (!Object.prototype.hasOwnProperty.call(nodes, parent) && !outsideThisFile(parent, instanced)) {
      out.push({ code: "parent-missing", at: ["nodes", p], message: `its parent \`${parent}\` is not a node` });
    }
  }
  const root = projectRoot(file);
  if (root !== null) {
    for (const [id, e] of Object.entries(tree.ext ?? {})) {
      if (typeof e.path !== "string" || !e.path.startsWith("res://")) continue;
      const rel = e.path.slice("res://".length).split("::")[0];
      if (!existsSync(join(root, rel))) out.push({ code: "res-path-missing", at: ["ext", id, "path"], message: `\`${e.path}\` does not exist` });
    }
  }
  return out;
}

const stepsOf = (k) => [...k.matchAll(/\[(?:"((?:[^"\\]|\\.)*)"|(\d+))\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : JSON.parse(`"${m[1]}"`)));
const extentList = (extents) => [...extents].map(([k, [start, end]]) => ({ at: stepsOf(k), start, end }));

function readScene(text, ctx) {
  const { tree, extents, instanced } = parseGodot(text, "resource");
  return { value: tree, extents: extentList(extents), diagnostics: diagnose(tree, instanced, ctx?.path) };
}

function readConfig(text) {
  const { tree, extents } = parseGodot(text, "config");
  return { value: tree, extents: extentList(extents), diagnostics: [] };
}

export default {
  readers: [
    { format: "godot-scene", extensions: [".tscn", ".tres"], read: readScene },
    { format: "godot-config", extensions: [".godot", ".import", ".cfg"], read: readConfig },
  ],
};
