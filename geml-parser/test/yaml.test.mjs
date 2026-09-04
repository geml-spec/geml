// The `yaml` engine for `data` bodies (§3.2 reserves the name and leaves the
// engine optional; this processor has one, for a declared subset).
//
// Two properties this suite exists to hold, because both are silent when they
// break: a construct OUTSIDE the subset must be refused by name rather than
// guessed at, and a yaml body must survive serialization byte for byte — it now
// carries a value, and canonical form is defined for json/jsonl only.
import { strict as assert } from "node:assert";
import { parse, serialize } from "../dist/geml.js";
import { parseYaml } from "../dist/yaml.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const read = (body) => parseYaml(body.split("\n"));
const value = (body) => {
  const r = read(body);
  assert.ok(!("error" in r), `wanted a value, got error: ${r.error}`);
  return r.value;
};
const refusal = (body) => {
  const r = read(body);
  assert.ok("error" in r, `wanted a refusal, got ${JSON.stringify(r.value)}`);
  return r.error;
};

test("block mappings and sequences, nested by indentation", () => {
  assert.deepEqual(value("a: 1\nb: two"), { a: 1, b: "two" });
  assert.deepEqual(value("- 1\n- 2\n- 3"), [1, 2, 3]);
  assert.deepEqual(value("root:\n  nested:\n    deep: 1"), { root: { nested: { deep: 1 } } });
  assert.deepEqual(value("a: []\nb: {}"), { a: [], b: {} });
  assert.deepEqual(value("-\n  a: 1"), [{ a: 1 }], "an item whose content is on the next line");
});

test("a sequence sits at its key's indent or deeper — both are the same document", () => {
  const deeper = value("items:\n  - a\n  - b");
  assert.deepEqual(deeper, { items: ["a", "b"] });
  assert.deepEqual(value("items:\n- a\n- b"), deeper, "the shape most YAML in the wild is written in");
});

test("`- key: value` and `- - 1` open a nested block at the content's own column", () => {
  // The continuation lines sit at that column, so the nested block has to start
  // there: computing it as "dash plus two" breaks the moment someone writes
  // `-   key: value`, and the failure looks like a bogus indentation error.
  assert.deepEqual(value("- name: one\n  n: 1\n- name: two\n  n: 2"), [{ name: "one", n: 1 }, { name: "two", n: 2 }]);
  assert.deepEqual(value("-   name: one\n    n: 1"), [{ name: "one", n: 1 }]);
  assert.deepEqual(value("outer:\n  - - 1\n    - 2"), { outer: [[1, 2]] });
  assert.deepEqual(value("a:\n  - x: 1\n    y: 2"), { a: [{ x: 1, y: 2 }] });
});

test("scalars follow the 1.2 CORE schema: `yes` is a string, `0x1f` is a number", () => {
  assert.deepEqual(value("n: null\nt: ~\ne:"), { n: null, t: null, e: null });
  assert.deepEqual(value("a: true\nb: false\nc: True"), { a: true, b: false, c: true });
  // The 1.1 booleans, which 1.2 dropped. Reading `no` as `false` is the classic
  // YAML surprise, and a document that means the word must get the word.
  assert.deepEqual(value("a: yes\nb: no\nc: on\nd: off"), { a: "yes", b: "no", c: "on", d: "off" });
  assert.deepEqual(
    value("i: 42\nf: 3.5\nx: 0x1f\no: 0o17\np: +80\nh: -2.5e3\nd: .5\nz: 5."),
    { i: 42, f: 3.5, x: 31, o: 15, p: 80, h: -2500, d: 0.5, z: 5 },
  );
  assert.deepEqual(value("v: 1.9.2"), { v: "1.9.2" }, "two dots is a version, not a number");
});

test("quotes, comments and the document markers", () => {
  assert.deepEqual(value('s: "a: b # c"'), { s: "a: b # c" }, "neither the colon nor the hash is syntax in quotes");
  assert.deepEqual(value("s: 'it''s'"), { s: "it's" }, "the one escape single quotes have");
  assert.deepEqual(value('s: "tab\\there"'), { s: "tab\there" }, "double quotes take escapes");
  assert.deepEqual(value("# lead\na: 1  # trailing\n\n# tail"), { a: 1 });
  assert.deepEqual(value("a: '#1'"), { a: "#1" }, "a hash inside quotes is content");
  assert.deepEqual(value("---\na: 1\n..."), { a: 1 }, "a leading `---` and a trailing `...`");
  assert.equal(value(""), null, "an empty body is the null document");
  assert.equal(value("# only a comment"), null);
});

