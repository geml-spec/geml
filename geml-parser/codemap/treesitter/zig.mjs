// Zig profile for the tree-sitter export: how to read ONE Zig syntax tree.
//
// A profile is everything language-specific the export needs — the grammar to
// load, which files are its, and three generators over a parsed tree
// (definitions, namespace bindings, call sites). It never resolves a name:
// that is codemap/adapters/treesitter.mjs, which is language-agnostic. Adding a
// language = adding a sibling of this file.
//
// Grammar: tree-sitter-grammars/tree-sitter-zig (shapes verified against
// v1.1.2): `function_declaration` carries a `name` field and a bare `pub`
// token; a struct/enum/union/opaque body is a `*_declaration` node whose
// parent, when the container is named, is the `variable_declaration` binding
// it; `call_expression` has `function` + `arguments` fields; `@import(...)` is
// a `builtin_function` (builtin_identifier + arguments), never a call.
import { posix } from "node:path";

export const lang = "zig";
export const exts = ["zig"];
// Where the grammar's wasm may live, in resolution order: the all-grammars
// bundle the build pins, then the grammar's own npm packages.
export const wasm = [
  "tree-sitter-wasms/out/tree-sitter-zig.wasm",
  "@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm",
  "tree-sitter-zig/tree-sitter-zig.wasm",
];

const CONTAINERS = new Set(["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"]);

function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

const identOf = (varDecl) => varDecl.children.find((c) => c.type === "identifier")?.text ?? null;
const hasPub = (node) => node.children.some((c) => c.type === "pub");
const initializerOf = (varDecl) => {
  const i = varDecl.children.findIndex((c) => c.type === "=");
  return i >= 0 ? (varDecl.children[i + 1] ?? null) : null;
};
const stringContent = (str) =>
  str.children.filter((c) => c.type === "string_content" || c.type === "escape_sequence").map((c) => c.text).join("");
// `@import("x")` → "x"; any other builtin → null.
const importSpec = (builtin) => {
  if (builtin.child(0)?.text !== "@import") return null;
  const args = builtin.children.find((c) => c.type === "arguments");
  const str = args?.children.find((c) => c.type === "string");
  return str ? stringContent(str) : null;
};

// The container path of a node: the names of the enclosing fns and NAMED
// containers, outermost first. `const Client = struct { pub fn init() … }`
// gives init the path ["Client"]; a struct returned from `fn List(comptime T:
// type) type` gives its methods ["List"] (the anonymous struct contributes
// nothing — its generic constructor names it); a struct bound inside a fn
// body gives ["outerFn", "Inner"].
export function containerPath(node) {
  const path = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "function_declaration") path.push(p.childForFieldName("name")?.text ?? "(anon)");
    else if (CONTAINERS.has(p.type) && p.parent?.type === "variable_declaration") path.push(identOf(p.parent) ?? "(anon)");
  }
  return path.reverse();
}

// A name-path expression → its dotted segments, or null when the expression
// is not a name path at all (a literal, an operator…). A head that is not a
// plain identifier — a call result, an index, a deref, a `try` — becomes
// "<expr>" (the adapter can then only guess by the last segment); an
// `@import("x")` head becomes "@import:x" so the export can turn it into a
// file. `.foo` (an enum literal) is not a path.
export function flatten(n) {
  switch (n.type) {
    case "identifier": return [n.text];
    case "field_expression": {
      const obj = n.childForFieldName("object");
      const member = n.childForFieldName("member")?.text;
      if (!obj || !member) return null;
      const head = flatten(obj);
      return head ? [...head, member] : ["<expr>", member];
    }
    case "builtin_function": {
      const spec = importSpec(n);
      return spec !== null ? [`@import:${spec}`] : null;
    }
    case "parenthesized_expression": {
      const inner = n.namedChildren[0];
      return inner ? flatten(inner) : null;
    }
    case "call_expression": case "index_expression": case "dereference_expression":
    case "null_coercion_expression": case "try_expression": case "await_expression":
      return ["<expr>"];
    default: return null;
  }
}

// `@import("net.zig")` from src/main.zig → "src/net.zig" (repo-relative,
// POSIX); a package name (`std`, a build.zig.zon dependency) → null.
export function importTarget(spec, fromFile) {
  if (!spec.endsWith(".zig")) return null;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  return posix.normalize(dir ? `${dir}/${spec}` : spec);
}

// One row per `fn`, prototypes (extern) included — they are leaf nodes.
export function* definitions(root) {
  for (const n of walk(root)) {
    if (n.type !== "function_declaration") continue;
    const name = n.childForFieldName("name")?.text;
    if (!name) continue; // a fn TYPE (`fn (u8) void`) has no name
    yield { name, container: containerPath(n), pub: hasPub(n), lineStart: n.startPosition.row + 1, lineEnd: n.endPosition.row + 1 };
  }
}

// The `const` bindings a call path can travel through — imports, aliases,
// named containers, `@This()`. Value bindings (`const c = foo();`) are not
// namespaces and are skipped. Each carries the scope (container path) it is
// declared in, so the adapter searches innermost-first.
export function* bindings(root, fromFile) {
  for (const n of walk(root)) {
    if (n.type !== "variable_declaration") continue;
    const name = identOf(n);
    const init = initializerOf(n);
    if (!name || !init) continue;
    const scope = containerPath(n);
    const line = n.startPosition.row + 1;
    if (CONTAINERS.has(init.type)) { yield { name, kind: "struct", scope, line }; continue; }
    if (init.type === "builtin_function") {
      if (init.child(0)?.text === "@This") { yield { name, kind: "self", scope, line }; continue; }
      const spec = importSpec(init);
      if (spec !== null) yield { name, kind: "import", target: importTarget(spec, fromFile), scope, line };
      continue;
    }
    const path = flatten(init);
    if (!path || path[0] === "<expr>") continue;
    if (path[0].startsWith("@import:")) {
      // `const Conn = @import("net.zig").Client;` — an alias rooted in a file
      const target = importTarget(path[0].slice("@import:".length), fromFile);
      if (path.length === 1) yield { name, kind: "import", target, scope, line };
      else yield { name, kind: "alias", target, path: path.slice(1), scope, line };
      continue;
    }
    yield { name, kind: "alias", path, scope, line }; // `const A = net.Client;`
  }
}

// One row per call site: the callee as path segments and the enclosing fn.
// A call outside any fn — file scope, or inside `test "…" {}` — has no caller
// (Test nodes are out of scope for now) and the export drops it. Builtins are
// not call_expression nodes and never appear here.
export function* calls(root) {
  for (const n of walk(root)) {
    if (n.type !== "call_expression") continue;
    const fn = n.childForFieldName("function");
    const callee = fn ? flatten(fn) : null;
    if (!callee || (callee.length === 1 && callee[0] === "<expr>")) continue; // `f()()`: nothing nameable
    yield { line: n.startPosition.row + 1, caller: callerOf(n), callee };
  }
}

function callerOf(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "function_declaration") {
      return { name: p.childForFieldName("name")?.text ?? "(anon)", container: containerPath(p) };
    }
    if (p.type === "test_declaration") return null;
  }
  return null;
}
