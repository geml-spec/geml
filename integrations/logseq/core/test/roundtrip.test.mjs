// The spike criterion from docs/design/specs/2026-08-20-logseq-integration-scoping.md:
// EDN → GEML → EDN must be a STRUCTURAL identity under EDN semantics (map entry
// order and set order do not count — EDN maps and sets are unordered), and every
// generated GEML document must parse with zero error diagnostics.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve as presolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEDNString } from "edn-data";
import { parse, addressedUnits, sliceUnit } from "../../../../geml-parser/dist/geml.js";
const lib = { parse, addressedUnits, sliceUnit };
import { ednToGemlFiles, gemlFilesToEdn } from "../src/mapping.mjs";
import { gemlToOgMarkdown } from "../src/og-markdown.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// EDN-semantics canonical form: sort map entries and set members by their
// printed representation, recursively. Equality of canonical forms is exactly
// "equal as EDN data".
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    if (Array.isArray(v.map)) {
      const entries = v.map.map(([k, val]) => [canon(k), canon(val)]);
      entries.sort((a, b) => JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1);
      return { map: entries };
    }
    if (Array.isArray(v.set)) {
      const items = v.set.map(canon);
      items.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
      return { set: items };
    }
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}

// Shapes lifted from logseq's own deps/db export tests (export_test.cljs),
// composed into one graph: ontology with a many-cardinality property and a
// class, a page whose blocks carry properties/tags/uuid/children, a journal
// page, and a page-only entry.
const FIXTURE = `
{:properties {:user.property/default-many {:logseq.property/type :default :db/cardinality :db.cardinality/many}}
 :classes {:user.class/MyClass {:build/class-properties [:user.property/default-many]}}
 :pages-and-blocks
 [{:page {:block/title "page1"}
   :blocks [{:block/title "export"
             :block/uuid #uuid "11111111-2222-3333-4444-555555555555"
             :build/keep-uuid? true
             :build/properties {:user.property/default-many #{"foo" "bar" "baz"}}
             :build/tags #{:user.class/MyClass}}
            {:block/title "parent"
             :build/children [{:block/title "child a"
                               :build/children [{:block/title "grandchild"}]}
                              {:block/title "child b"}]}
            {:block/title "= starts with equals\\n==== and a fence-ish line"}]}
  {:page {:build/journal 20250220}
   :blocks [{:block/title "journal note"}]}
  {:page {:block/title "page2"}}]}
`;

test("EDN -> GEML -> EDN is a structural identity", () => {
  const files = ednToGemlFiles(FIXTURE);
  const back = gemlFilesToEdn(files, lib);
  assert.deepEqual(canon(parseEDNString(back)), canon(parseEDNString(FIXTURE)),
    "the round trip must lose nothing and invent nothing");
});

test("every generated document parses with zero error diagnostics", () => {
  const files = ednToGemlFiles(FIXTURE);
  // The tree is laid out like an OG vault: journals/ with date names, pages/
  // named by the page, order carried by graph.geml instead of filename
  // prefixes. This is the layout a file-version user recognizes as "my graph,
  // as files again" — pinned here so it cannot drift back to database-dump
  // naming without a test saying so.
  for (const expected of ["ontology.geml", "graph.geml", "pages/page1.geml", "journals/2025_02_20.geml", "pages/page2.geml"]) {
    assert.ok(files.has(expected), `expected ${expected}, got: ${[...files.keys()].join(", ")}`);
  }
  for (const [path, text] of files) {
    const errs = parse(text).diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errs, [], `${path} must be clean GEML`);
  }
});

test("a block that Logseq considers addressable is addressable in GEML, by the SAME id", () => {
  const files = ednToGemlFiles(FIXTURE);
  const page1 = files.get([...files.keys()].find((p) => p.includes("page1")));
  // Address it the way `geml get '#uuid'` does: unit by id, body by span.
  const unit = [...addressedUnits(page1)].map((a) => a.unit)
    .find((u) => u.id === "11111111-2222-3333-4444-555555555555");
  assert.ok(unit, "the exported uuid is a GEML id");
  assert.equal(sliceUnit(page1, unit.span, "body").trimEnd(), "export",
    "and addresses exactly that block's content");
});

