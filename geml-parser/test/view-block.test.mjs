// GEP-0012 — a `view` owns every operation that derives a relation.  These
// are deliberately model-level tests: HTML has exactly one table renderer, so
// the contract worth pinning here is the tuples and diagnostics it receives.
import { strict as assert } from "node:assert";
import { parse } from "../dist/geml.js";
import { gemlToMd } from "../dist/to-md.js";
import { planCoordWrite } from "../dist/coord.js";
import { parseCoordPath } from "../dist/selector.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const errors = (document) => document.diagnostics.filter((d) => d.severity === "error");
const byId = (document, id) => document.children.find((b) => b.kind === "block" && b.id === id);

const source = [
  "=== table {#tickets format=csv header=1}",
  "Id,Status,Age,Area",
  "a,open,8,infra",
  "b,closed,2,ops",
  "c,open,8,infra",
  "d,open,x,ops",
  "===",
].join("\n");

test("selection runs compute before where, then orders, limits, projects and summarizes", () => {
  const document = parse(`${source}\n=== view {#open src=#tickets compute="Next = Age + 1" where="Status = 'open' and Next > 5" order="Next desc, Id" limit=2 select="Id, Next" summary="Next = sum(Next)"}\n===`);
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  const model = byId(document, "open").table;
  assert.deepEqual(model.columns, ["Id", "Next"]);
  assert.deepEqual(model.rows.map((row) => row.map((cell) => cell.text)), [["a", "9"], ["c", "9"]]);
  assert.equal(model.summary[1].text, "18");
});

test("where has boolean precedence, quoted columns, and dirty numeric cells do not match", () => {
  const document = parse([
    "=== table {#t format=csv header=1}",
    "Unit Price,State",
    "10,open",
    "x,open",
    "4,closed",
    "===",
    "=== view {#v src=#t where=\"not ('Unit Price' < 5 or State = 'closed')\"}",
    "===",
  ].join("\n"));
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  assert.deepEqual(byId(document, "v").table.rows.map((r) => r[0].text), ["10", "x"]);
});

test("a numeric filter on a text-only column and a filter on an unknown column are errors", () => {
  const textOnly = parse(`${source}\n=== view {src=#tickets where="Status > 3"}\n===`);
  assert.ok(errors(textOnly).some((d) => d.code === "view-numeric-column-required"));
  const missing = parse(`${source}\n=== view {src=#tickets where="Missing = 'open'"}\n===`);
  assert.ok(errors(missing).some((d) => d.code === "view-where-error" && /Missing/.test(d.message)));
});

test("a grouping view publishes keys then aggregate names; the next view filters groups", () => {
  const document = parse(`${source}\n=== view {#areas src=#tickets by="Area" aggregate="Open = count(Id); Total = sum(Age)"}\n===\n=== view {#busy src=#areas where="Open > 1"}\n===`);
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  const groups = byId(document, "areas").table;
  assert.deepEqual(groups.columns, ["Area", "Open", "Total"]);
  assert.deepEqual(groups.rows.map((r) => r.map((c) => c.text)), [["infra", "2", "16"], ["ops", "2", "2"]]);
  assert.deepEqual(byId(document, "busy").table.rows.map((r) => r[0].text), ["infra", "ops"]);
});

test("by without aggregate is the distinct key relation", () => {
  const document = parse(`${source}\n=== view {#areas src=#tickets by="Area"}\n===`);
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  assert.deepEqual(byId(document, "areas").table.rows.map((r) => r[0].text), ["infra", "ops"]);
});

test("a source summary never crosses into a consuming view", () => {
  const document = parse([
    "=== table {#facts format=csv header=1}",
    "Name,N",
    "a,1",
    "b,2",
    "===",
    "=== view {#report src=#facts summary=\"N = sum(N)\"}",
    "===",
    "=== view {#copy src=#report}",
    "===",
  ].join("\n"));
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  assert.equal(byId(document, "report").table.summary[1].text, "3");
  assert.equal(byId(document, "copy").table.summary, undefined);
  assert.equal(byId(document, "copy").table.rows.length, 2);
});

