// The TextMate grammar's heading rule, against the line shapes that once made
// it backtrack cubically: a heading with a long run of blanks in it.
//
// VS Code runs these patterns in Oniguruma, which is not available here, so
// they run as JS RegExps instead — the same backtracking engine family, and the
// same blow-up on the same shapes. Possessive quantifiers, which JS lacks,
// run as plain greedy ones: no faster, so a pass here is not flattered.

const { strict: assert } = require("node:assert");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const grammar = JSON.parse(readFileSync(path.join(__dirname, "..", "syntaxes", "geml.tmLanguage.json"), "utf8"));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

/** Every pattern a rule can run, its own and those of the rules it includes. */
function patternsOf(rule, seen = new Set()) {
  if (!rule || seen.has(rule)) return [];
  seen.add(rule);
  const own = ["match", "begin", "end"].filter((k) => typeof rule[k] === "string").map((k) => rule[k]);
  const included = (rule.patterns ?? []).flatMap((p) =>
    p.include?.startsWith("#") ? patternsOf(grammar.repository[p.include.slice(1)], seen) : patternsOf(p, seen));
  return own.concat(included);
}

const asJs = (source) => new RegExp(source.replace(/([*+?}])\+/g, "$1"), "u");

test("round 6: the heading rule matches in linear time on a long run of blanks", () => {
  const patterns = patternsOf(grammar.repository.heading).map(asJs);
  assert.ok(patterns.length > 0, "the heading rule has patterns");
  const n = 3000;
  const lines = [
    "# a" + " ".repeat(n) + "x",
    "# a" + " ".repeat(n) + "{",
    "# a" + "\t ".repeat(n / 2) + "{#id}",
    "#" + " ".repeat(n) + "{",
  ];
  const began = performance.now();
  // Searched from several offsets, as the tokenizer resumes after each token.
  for (const line of lines) {
    for (const re of patterns) {
      for (let at = 0; at < line.length; at += 500) re.exec(line.slice(at) + "\n");
    }
  }
  const ms = performance.now() - began;
  // Linear patterns take a few milliseconds here; the cubic rule took seconds.
  assert.ok(ms < 500, `the heading patterns took ${ms.toFixed(0)} ms over ${lines.length} lines of ${n} blanks`);
});

console.log(`\n${passed} test(s) passed.`);
