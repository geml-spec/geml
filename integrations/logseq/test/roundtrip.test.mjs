// The spike criterion from docs/design/specs/2026-08-20-logseq-integration-scoping.md:
// EDN → GEML → EDN must be a STRUCTURAL identity under EDN semantics (map entry
// order and set order do not count — EDN maps and sets are unordered), and every
// generated GEML document must parse with zero error diagnostics.
import { strict as assert } from "node:assert";
import { parseEDNString } from "edn-data";
import { parse, addressedUnits, sliceUnit } from "../../../geml-parser/dist/geml.js";
const lib = { parse, addressedUnits, sliceUnit };
import { ednToGemlFiles, gemlFilesToEdn } from "../src/mapping.mjs";

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

console.log(`${passed} test(s) passed.`);
