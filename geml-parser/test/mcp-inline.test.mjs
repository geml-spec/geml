// The inline host of mcp-core: the document travels in `source`, a write comes
// back as `document`, and nothing is kept between calls. This is the host a
// stateless HTTP server binds; it is exercised here without any transport, by
// driving the same JSON-RPC handler the stdio server uses.
//
// What these tests pin, and why:
//   * the tool table is the disk host's minus the two that need a sidecar
//     (history, revert), with `source`/`name` where the disk host has `file`;
//   * the write pipeline is the SAME code: a refused write carries the
//     diagnostics and a hint that says nothing was returned; a good write
//     returns the whole new document and no revision;
//   * the disk host's own tool table is untouched by the split (eleven tools,
//     `file` argument, the "file on disk is unchanged" hint).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHandler, inlineHost, toolsFor } from "../dist/mcp-core.js";
import { TOOLS as DISK_TOOLS } from "../dist/mcp.js";

const host = inlineHost();
const TOOLS = toolsFor(host);
const handle = createHandler(() => TOOLS);

const DOC = "# Title {#title}\n\nIntro.\n\n=== note {#alpha}\nfirst\n===\n\n=== note {#beta}\nsee [[#alpha]]\n===\n";

function rpc(method, params, id = 1) {
  const out = [];
  handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (s) => out.push(s));
  return out.length ? JSON.parse(out[0]) : undefined;
}
function call(name, args) {
  const r = rpc("tools/call", { name, arguments: args }, 7).result;
  const text = r.content[0].text;
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { isError: r.isError === true, text, json };
}

test("the inline roster is the disk roster minus history and revert, keyed on `source`", () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, [
    "geml_list", "geml_find", "geml_get", "geml_check", "geml_to",
    "geml_set", "geml_add", "geml_delete", "geml_rename",
  ]);
  const diskNames = DISK_TOOLS.map((t) => t.name);
  assert.deepEqual(diskNames.filter((n) => !names.includes(n)), ["geml_history", "geml_revert"],
    "the two sidecar tools are the only difference");
  for (const t of TOOLS) {
    const props = t.inputSchema.properties;
    assert.ok("source" in props, `${t.name} takes source`);
    assert.ok(!("file" in props), `${t.name} does not take file`);
    assert.ok(t.inputSchema.required.includes("source"), `${t.name} requires source`);
    assert.match(t.description, /STATELESS/, `${t.name} says what this host cannot do`);
  }
  // …and the disk host still speaks `file`, with no such sentence.
  for (const t of DISK_TOOLS) {
    assert.ok("file" in t.inputSchema.properties || t.name === "geml_find", `${t.name} takes file`);
    assert.doesNotMatch(t.description, /STATELESS/);
  }
  assert.equal(DISK_TOOLS.length, 11);
});

test("tools/list serves the inline roster over JSON-RPC", () => {
  const r = rpc("tools/list");
  assert.equal(r.result.tools.length, 9);
  assert.equal(rpc("initialize", { protocolVersion: "2025-06-18" }).result.protocolVersion, "2025-06-18");
});

test("geml_list and geml_get read the document handed in", () => {
  const rows = call("geml_list", { source: DOC }).json;
  // The prose run under the heading is addressable too (GEP 0010).
  assert.deepEqual(rows.map((r) => r.address), ["#title", "#title-before-alpha", "#alpha", "#beta"]);
  assert.equal(call("geml_get", { source: DOC, id: "alpha" }).text, "=== note {#alpha}\nfirst\n===\n");
  assert.equal(call("geml_get", { source: DOC, id: "#beta", part: "body" }).text, "see [[#alpha]]\n");
  // `name` decides how the text is read: a Markdown name reads Markdown.
  const md = call("geml_list", { source: "# Hello\n\ntext\n", name: "README.md" }).json;
  assert.equal(md[0].address, "#hello");
});

test("`source` is required, and a `view` read cannot leave the document", () => {
  const r = call("geml_list", {});
  assert.ok(r.isError);
  assert.match(r.text, /`source` is required/);
  const v = call("geml_get", { source: "=== embed {#e src=other.geml#x}\n===\n", id: "e", view: true });
  assert.ok(v.isError);
  assert.match(v.text, /holds no other documents/);
});

test("geml_check reports a cross-document reference as unresolvable — there is nothing to resolve it against", () => {
  const r = call("geml_check", { source: "# A {#a}\n\nSee [[other.geml#x]] and [[#a]].\n" }).json;
  assert.equal(r.ok, false);
  assert.equal(r.errors, 1);
  assert.equal(r.diagnostics[0].code, "unresolvable-document");
  assert.equal(call("geml_check", { source: DOC }).json.ok, true);
});

test("geml_find searches the one document and names it by `name`", () => {
  const r = call("geml_find", { source: DOC, pattern: "first", name: "n.geml" });
  assert.equal(r.text, "n.geml\t#alpha");
  assert.equal(call("geml_find", { source: DOC, pattern: "nowhere" }).text, "", "no match is an empty result, not an error");
  const withLine = call("geml_find", { source: DOC, pattern: "FIRST", head: true }).text;
  assert.equal(withLine, "document.geml\t#alpha\tfirst");
  assert.equal(call("geml_find", { source: DOC, pattern: "FIRST", case: true }).text, "");
});

