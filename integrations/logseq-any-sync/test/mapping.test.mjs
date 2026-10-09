// AnyBlock v2 ⇄ GEML: the round-trip guarantees, on the AnyBlock project's own
// conformance documents (test/fixtures/anyblock, MIT) and on hand-made blocks.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { parse } from "@geml/geml";
import { anyToGeml, gemlToAny } from "../adapters/anytype/mapping.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => JSON.parse(readFileSync(join(here, "fixtures", "anyblock", f), "utf8"));

/** JSON with keys sorted, and the defaults AnyBlock omits dropped — semantic equality. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === "gid") continue;
      if (k === "indent" && v[k] === 0) continue;
      out[k] = canon(v[k]);
    }
    return out;
  }
  return v;
}

function roundTrip(doc) {
  const { text, ids } = anyToGeml(doc);
  const back = gemlToAny(text, { ids });
  return { text, back };
}

for (const f of ["rich.json", "containers.json"]) {
  test(`${f}: AnyBlock → GEML → AnyBlock is the same document`, () => {
    const doc = fixture(f);
    const { blocks, ...envelope } = doc;
    const { text, back } = roundTrip(doc);
    assert.deepEqual(canon(back.blocks), canon(blocks));
    assert.deepEqual(back.envelope, envelope);
    const diags = parse(text).diagnostics.filter((d) => d.severity !== "info");
    assert.deepEqual(diags.map((d) => d.message), [], "the generated GEML checks clean");
  });

  test(`${f}: GEML written by the bridge comes back byte for byte`, () => {
    const { text, ids } = anyToGeml(fixture(f));
    const back = gemlToAny(text, { ids });
    const again = anyToGeml({ ...back.envelope, blocks: back.blocks.map(({ gid, ...b }) => b) }, { ids });
    assert.equal(again.text, text);
  });
}

test("each Anytype block is one addressable GEML block, under its Anytype id", () => {
  const { text } = anyToGeml(fixture("rich.json"));
  const ids = new Set(parse(text).children.map((c) => c.id).filter(Boolean));
  for (const b of fixture("rich.json").blocks) if (b.id) assert.ok(ids.has(b.id), `#${b.id} is addressable`);
});

const doc = (blocks, name = "Doc") => ({ id: "obj", type: "Page", properties: { Name: name }, blocks });

test("native shapes: paragraph, lists with nesting, checkbox, headings, code, maths, mermaid, notes", () => {
  const blocks = [
    { id: "h1", type: "heading_1", text: "Top" },
    { id: "p1", type: "paragraph", text: "Some **bold** text\nand a line break" },
    { id: "l1", type: "bulleted_list_item", text: "one" },
    { indent: 1, id: "l2", type: "numbered_list_item", text: "nested one" },
    { indent: 1, id: "l3", type: "numbered_list_item", text: "nested two" },
    { id: "c1", type: "checkbox", checked: true, text: "done" },
    { id: "k1", type: "code", language: "go", text: "func main() {}\n===\nnot a fence" },
    { id: "m1", type: "embed", processor: "latex", text: "a^2" },
    { id: "d1", type: "embed", processor: "mermaid", text: "graph LR; A-->B" },
    { id: "q1", type: "quote", text: "Quoted." },
    { id: "t1", type: "toggle", text: "Toggle." },
    { id: "co", type: "callout", icon: { format: "emoji", emoji: "💡" }, text: "Callout." },
  ];
  const { text, back } = roundTrip(doc(blocks));
  assert.match(text, /^## Top \{#h1\}$/m, "heading_1 is a level-2 GEML heading — `#` is the title");
  assert.match(text, /=== text \{#p1\}\nSome \*\*bold\*\* text\\\nand a line break\n===/, "an in-block line break is a hard break");
  assert.match(text, /=== text \{#l3 \.level-2\}\n2\. nested two\n===/, "numbering counts within the run; nesting is .level-N");
  assert.match(text, /=== text \{#c1\}\n- \[x\] done\n===/);
  assert.match(text, /==== code \{#k1 lang=go\}\n/, "a body holding a fence gets a longer one");
  assert.match(text, /=== math \{#m1\}\na\^2\n===/);
  assert.match(text, /=== diagram \{#d1 format=mermaid\}/);
  assert.match(text, /=== note \{#q1 \.quote\}/);
  assert.match(text, /=== note \{#co\}\n%% anytype: \{"icon":\{"format":"emoji","emoji":"💡"\}\}\nCallout\.\n===/, "fields GEML has no slot for ride on a comment line");
  assert.deepEqual(canon(back.blocks), canon(blocks));
  assert.deepEqual(parse(text).diagnostics.filter((d) => d.severity !== "info"), []);
});

test("text that would read back as something else is kept as a data block", () => {
  const blocks = [
    { id: "a", type: "paragraph", text: "- looks like a list" },
    { id: "b", type: "paragraph", text: "=== looks like a fence" },
    { id: "c", type: "heading_2", text: "Has {braces}" },
    { id: "d", type: "divider" },
  ];
  const { text, back } = roundTrip(doc(blocks));
  for (const id of ["a", "b", "c", "d"]) assert.match(text, new RegExp(`=== data \\{#${id} \\.anyblock format=json\\}`));
  assert.deepEqual(canon(back.blocks), canon(blocks));
});

test("file blocks: the local copy when there is one, a link into Anytype when not", () => {
  const blocks = [
    { id: "f1", type: "image", object_id: "bafyimg", name: "a.png", mime_type: "image/png", size: 10, style: "embed" },
    { id: "f2", type: "pdf", object_id: "bafypdf", name: "big.pdf", size: 99999999 },
  ];
  const { text, ids } = anyToGeml(doc(blocks), { assetPath: (b) => (b.size < 1000 ? `assets/${b.object_id}-${b.name}` : undefined) });
  assert.match(text, /=== text \{#f1 \.file\}\n%% anytype: \{"type":"image","object_id":"bafyimg".*\}\n!\[a\.png\]\(assets\/bafyimg-a\.png\)\n===/);
  assert.match(text, /\[big\.pdf\]\(anytype:\/\/object\?objectId=bafypdf\)/);
  assert.deepEqual(canon(gemlToAny(text, { ids }).blocks), canon(blocks));
});

test("GEML Anytype cannot say travels as a `geml` code block and comes back as itself", () => {
  const chart = "=== diagram {#sales format=geml-chart data=#t}\nbar x=a y=b\n===";
  const vault = `=== data {#object .object format=json}\n{"id":"obj","properties":{"Name":"Doc"}}\n===\n\n# Doc\n\n${chart}\n`;
  const out = gemlToAny(vault);
  assert.deepEqual(out.blocks.map(({ type, language, text }) => ({ type, language, text })), [{ type: "code", language: "geml", text: chart }]);
  // Anytype mints an id for it; the first read pairs that id with the GEML one.
  const pulled = doc([{ id: "65f0aa", type: "code", language: "geml", text: chart }]);
  const r = anyToGeml(pulled);
  assert.ok(r.text.includes(chart), "unwrapped");
  assert.deepEqual(r.ids, { sales: "65f0aa" });
  // …and the next push sends it under the Anytype id.
  assert.equal(gemlToAny(r.text, { ids: r.ids }).blocks[0].id, "65f0aa");
  // A geml code block whose inner id is paired with another Anytype block stays wrapped.
  const clash = anyToGeml(doc([{ id: "other", type: "code", language: "geml", text: chart }]), { ids: { sales: "65f0aa" } });
  assert.match(clash.text, /==== code \{#other lang=geml\}/);
});

test("a block the vault named keeps its GEML id once Anytype has minted its own", () => {
  const ids = { mynote: "65f0bb" };
  const r = anyToGeml(doc([{ id: "65f0bb", type: "callout", text: "Hi" }]), { ids });
  assert.match(r.text, /=== note \{#mynote\}/);
  assert.equal(gemlToAny(r.text, { ids }).blocks[0].id, "65f0bb");
  assert.equal(gemlToAny(r.text, { ids }).blocks[0].gid, "mynote");
});

test("hand-written GEML: id-less paragraphs and nested lists become blocks without ids", () => {
  const vault = "# My Page\n\nFirst para\ncontinues.\n\n- top\n  - child\n- [ ] task\n\n1. one\n2. two\n\n=== text {#keep}\nKept.\n\nAnd a second paragraph added by an agent.\n===\n";
  const out = gemlToAny(vault);
  assert.equal(out.title, "My Page");
  assert.equal(out.envelope, undefined);
  assert.deepEqual(canon(out.blocks), canon([
    { type: "paragraph", text: "First para continues." },
    { type: "bulleted_list_item", text: "top" },
    { type: "bulleted_list_item", indent: 1, text: "child" },
    { type: "checkbox", text: "task" },
    { type: "numbered_list_item", text: "one" },
    { type: "numbered_list_item", text: "two" },
    { id: "keep", type: "paragraph", text: "Kept." },
    { type: "paragraph", text: "And a second paragraph added by an agent." },
  ]));
});

console.log(`\n${passed} test(s) passed.`);
