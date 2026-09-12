// The `edn` engine for `data` blocks (src/edn.ts). §3.2 reserves the name; the
// READING is this processor's own and deliberately unspecified, so these tests
// are where it is pinned down.
//
// What drove it: a Logseq block's properties used to sit in a `code {lang=edn}`
// block, which has no value tree — so the properties had no address, only the
// blob's content hash, which changes the moment you edit it. `data {format=edn}`
// makes one property a coordinate away.
import { strict as assert } from "node:assert";
import { parse } from "../dist/geml.js";
import { parseEdn, serializeEdn } from "../dist/edn.js";
import { planCoordWrite, projectCoord } from "../dist/coord.js";
import { parseCoordPath } from "../dist/selector.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const val = (src) => {
  const r = parseEdn(src.split("\n"));
  assert.ok("value" in r, `expected a value, got: ${r.error}`);
  return r.value;
};
const refuse = (src) => {
  const r = parseEdn(src.split("\n"));
  assert.ok("error" in r, `expected a refusal, got: ${JSON.stringify(r.value)}`);
  return r;
};

// A map this reading builds carries NO prototype, so that `__proto__` is an
// ordinary key rather than an assignment that replaces the object's lineage and
// loses the entry. `deepEqual` is strict about prototypes, so an expected map is
// written with the same one — saying the invariant out loud instead of comparing
// around it.
const map = (o) => Object.assign(Object.create(null), o);

// --- the reading -------------------------------------------------------------

test("scalars land in the value domain unchanged", () => {
  assert.deepEqual(val("[nil true false 1 -2 2.5 1e3 \"s\"]"), [null, true, false, 1, -2, 2.5, 1000, "s"]);
});

test("a keyword keeps its colon — it is not the string of that name", () => {
  // The whole reason: `:x` and `"x"` are different EDN values, so erasing the
  // colon would make two different maps encode to one object.
  assert.deepEqual(val("{:status \"doing\" \"status\" \"a string key\"}"),
    map({ ":status": "doing", "status": "a string key" }));
  assert.deepEqual(val("[:x :ns/x :a.b/c-d?]"), [":x", ":ns/x", ":a.b/c-d?"]);
});