test("block scalars: literal keeps the newlines, folded turns them into spaces", () => {
  assert.deepEqual(value("s: |\n  one\n  two"), { s: "one\ntwo\n" });
  assert.deepEqual(value("s: |-\n  one\n  two"), { s: "one\ntwo" }, "`-` strips the final newline");
  assert.deepEqual(value("s: >-\n  one\n  two"), { s: "one two" });
  assert.deepEqual(value("s: |-\n  a\n    indented"), { s: "a\n  indented" }, "relative indent is kept");
});

test("a quoted key may hold the syntax characters, and a bad escape stays literal", () => {
  // The key scanner has to track quotes, or `"a: b": 1` cuts at the wrong colon.
  assert.deepEqual(value('"a: b": 1'), { "a: b": 1 });
  assert.deepEqual(value("'k': 2"), { k: 2 });
  assert.deepEqual(value('"a\\"b": 3'), { 'a"b': 3 }, "an escaped quote does not end the key");
  // A double-quoted scalar JSON cannot read is kept as its own characters
  // rather than becoming a diagnostic: the quotes were the author's intent.
  assert.deepEqual(value('s: "a\\qb"'), { s: "a\\qb" });
});

test("a sequence ends where the indentation says, and an empty item is null", () => {
  assert.deepEqual(value("a:\n  - 1\nb: 2"), { a: [1], b: 2 }, "a shallower line closes the nested sequence");
  assert.deepEqual(value("a:\n- 1\nb: 2"), { a: [1], b: 2 }, "and so does a key at the sequence's own indent");
  assert.deepEqual(value("- 1\n-"), [1, null], "a dash with nothing after it, and nothing deeper");
});

test("every construct outside the subset is refused BY NAME, never guessed at", () => {
  assert.match(refusal("a: &x 1\nb: *x"), /anchor/);
  assert.match(refusal("b: *x"), /alias/);
  assert.match(refusal("a: !!str 1"), /tag/);
  assert.match(refusal("d:\n  <<: x\n  y: 2"), /merge key/);
  assert.match(refusal("a: 1\n---\nb: 2"), /second document/);
  assert.match(refusal("a: {x: 1}"), /flow collection/);
  assert.match(refusal("a: [1, 2]"), /flow collection/);
  assert.match(refusal("a: .inf"), /no infinity/, "the value domain here is JSON's");
  assert.match(refusal("a: -.NaN"), /no infinity/);
  assert.match(refusal("a:\n\tb: 1"), /tab/, "YAML forbids tabs in indentation");
  assert.match(refusal("just a scalar"), /neither a mapping entry/);
  assert.match(refusal("a: 1\n  b: 2"), /indented deeper/);
  assert.match(refusal("- 1\n  - 2"), /indented deeper/);
  assert.match(refusal("a: 1\n- 2"), /not part of the document/, "a mapping cannot turn into a sequence");
});

test("a refusal names the body line it happened on, offset into the document", () => {
  const r = read("a: 1\nb: *x");
  assert.equal(r.line, 1, "0-based within the body");
  const doc = parse("=== data {#y format=yaml}\na: 1\nb: *x\n===\n");
  const e = doc.diagnostics.filter((d) => d.severity === "error");
  assert.equal(e.length, 1);
  assert.equal(e[0].code, "data-parse", "a construct we refuse is a parse failure, not a new code");
  assert.equal(e[0].line, 3, "open fence 1 + body line 2");
  assert.match(e[0].message, /alias/);
  assert.equal(doc.children[0].value, undefined, "and the block carries no value");
});

test("a parsed yaml body still serializes BYTE FOR BYTE", () => {
  // It has a `value` now, and the data canonicalizer would have re-emitted it
  // as pretty JSON — rewriting a yaml body into JSON on any reformat.
  const src = "=== data {#y format=yaml}\nname:   geml   # spacing kept\nlist:\n- 1\n===\n";
  const out = serialize(parse(src));
  assert.match(out, /\nname:   geml   # spacing kept\nlist:\n- 1\n/);
  assert.equal(serialize(parse(out)), out, "and that is a fixed point");
  assert.deepEqual(parse(out).children[0].value, { name: "geml", list: [1] });
});

test("the yaml value tree is addressable, like any other data block", () => {
  const doc = parse("=== data {#cfg format=yaml}\nlimits:\n  rows: 100\nnames:\n  - a\n  - b\n===\n");
  assert.equal(doc.diagnostics.length, 0);
  assert.deepEqual(doc.children[0].value, { limits: { rows: 100 }, names: ["a", "b"] });
});

console.log(`\n${passed} test(s) passed.`);