test("geml_to converts the handed-in text; a broken document surfaces its diagnostics instead", () => {
  const md = call("geml_to", { source: DOC, to: "md" }).text;
  assert.match(md, /^# Title/);
  const geml = call("geml_to", { source: "# H\n\n- a\n- b\n", name: "x.md" }).text;
  assert.match(geml, /^# H/);
  const bad = call("geml_to", { source: "see [[#nowhere]]\n", to: "json" });
  assert.ok(bad.isError);
  assert.match(bad.text, /unresolved reference/);
  assert.ok(call("geml_to", { source: DOC, to: "docx" }).isError, "an unknown target is refused");
});

test("a good write returns the whole new document and no revision", () => {
  const r = call("geml_set", { source: DOC, id: "alpha", body: "=== note {#alpha}\nsecond\n===\n" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.file, "document.geml");
  assert.equal(r.json.revision, undefined, "nothing is kept, so nothing is recorded");
  assert.equal(r.json.document, DOC.replace("first", "second"));
  // Every other byte survives — the same guarantee the disk host makes.
  assert.ok(r.json.document.endsWith("=== note {#beta}\nsee [[#alpha]]\n===\n"));
});

test("a refused write carries the diagnostics and says no document came back", () => {
  const r = call("geml_set", { source: DOC, id: "alpha", body: "=== note {#alpha}\nsee [[#nowhere]]\n===\n" });
  assert.ok(r.isError);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.document, undefined);
  assert.ok(r.json.diagnostics.some((d) => d.code === "unresolved-reference"), r.text);
  assert.match(r.json.hint, /no document was returned/);
  assert.doesNotMatch(r.json.hint, /file on disk/, "the disk host's sentence does not belong here");
});

test("a pre-existing error is named as such, and does not block an edit that did not cause it", () => {
  const broken = "# T {#t}\n\nSee [[#gone]].\n\n=== note {#n}\nold\n===\n";
  // A `.geml` document holds its author to "every reference resolves": the
  // write is refused, and the hint says the error predates the edit.
  const geml = call("geml_set", { source: broken, id: "n", body: "=== note {#n}\nnew\n===\n", name: "d.geml" });
  assert.equal(geml.json.ok, false);
  assert.match(geml.json.hint, /ALREADY in the document before this edit/);
  // Markdown carries no such contract: the same edit goes through.
  const md = call("geml_set", { source: broken, id: "n", body: "=== note {#n}\nnew\n===\n", name: "notes.md" });
  assert.equal(md.json.ok, true, md.text);
  assert.match(md.json.document, /new/);
});

test("add, delete and rename follow the disk host's rules, returning the document", () => {
  const added = call("geml_add", { source: DOC, content: "=== note {#gamma}\nthird\n===\n", position: "after", anchor: "beta" }).json;
  assert.equal(added.ok, true);
  assert.match(added.document, /#gamma/);
  const clash = call("geml_add", { source: DOC, content: "=== note {#alpha}\ndup\n===\n", position: "append" }).json;
  assert.equal(clash.ok, false, "an id clash is refused");
  assert.ok(clash.diagnostics.some((d) => d.code === "duplicate-id"));

  // Deleting a referenced block strands the reference — reported, not refused.
  const del = call("geml_delete", { source: DOC, ids: ["alpha"] }).json;
  assert.equal(del.ok, true);
  assert.ok(del.diagnostics.some((d) => d.code === "unresolved-reference"));
  assert.doesNotMatch(del.document, /#alpha\}/);
  const nothing = call("geml_delete", { source: DOC, ids: ["nope"] }).json;
  assert.equal(nothing.ok, true);
  assert.match(nothing.hint, /No change/);

  const renamed = call("geml_rename", { source: DOC, old: "alpha", new: "#first" }).json;
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.match(renamed.document, /\{#first\}/);
  assert.match(renamed.document, /\[\[#first\]\]/, "the reference moved with the id");
  assert.equal(call("geml_rename", { source: DOC, old: "alpha", new: "beta" }).json.ok, false, "a taken id is refused");
});

test("a no-op write is reported as such", () => {
  const r = call("geml_set", { source: DOC, id: "alpha", body: "=== note {#alpha}\nfirst\n===\n" }).json;
  assert.equal(r.ok, true);
  assert.match(r.hint, /No change/);
  assert.equal(r.document, undefined, "an unchanged document is not sent back");
});

test("the handler is the stdio server's: unknown tool, unknown method, notifications", () => {
  assert.equal(rpc("tools/call", { name: "geml_nope", arguments: {} }).error.code, -32602);
  assert.equal(rpc("resources/list").error.code, -32601);
  assert.equal(rpc("notifications/initialized"), undefined);
  assert.deepEqual(rpc("ping").result, {});
});

test("`name` drives format inference for geml_to: a .json name is a document model, a .md name is Markdown", () => {
  const model = call("geml_to", { source: DOC, to: "json" }).text;
  const back = call("geml_to", { source: model, name: "model.json" }).text;
  assert.equal(back, call("geml_to", { source: DOC, to: "geml" }).text, "json -> geml is the inverse of geml -> json");
  assert.match(call("geml_to", { source: "# H\n\ntext\n", name: "n.md", to: "json" }).text, /"kind": "document"/);
});

test("geml_get with view on a block that is not an embed reports no provenance", () => {
  const r = call("geml_get", { source: DOC, id: "alpha", view: true }).json;
  assert.deepEqual(r, { from: null, content: "=== note {#alpha}\nfirst\n===\n" });
});

test("a tool argument of the wrong type is a tool error, not a crash and not a refusal", () => {
  const r = call("geml_set", { source: DOC, id: 42, body: "x" });
  assert.ok(r.isError);
  assert.match(r.text, /^error: /);
  assert.equal(r.json, undefined, "no write result was produced");
});

test("a write with no body is refused for want of content, with the stateless hint", () => {
  const r = call("geml_set", { source: DOC, id: "alpha" });
  assert.equal(r.json.ok, false);
  assert.match(r.json.hint, /no replacement content/);
  assert.match(r.json.hint, /no document was returned/);
});