test("editing ONE block's text in GEML changes exactly that block in the EDN", () => {
  const files = ednToGemlFiles(FIXTURE);
  const key = [...files.keys()].find((p) => p.includes("page1"));
  // The edit an agent would make with `geml set`: replace the body of #uuid.
  files.set(key, files.get(key).replace(/^export$/m, "export, revised"));
  const back = parseEDNString(gemlFilesToEdn(files, lib));
  const orig = parseEDNString(FIXTURE);

  const titleOf = (edn, i, j) => {
    const pages = edn.map.find(([k]) => k.key === "pages-and-blocks")[1];
    const blocks = pages[i].map.find(([k]) => k.key === "blocks")[1];
    return blocks[j].map.find(([k]) => k.key === "block/title")[1];
  };
  assert.equal(titleOf(back, 0, 0), "export, revised", "the edited block changed");
  // …and nothing else did: putting the original title back restores identity.
  const pages = back.map.find(([k]) => k.key === "pages-and-blocks")[1];
  pages[0].map.find(([k]) => k.key === "blocks")[1][0].map
    .find(([k]) => k.key === "block/title")[1] = "export";
  assert.deepEqual(canon(back), canon(orig), "no collateral change anywhere in the graph");
});

// --- outline depth: a class, so `geml check` stays quiet --------------------