test("aggregate formulas cannot make a circular filter or live in compute on a grouping view", () => {
  const circular = parse(`${source}\n=== view {src=#tickets compute="Share = Age / sum(Age)" where="Share > 0.2"}\n===`);
  assert.ok(errors(circular).some((d) => d.code === "circular-view-filter"));
  const grouped = parse(`${source}\n=== view {src=#tickets by="Area" compute="Total = sum(Age)"}\n===`);
  assert.ok(errors(grouped).some((d) => d.code === "grouping-compute-aggregate"));
});

test("view diagnostics protect the split: table does not derive or borrow relations", () => {
  const derivedTable = parse("=== table {format=csv compute=\"B = A + 1\"}\nA\n1\n===");
  assert.deepEqual(derivedTable.children[0].table.columns, ["A"]);
  assert.ok(derivedTable.diagnostics.some((d) => d.code === "unknown-attribute"));
  const borrowedTable = parse(`${source}\n=== table {src=#tickets}\n===`);
  assert.ok(errors(borrowedTable).some((d) => d.code === "table-source-is-block"));
  const body = parse("=== view {src=#nope}\nnot permitted\n===");
  assert.ok(errors(body).some((d) => d.code === "view-src-and-body"));
});

test("view chains cannot close a cycle, and cannot run deeper than §9.3's bound", () => {
  const cycle = parse("=== view {#a src=#b}\n===\n=== view {#b src=#a}\n===");
  assert.equal(errors(cycle).filter((d) => d.code === "view-source-cycle").length, 2);

  // The GEP bounds a chain "exactly as a nested `embed`'s is (§9.3)", which is
  // 8. Depth follows the chain, not the pass count: a document that declares
  // its views in dependency order resolves any length in ONE pass, so counting
  // passes bounded nothing. Past the bound every view says so and none of them
  // publishes rows — otherwise the chain restarted at every ninth link.
  const chain = (n) => {
    let src = `${source}\n`;
    for (let i = 1; i <= n; i++) src += `=== view {#v${i} src=${i === 1 ? "#tickets" : `#v${i - 1}`}}\n===\n`;
    return parse(src);
  };
  assert.deepEqual(errors(chain(8)), [], "eight deep is legal");
  assert.equal(byId(chain(8), "v8").table.columns.length, 4);
  const deep = chain(11);
  const past = errors(deep).filter((d) => d.code === "view-source-too-deep");
  assert.equal(past.length, 3, "one per view past the bound, not one per document");
  assert.match(past[0].message, /is 9 deep; the bound is 8/);

  // And twenty INDEPENDENT views are not a deep chain.
  let flat = `${source}\n`;
  for (let i = 1; i <= 20; i++) flat += `=== view {#w${i} src=#tickets}\n===\n`;
  assert.deepEqual(errors(parse(flat)), []);
});

test("a coordinate READS a view's cells (GEP-0011) and can never write one", () => {
  // GEP-0012: "a coordinate on one reads and never writes". Refusing the read
  // too left a document unable to reference the derived numbers most worth
  // referencing — `[[#v[1]["Next"]]]` failed on the very cell being rendered.
  const document = parse(`${source}\n=== view {#v src=#tickets where="Status = 'open'" compute="Next = Age + 1" summary="Next = sum(Next)"}\n===\n\n# H {#h}\n\ncell [[#v[1]["Next"]]], total [[#v[summary]["Next"]]]\n`);
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  const prose = document.children.find((b) => b.kind === "paragraph");
  // 19, not 18: the fixture's fourth ticket has `Age` of `x`, which §6's
  // arithmetic reads as zero, so its `Next` is 1 and the total carries it.
  assert.equal(prose.inlines.map((n) => n.value ?? n.text ?? "").join(""), "cell 9, total 19");

  // The write is what a view has no bytes for, and it says which way out there is.
  const plan = parse(`${source}\n=== view {#v src=#tickets}\n===`);
  const view = byId(plan, "v");
  assert.equal(view.table.rows.length, 4, "the model is there to read");

  // An unresolved view has no COLUMNS (a resolved one keeps its source's, even
  // with no rows), so its coordinate says the source failed rather than
  // describing an empty filter.
  const broken = parse(`=== view {#x src=#nope}\n===\n\n# H {#h}\n\nsee [[#x[1]["Id"]]]\n`);
  assert.ok(errors(broken).some((d) => /did not resolve, so it has no rows/.test(d.message)),
    JSON.stringify(errors(broken).map((d) => d.message)));
});