test("vectors, sets and maps; sets and tagged literals wear a $ wrapper", () => {
  assert.deepEqual(val("[1 2]"), [1, 2]);
  assert.deepEqual(val('#{"a" "b"}'), { $set: ["a", "b"] });
  assert.deepEqual(val('#uuid "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'),
    { $uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  assert.deepEqual(val('#inst "2026-10-01T00:00:00.000Z"'), { $inst: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(val("{}"), map({}));
  assert.deepEqual(val("#{}"), { $set: [] });
});

test("commas are whitespace, `;` is a comment, `#_` discards the next datum", () => {
  assert.deepEqual(val("[1, 2,\n 3]"), [1, 2, 3]);
  assert.deepEqual(val("{:a 1 ; trailing\n :b 2}"), map({ ":a": 1, ":b": 2 }));
  assert.deepEqual(val("[1 #_2 3]"), [1, 3]);
  assert.deepEqual(val("[1 #_{:a 1} 3]"), [1, 3], "a discarded datum can be a collection");
});

test("string escapes", () => {
  assert.deepEqual(val('"a\\nb\\t\\"c\\"\\\\d\\u0041"'), 'a\nb\t"c"\\dA');
});

// --- refusals, each by name --------------------------------------------------

test("the kinds outside the subset are refused BY NAME, never guessed", () => {
  const cases = [
    ["(1 2)", /a list `\(…\)`/],
    ["foo", /the symbol `foo`/],
    ["\\a", /a character literal/],
    ["42N", /arbitrary-precision literal `42N`/],
    ["1.0M", /arbitrary-precision literal `1\.0M`/],
    ["1/3", /the ratio `1\/3`/],
    ['#my/tag "x"', /the tagged literal `#my\/tag`/],
    ["#uuid 42", /`#uuid` without a string after it/],
  ];
  for (const [src, re] of cases) assert.match(refuse(src).error, re, src);
});

test("the two string-key shapes that would collide are refused", () => {
  // A string key `":x"` would encode to the same object key a keyword does, and
  // one beginning with `$` would collide with a wrapper. Refusing keeps the
  // reading injective — which is what makes the write-back exact.
  assert.match(refuse('{":x" 1}').error, /it would encode as the keyword `:x` does/);
  assert.match(refuse('{"$set" 1}').error, /a leading `\$` is reserved/);
  // …and the keyword itself is of course fine, which is the asymmetry: the
  // colon belongs to the keyword, so only the string has to give way.
  assert.deepEqual(val("{:x 1}"), map({ ":x": 1 }));
});

test("structural trouble names itself, with the line it happened on", () => {
  assert.match(refuse("{:a 1").error, /never closed with `}`/);
  assert.match(refuse("[1 2").error, /never closed with `\]`/);
  assert.match(refuse('"abc').error, /a string that is never closed/);
  assert.match(refuse("{:a}").error, /the map key `:a` has no value/);
  assert.match(refuse("{:a 1 :a 2}").error, /the key `:a` twice/);
  assert.match(refuse("{[1] 2}").error, /a map key that is a vector/);
  assert.match(refuse("1 2").error, /a second value after the first/);
  // The line is 0-based within the body, which is the contract parseDataBody
  // maps onto the document.
  assert.equal(refuse("{:a 1\n :b (2)}").line, 1);
});

// --- writing it back ---------------------------------------------------------

test("serialize is the inverse of the reading, laid out to be read", () => {
  const src = '{:build/keep-uuid? true\n :build/properties {:s "doing"\n                    :n 1\n                    :u #uuid "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"\n                    :t #{"a" "b"}\n                    :d #inst "2026-10-01T00:00:00.000Z"}}';
  const tree = val(src);
  const out = serializeEdn(tree).join("\n");
  assert.deepEqual(val(out), tree, "text -> tree -> text -> tree is an identity");
  // Native EDN comes back out, not a JSON transcription of it.
  assert.match(out, /#uuid "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"/);
  assert.match(out, /#inst "2026-10-01T00:00:00\.000Z"/);
  assert.match(out, /#\{"a" "b"\}/);
  assert.match(out, /^\{:build\/keep-uuid\? true$/m, "one map entry per line");
});

// --- through the block, which is the point -----------------------------------

const DOC = '=== data {#meta format=edn}\n{:build/keep-uuid? true\n :build/properties {:user.property/status "doing"\n                    :user.property/owner #uuid "99999999-8888-4777-8666-555555555555"}}\n===\n';

test("a data block declaring format=edn parses clean and is addressable", () => {
  const d = parse(DOC);
  assert.deepEqual(d.diagnostics, [], "the format has an engine now, so nothing to warn about");
  const block = d.children.find((x) => x.kind === "block" && x.id === "meta");
  const r = projectCoord(block, parseCoordPath('[":build/properties"][":user.property/status"]'));
  assert.equal(r.ok, true);
  assert.equal(r.text, "doing");
});

test("a bad body is a data-parse error on the document line", () => {
  const d = parse("=== data {#m format=edn}\n{:a 1\n :b (2)}\n===\n");
  const errs = d.diagnostics.filter((x) => x.severity === "error");
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, "data-parse");
  assert.match(errs[0].message, /is not EDN this processor reads/);
  assert.match(errs[0].message, /a list `\(…\)`/, "the engine's own sentence reaches the reader");
  // Open fence 1, body 2-3; the list is on body line 2, so document line 3.
  assert.equal(errs[0].line, 3);
});

test("a coordinate write re-emits EDN — it does not rewrite the block as JSON", () => {
  // The bug this guards: the fall-through in planCoordWrite serializes as JSON,
  // and before the `edn` arm a write into an EDN body silently changed the
  // block's format out from under the author.
  const d = parse(DOC);
  const block = d.children.find((x) => x.kind === "block" && x.id === "meta");
  const body = DOC.split("\n").slice(1, -2);
  const plan = planCoordWrite(block, parseCoordPath('[":build/properties"][":user.property/status"]'), "done", body);
  assert.equal(plan.ok, true, plan.why);
  const out = plan.body.join("\n");
  assert.match(out, /:user\.property\/status "done"/, "the value changed");
  assert.match(out, /#uuid "99999999-8888-4777-8666-555555555555"/, "the tagged literal stayed EDN");
  assert.ok(!out.includes('"$uuid"'), "no JSON transcription leaked into the body");
});

test("`\\r` is a string escape too, alongside the ones already pinned", () => {
  assert.equal(val('"a\\rb"'), "a\rb");
  assert.equal(val('"mixed\\r\\n\\ttabs"'), "mixed\r\n\ttabs");
});

test("a float literal that overflows to Infinity is refused by name, not rounded", () => {
  // It matches the float shape, so it gets as far as `Number(t)` — and a JSON
  // number cannot hold the result, which is the same reason the ratio and the
  // arbitrary-precision literals are refused rather than approximated.
  assert.match(refuse("1e999").error, /the number `1e999` is not finite/);
  assert.match(refuse("-1e999").error, /the number `-1e999` is not finite/);
});

test("a map key this reading cannot encode is named by WHAT it is", () => {
  // The message runs through `describe`, and each shape it can name is a shape
  // an author can actually type into a Logseq property map.
  assert.match(refuse("{1 2}").error, /a map key that is the number `1`/);
  assert.match(refuse("{true 1}").error, /a map key that is the boolean `true`/);
  assert.match(refuse("{nil 1}").error, /a map key that is nil/);
  assert.match(refuse("{[1 2] 3}").error, /a map key that is a vector/);
  assert.match(refuse("{#{1} 2}").error, /a map key that is a set or a tagged literal/);
  for (const src of ["{1 2}", "{true 1}", "{nil 1}", "{[1 2] 3}", "{#{1} 2}"]) {
    assert.match(refuse(src).error, /this reading has keyword and string keys/, src);
  }
});

test("a string key `__proto__` is an ordinary key, not the prototype it looks like", () => {
  // On a plain `{}` the assignment for this name REPLACES the prototype instead
  // of adding a key: the entry never becomes an own key, so `Object.keys` loses
  // it and the body written back loses it — the author's property gone with
  // nothing said — while `for..in` and a dotted read still see it through the
  // chain it just installed.
  const v = val('{"__proto__" {:polluted "yes"} :real "kept"}');
  assert.deepEqual(Object.keys(v), ["__proto__", ":real"], "both keys are OWN keys");
  assert.equal(Object.getPrototypeOf(v), null, "the map carries no prototype to poison");
  assert.equal(v[":polluted"], undefined, "and nothing reads through one that is not there");

  // The round trip is where the loss used to show: write the map back and the
  // key has to still be in the bytes.
  const back = serializeEdn(v).join("\n");
  assert.match(back, /"__proto__"/, back);
  assert.deepEqual(Object.keys(val(back)), ["__proto__", ":real"], "and it survives a second read");

  // The keyword spelling was never affected — its stored name carries the colon.
  assert.deepEqual(Object.keys(val('{:__proto__ 1}')), [":__proto__"]);
});

console.log(`\n${passed} passed`);
