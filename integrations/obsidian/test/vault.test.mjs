// The invariants the geml-vault skill rests on.
//
// Every assertion here was first measured by hand against a real Obsidian vault
// and then pinned, including the destructive ones: test 3 asserts that `set` on
// a frontmatter block DESTROYS the page. That is not a wish, it is what the
// tool does, and the skill forbids the call because of it. A negative test is
// how a footgun stays documented after everyone who found it has moved on.
//
// The fixture is built in a temp directory rather than committed, because two
// of these tests damage it on purpose and because a committed Markdown fixture
// carries a line ending, which is exactly the thing that differs between the
// Windows box this is developed on and the Linux box CI runs.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "..", "..", "geml-parser", "dist", "geml.js");
const GRAPH = resolve(HERE, "..", "scripts", "vault-graph.mjs");

function geml(args, stdin) {
  return spawnSync(process.execPath, [CLI, ...args], { input: stdin, encoding: "utf8" });
}
function graph(roots) {
  const r = spawnSync(process.execPath, [GRAPH, ...roots, "--json"], { encoding: "utf8" });
  assert.ok(r.stdout, `vault-graph produced nothing: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const INDEX = `---
type: meta
title: "Index"
tags:
  - meta
related:
  - "[[Concepts]]"
---

# Index

Navigation: [[Concepts]] | [[Wiki Map]]

## Entities

- [[Alpha]] — first

## Notes

> [!tip] Keep it short
> See [[Alpha]] and ![[cover.png]].

\`\`\`dataview
LIST FROM "wiki" WHERE contains(file.outlinks, [[Ghost In A Fence]])
\`\`\`

A mention of \`[[Ghost In Backticks]]\` is not a link either.
`;

// `[[Nowhere]]` has no page and no attachment — the one real dead link.
// `Lonely` is linked by nobody — the one real orphan.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "geml-vault-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "index.md"), INDEX);
  writeFileSync(join(root, "Concepts.md"), "# Concepts\n\nBack to [[index]]. Missing: [[Nowhere]].\n");
  // Leading prose, before any heading, is the anonymous block test 4 moves.
  writeFileSync(join(root, "Alpha.md"), "Seen from [[index]].\n\n# Alpha\n\nBody.\n");
  writeFileSync(join(root, "sub", "Lonely.md"), "# Lonely\n\nNothing links here.\n");
  writeFileSync(join(root, "Wiki Map.canvas"), "{}\n");
  writeFileSync(join(root, "cover.png"), "");
  return root;
}

test("set replaces one block and leaves frontmatter and every other block byte-for-byte", () => {
  const root = fixture();
  try {
    const page = join(root, "index.md");
    const before = readFileSync(page, "utf8").split(/\r?\n/);
    const r = geml(["set", page, "#entities", "--body", "--in", "-"], "- [[Alpha]] — first\n- [[Beta]] — second\n");
    assert.equal(r.status, 0, `set failed: ${r.stderr}`);

    const after = readFileSync(page, "utf8").split(/\r?\n/);
    // Frontmatter, opener to closer, untouched.
    assert.deepEqual(after.slice(0, 8), before.slice(0, 8), "frontmatter must not move or change");
    // The callout section, further down the page, untouched.
    const section = (lines) => lines.slice(lines.indexOf("## Notes"));
    assert.deepEqual(section(after), section(before), "an unaddressed block must not change");
    assert.match(readFileSync(page, "utf8"), /- \[\[Beta\]\] — second/, "and the addressed one must");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Obsidian syntax is written through verbatim, never escaped", () => {
  const root = fixture();
  try {
    const page = join(root, "index.md");
    const body = "> [!warning] Careful\n> See [[Alpha]], ![[cover.png|300]] and [[Alpha|an alias]].\n";
    const r = geml(["set", page, "#entities", "--body", "--in", "-"], body);
    assert.equal(r.status, 0, `set failed: ${r.stderr}`);

    const text = readFileSync(page, "utf8");
    assert.ok(text.includes("> [!warning] Careful"), "a callout must survive unescaped");
    assert.ok(text.includes("![[cover.png|300]]"), "an embed with a size must survive unescaped");
    assert.ok(text.includes("[[Alpha|an alias]]"), "an aliased link must survive unescaped");
    assert.ok(!text.includes("\\[\\["), "nothing may be backslash-escaped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--body matches a heading, not a prose block — on prose it appends instead of replacing", () => {
  const root = fixture();
  try {
    const page = join(root, "prose.md");
    const original = "# Page\n\n## A\n\nold prose here\n\n### B\n\ntail\n";
    const kindOf = (addr) => JSON.parse(geml(["list", page, "--json"]).stdout)
      .find((b) => b.address === addr)?.kind;

    // A heading takes --body, and REFUSES the whole-block form for plain text:
    // the content would have to be a block, which prose is not.
    writeFileSync(page, original);
    assert.equal(kindOf("#b"), "heading");
    const bare = geml(["set", page, "#b", "--in", "-"], "X\n");
    assert.notEqual(bare.status, 0, "a heading refuses prose as a whole-block replacement");
    assert.match(bare.stderr, /use --body/);
    assert.equal(readFileSync(page, "utf8"), original, "and a refusal writes nothing");

    // A prose block is the other way round. Without --body it replaces.
    writeFileSync(page, original);
    assert.equal(kindOf("#a-before-b"), "prose");
    assert.equal(geml(["set", page, "#a-before-b", "--in", "-"], "NEW prose\n").status, 0);
    const replaced = readFileSync(page, "utf8");
    assert.ok(replaced.includes("NEW prose"));
    assert.ok(!replaced.includes("old prose here"), "the old prose must be gone");

    // With --body it APPENDS, silently, exit 0 — a prose block has no body of
    // its own, so the write lands after what is already there. This is the one
    // shape of this skill's advice that corrupts a page without saying so.
    writeFileSync(page, original);
    assert.equal(geml(["get", page, "#a-before-b", "--body"]).stdout.trim(), "",
      "a prose block reports an empty body, which is where the append comes from");
    const appended = geml(["set", page, "#a-before-b", "--body", "--in", "-"], "NEW prose\n");
    assert.equal(appended.status, 0, "and it does not complain");
    const after = readFileSync(page, "utf8");
    assert.ok(after.includes("old prose here") && after.includes("NEW prose"),
      "both are present — nothing was replaced");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("set on the frontmatter block DESTROYS the frontmatter — which is why the skill forbids it", () => {
  const root = fixture();
  try {
    const page = join(root, "index.md");
    const blocks = JSON.parse(geml(["list", page, "--json"]).stdout);
    const fm = blocks[0];
    assert.ok(fm.address.startsWith("@"), "frontmatter is an anonymous prose block, not a typed one");

    const r = geml(["set", page, fm.address, "--body", "--in", "-"], "type: meta\ntitle: \"Index\"\n");
    assert.equal(r.status, 0, "the write is accepted — the damage is silent");

    const text = readFileSync(page, "utf8");
    // The closing `---` lived inside the block body. It is gone, so what is
    // left is an opener with no closer: Obsidian reads no properties at all.
    assert.equal(text.split(/\r?\n/).filter((l) => l === "---").length, 1,
      "the closing --- is swallowed, leaving unterminated frontmatter");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an @address is a content hash and changes when the content does", () => {
  const root = fixture();
  try {
    const page = join(root, "Alpha.md");
    const first = JSON.parse(geml(["list", page, "--json"]).stdout).find((b) => b.address.startsWith("@"));
    assert.ok(first, "the fixture has an anonymous block to move");
    geml(["set", page, first.address, "--body", "--in", "-"], "Rewritten.\n");
    const again = JSON.parse(geml(["list", page, "--json"]).stdout).find((b) => b.address.startsWith("@"));
    assert.notEqual(again?.address, first.address, "so an @address must never be stored or written to");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a page with two identically titled headings refuses every write", () => {
  const root = fixture();
  try {
    const page = join(root, "dup.md");
    writeFileSync(page, "# Dup\n\n## Intro\n\ntext\n\n## Added\n\none\n\n## Added\n\ntwo\n");
    const check = geml(["check", page]);
    assert.notEqual(check.status, 0, "the duplicate id is an error before anyone edits");

    // The guard judges the RESULT, so an edit that leaves the collision
    // standing is refused however far from it the edit lands.
    const r = geml(["set", page, "#intro", "--body", "--in", "-"], "rewritten\n");
    assert.notEqual(r.status, 0, "an unrelated section of the same file is unwritable too");
    assert.match(r.stderr, /duplicate id/);

    // And an edit that happens to REMOVE the collision goes through, which is
    // why the rule is about the result and not about the file.
    const gone = geml(["set", page, "#dup", "--body", "--in", "-"], "just one section now\n");
    assert.equal(gone.status, 0, `removing the collision must be allowed: ${gone.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a wikilink carrying a # anchor cannot be written — GEML reads it as its own cross-document reference", () => {
  const root = fixture();
  try {
    const page = join(root, "Concepts.md");
    // `[[file#id]]` is GEML reference syntax, checked at write time. Obsidian
    // means something else by the same spelling, and there is no file named
    // `Alpha` — only `Alpha.md` — so the reference does not resolve and the
    // write is refused. This is a real limit on what blocks are editable.
    for (const link of ["[[Alpha#Body]]", "[[Alpha#Body|alias]]", "[[Alpha#^abc123]]"]) {
      const r = geml(["set", page, "#concepts", "--body", "--in", "-"], `see ${link}\n`);
      assert.notEqual(r.status, 0, `${link} must be refused, not silently written`);
      assert.match(r.stderr, /cannot resolve document/);
    }
    // Spelling the target with its extension resolves, and Obsidian follows
    // that form too — the escape hatch when a block must hold an anchored link.
    const ok = geml(["set", page, "#concepts", "--body", "--in", "-"], "see [[Alpha.md#Alpha]]\n");
    assert.equal(ok.status, 0, `the .md form must be writable: ${ok.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the graph finds the orphan and the dead link, and the dead link carries a block address", () => {
  const root = fixture();
  try {
    const g = graph([root]);
    assert.deepEqual(g.orphans, ["sub/Lonely.md"], "only the page nothing links to");
    assert.equal(g.dead.length, 1, `exactly one dead link, got ${JSON.stringify(g.dead)}`);
    assert.equal(g.dead[0].target, "Nowhere");
    assert.equal(g.dead[0].from, "Concepts.md");
    assert.ok(g.dead[0].address, "a dead link without an address is a line number in disguise");

    // The address is one `geml get` takes — that is the whole point of it.
    const back = geml(["get", join(root, g.dead[0].from), g.dead[0].address]);
    assert.equal(back.status, 0, `the address must round-trip through get: ${back.stderr}`);
    assert.match(back.stdout, /Nowhere/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a wikilink inside a code fence or inline code is not a link", () => {
  const root = fixture();
  try {
    const g = graph([root]);
    const targets = g.dead.map((d) => d.target).concat(g.pages.flatMap((p) => p.outbound.map((o) => o.target)));
    assert.ok(!targets.includes("Ghost In A Fence"), "a ```dataview fence is code, not prose");
    assert.ok(!targets.includes("Ghost In Backticks"), "and neither is an inline code span");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("frontmatter wikilinks count as edges, and an attachment is not a dead page", () => {
  const root = fixture();
  try {
    const g = graph([root]);
    const concepts = g.pages.find((p) => p.path === "Concepts.md");
    assert.ok(concepts.inbound.includes("index.md"),
      "index links Concepts from its `related:` property, which Obsidian resolves");
    assert.ok(!g.dead.some((d) => d.target === "Wiki Map"),
      "[[Wiki Map]] resolves to Wiki Map.canvas — Obsidian matches any file type by stem");
    assert.ok(!g.dead.some((d) => d.target === "cover.png"), "and an embedded image is not a missing page");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