test("a write into a view is refused, and it names the way out", () => {
  const document = parse(`${source}\n=== view {#v src=#tickets}\n===`);
  const plan = planCoordWrite(byId(document, "v"), parseCoordPath('[1]["Id"]'), "z", []);
  assert.equal(plan.ok, false);
  assert.match(plan.why, /no body rows to write — edit the source relation/);
});

test("`where=` reads COLUMNS, so a quoted value that spells one is just a value", () => {
  // The circular-filter check used to run a regex over the raw `where=` text,
  // which called this legal document circular: the aggregate column is named
  // `Share` and so is a ticket. Only a `word` token is a column reference.
  const document = parse([
    "=== table {#t format=csv header=1}",
    "Name,N",
    "Share,1",
    "Other,3",
    "===",
    '=== view {#v src=#t compute="Share = N / sum(N)" where="Name = \'Share\'"}',
    "===",
  ].join("\n"));
  assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
  assert.deepEqual(byId(document, "v").table.rows.map((r) => r[0].text), ["Share"]);

  // And one real circular filter is ONE error, not two: the old code built the
  // predicate as well, which added `unknown column \`Share\`` — blaming the
  // reference, which is what this diagnostic exists not to do.
  const circular = parse(`${source}\n=== view {src=#tickets compute="Share = Age / sum(Age)" where="Share > 0.2"}\n===`);
  assert.deepEqual(errors(circular).map((d) => d.code), ["circular-view-filter"]);
});

test("`order=` is deterministic in every processor: one kind per key, code units for text", () => {
  const sorted = (rows, key = "Name") => {
    const document = parse([
      "=== table {#t format=csv header=1}", "Name", ...rows, "===",
      `=== view {#v src=#t order="${key} asc"}`, "===",
    ].join("\n"));
    assert.deepEqual(errors(document), [], JSON.stringify(document.diagnostics));
    return byId(document, "v").table.rows.map((r) => r[0].text);
  };
  // `localeCompare` collated these as `Ápple, Apple, banana, cherry` — an
  // answer that depends on the host's ICU and default locale. A format whose
  // premise is that two processors agree cannot order rows by the machine.
  assert.deepEqual(sorted(["banana", "Apple", "cherry", "Ápple"]), ["Apple", "banana", "cherry", "Ápple"]);

  // A column that is not ALL numeric sorts as text, once — deciding per PAIR
  // made the comparator non-transitive (`10 > 2` numerically, `2 > "1a"` and
  // `"10" < "1a"` textually), which left the order up to the sort itself.
  assert.deepEqual(sorted(["10", "2", "1a"]), ["10", "1a", "2"]);
  // An all-numeric column still compares as numbers.
  assert.deepEqual(sorted(["10", "2", "1"]), ["1", "2", "10"]);
});

test("an aggregate over a column that is not there is ONE error, and it names the column", () => {
  const document = parse(`${source}\n=== view {#v src=#tickets by="Area" aggregate="T = sum(Nope)"}\n===`);
  const unknown = errors(document).filter((d) => d.code === "view-unknown-column");
  assert.equal(unknown.length, 1, "one mistake, one message — not one per GROUP");
  assert.match(unknown[0].message, /aggregate: unknown column `Nope`/);
});

test("`aggregate=` without `by=` says which attribute does want a single row", () => {
  const document = parse(`${source}\n=== view {#v src=#tickets aggregate="T = sum(Age)"}\n===`);
  const e = errors(document).filter((d) => d.code === "aggregate-without-by");
  assert.equal(e.length, 1);
  assert.match(e[0].message, /that is `summary=`/);
});

test("`--to md` carries a view's rows, as `--to html` does", () => {
  // The exports must agree about whether the reader sees content. A `view` fell
  // through to the unknown-type path and became an EMPTY ```view fence, which is
  // the exact shape of the three losses the export-parity test was written for.
  const md = gemlToMd(parse(`${source}\n=== view {#v src=#tickets where="Area = 'ops'" select="Id, Area"}\n===`)).md;
  assert.doesNotMatch(md, /```view/, "an empty fence is how the loss looked");
  assert.match(md, /\| Id \| Area \|/);
  assert.match(md, /\| b \| ops \|/);
});

console.log(`\n${passed} GEP-0012 view tests passed.`);