test("outline depth: a real vault checks with ZERO diagnostics, not a wall of warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-depth-"));
  try {
    const files = ednToGemlFiles(FIXTURE);
    // The nested fixture page is the one that exercises depth 1..3.
    assert.match(files.get("pages/page1.geml"), /\.level-3/, "the fixture must reach depth 3");
    assert.doesNotMatch(files.get("pages/page1.geml"), /\blevel=\d/, "depth must not ride as an attribute");

    for (const [rel, text] of files) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = presolve(here, "..", "..", "..", "..", "geml-parser", "dist", "cli.js");
    for (const rel of files.keys()) {
      const r = spawnSync(process.execPath, [cli, "check", join(dir, rel), "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, `${rel} must check clean: ${r.stderr}`);
      assert.match(r.stderr, /ok: no diagnostics/, `${rel} still reports: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outline depth: a vault written with `level=N` still imports (older writers)", () => {
  const files = ednToGemlFiles(FIXTURE);
  const legacy = new Map(
    [...files].map(([p, t]) => [p, t.replace(/\{(#[0-9a-f-]+ )?\.level-(\d+)\}/g, (_m, id, n) => `{${id ?? ""}level=${n}}`)])
  );
  assert.match(legacy.get("pages/page1.geml"), /level=3/, "the legacy shape must be what we think it is");
  assert.deepEqual(
    canon(parseEDNString(gemlFilesToEdn(legacy, lib))),
    canon(parseEDNString(gemlFilesToEdn(files, lib))),
    "both spellings must rebuild the same tree"
  );
});

// --- block references: unchecked [[uuid]] ⇄ checked GEML reference ----------

const U = (n) => `${String(n).repeat(8)}-bbbb-4ccc-8ddd-${String(n).repeat(12)}`;
const REF_FIXTURE = `
{:properties {} :classes {}
 :pages-and-blocks
 [{:page {:block/title "Alpha"}
   :blocks [{:block/title "target here" :block/uuid #uuid "${U(1)}"}
            {:block/title "same file [[${U(1)}]]" :block/uuid #uuid "${U(2)}"}]}
  {:page {:block/title "Beta"}
   :blocks [{:block/title "other file [[${U(1)}]], a page link [[Alpha]], and a stranger [[${U(9)}]]"
             :block/uuid #uuid "${U(3)}"}]}
  {:page {:build/journal 20250220}
   :blocks [{:block/title "from a journal [[${U(1)}]]" :block/uuid #uuid "${U(4)}"}]}]}
`;

test("block refs: same file, other file, other directory, and a stranger", () => {
  const files = ednToGemlFiles(REF_FIXTURE);
  const alpha = files.get("pages/alpha.geml");
  const beta = files.get("pages/beta.geml");
  const journal = files.get("journals/2025_02_20.geml");

  assert.match(alpha, new RegExp(`\\[\\[#${U(1)}\\]\\]`), "a target in the same file is the local form");
  assert.match(beta, new RegExp(`\\[\\[alpha\\.geml#${U(1)}\\]\\]`), "a sibling file is named relatively");
  assert.match(
    journal,
    new RegExp(`\\[\\[\\.\\./pages/alpha\\.geml#${U(1)}\\]\\]`),
    "across directories the path walks up"
  );
  // A uuid the export never wrote becomes the local form, which `check` calls
  // unresolved — true of this vault, and the point of translating at all.
  assert.match(beta, new RegExp(`\\[\\[#${U(9)}\\]\\]`));
  // A PAGE reference looks the same apart from its target and must not move.
  assert.match(beta, /\[\[Alpha\]\]/, "page links are not block refs and stay untouched");
});

test("block refs: translation is reversible, so the round trip stays an identity", () => {
  const files = ednToGemlFiles(REF_FIXTURE);
  const back = gemlFilesToEdn(files, lib);
  assert.deepEqual(canon(parseEDNString(back)), canon(parseEDNString(REF_FIXTURE)));
  // A vault written before the translation existed holds bare uuids; the same
  // import must accept those too.
  const legacy = new Map(
    [...files].map(([p, t]) => [p, t.replace(/\[\[[^\[\]]*?#([0-9a-f-]{36})\]\]/g, "[[$1]]")])
  );
  assert.deepEqual(canon(parseEDNString(gemlFilesToEdn(legacy, lib))), canon(parseEDNString(REF_FIXTURE)));
});

test("block refs: `geml check --root` reports the ref that goes nowhere, and only that one", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-refcheck-"));
  try {
    const files = ednToGemlFiles(REF_FIXTURE);
    for (const [rel, text] of files) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = presolve(here, "..", "..", "..", "..", "geml-parser", "dist", "cli.js");
    const check = (rel) =>
      spawnSync(process.execPath, [cli, "check", join(dir, rel), "--root", dir], { encoding: "utf8" });

    const beta = check("pages/beta.geml");
    assert.equal(beta.status, 1, "a dangling ref must fail the check");
    assert.match(beta.stderr, new RegExp(`unresolved reference \`#${U(9)}\``));
    assert.doesNotMatch(beta.stderr, new RegExp(`unresolved.*${U(1)}`), "the resolvable ref must not be reported");

    for (const rel of ["pages/alpha.geml", "journals/2025_02_20.geml"]) {
      const r = check(rel);
      assert.equal(r.status, 0, `${rel} should check clean: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- OG Markdown: a graph the file version can open -------------------------

test("OG markdown: bullets by depth, id:: for identity, ((uuid)) for refs", () => {
  const files = ednToGemlFiles(REF_FIXTURE);
  const alpha = gemlToOgMarkdown(files.get("pages/alpha.geml"), lib);
  const beta = gemlToOgMarkdown(files.get("pages/beta.geml"), lib);

  // Identity: OG stores a block's uuid as a property line under its bullet.
  assert.match(alpha, new RegExp(`^- target here\\n  id:: ${U(1)}$`, "m"));
  // References: OG spells a block ref ((uuid)) — not [[…]], which is a PAGE ref
  // there, so getting this wrong would turn every block ref into a stray page.
  assert.match(alpha, new RegExp(`\\(\\(${U(1)}\\)\\)`));
  assert.doesNotMatch(alpha, /\[\[#/, "no GEML reference syntax may survive");
  // A page link stays a page link in both dialects.
  assert.match(beta, /\[\[Alpha\]\]/);
  // The EDN ride-alongs are not pages: they carry what OG has no shape for.
  assert.doesNotMatch(alpha + beta, /page-meta|block-meta|lang=edn/);

  // Depth: two spaces per level, from the .level-N class.
  const nested = gemlToOgMarkdown(ednToGemlFiles(FIXTURE).get("pages/page1.geml"), lib);
  assert.match(nested, /^- parent$/m);
  assert.match(nested, /^  - child a$/m);
  assert.match(nested, /^    - grandchild$/m);
});

test("OG markdown: a document with nothing OG can hold yields no file", () => {
  const files = ednToGemlFiles(FIXTURE);
  assert.equal(gemlToOgMarkdown(files.get("ontology.geml"), lib), "");
  assert.equal(gemlToOgMarkdown(files.get("graph.geml"), lib), "");
});

console.log(`${passed} test(s) passed.`);
