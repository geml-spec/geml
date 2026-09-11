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


// ---------------------------------------------------------------------------
// R5 — the cross-document view resolver (security audit, batch 1)
// ---------------------------------------------------------------------------

// A remote view is resolved by PARSING its document, and that parse resolves its
// own remote views. Two files pointing at each other therefore recursed until
// the stack ran out: `geml check` — the CI gate, and what MCP runs around every
// write — died with a RangeError, from two lines. The same-document `src=#v`
// cycle had been a diagnostic all along.
test("a cross-document view cycle (A→B→A, and A→A) is view-source-cycle, and parse() does not throw", () => {
  const docs = new Map([
    ["A.geml", "=== view {#v src=B.geml#v}\n===\n"],
    ["B.geml", "=== view {#v src=A.geml#v}\n===\n"],
    ["S.geml", "=== view {#v src=S.geml#v}\n===\n"],
  ]);
  const resolveDoc = (d) => docs.get(d) ?? null;
  for (const self of ["A.geml", "S.geml"]) {
    let doc;
    assert.doesNotThrow(() => { doc = parse(docs.get(self), { resolveDoc, self }); }, `${self}: parse must not throw`);
    const cycle = doc.diagnostics.find((d) => d.severity === "error" && d.code === "view-source-cycle");
    assert.ok(cycle, `${self}: the cycle is named, not swallowed`);
    assert.match(cycle.message, /already being resolved/, "and it says which documents form it");
  }
});

// The same recursion with no cycle: F views over an N-document chain re-parsed
// the same files F^N times (twelve files of seven lines took eight seconds).
// Parsed once per document now, and bounded at the depth an embed's chain is.
test("a cross-document view chain is parsed once per document, and bounded at the embed depth", () => {
  const chain = (n) => {
    const docs = new Map();
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? `D${i + 1}.geml` : null;
      docs.set(`D${i}.geml`, [0, 1, 2].map((k) => (next
        ? `=== view {#v${k} src=${next}#v0}\n===`
        : `=== table {#v${k} format=csv}\nA\n1\n===`)).join("\n") + "\n");
    }
    return docs;
  };
  // Twelve deep, fan-out three: past the bound, and fast BECAUSE it is bounded and cached.
  let docs = chain(12);
  let t = Date.now();
  let doc = parse(docs.get("D0.geml"), { resolveDoc: (d) => docs.get(d) ?? null, self: "D0.geml" });
  assert.ok(Date.now() - t < 1500, `12-deep fan-out took ${Date.now() - t} ms`);
  assert.ok(doc.diagnostics.some((d) => d.severity === "error" && d.code === "view-source-too-deep"), "the bound is reported by name");
  // Six deep: inside the bound, clean, and still fast.
  docs = chain(6);
  t = Date.now();
  doc = parse(docs.get("D0.geml"), { resolveDoc: (d) => docs.get(d) ?? null, self: "D0.geml" });
  assert.ok(Date.now() - t < 1500, `6-deep fan-out took ${Date.now() - t} ms`);
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0, "a chain inside the bound resolves clean");
  assert.deepEqual(doc.children[0].table.rows.map((r) => r[0].text), ["1"], "and carries the rows through");
});

// A borrowed document's own `src=` used to resolve against the HOST's directory,
// so a same-named file beside the host silently replaced the data the borrowed
// author pointed at.
test("a borrowed document's own src= resolves against THAT document's directory", () => {
  const files = new Map([
    ["sub/other.geml", "=== table {#t src=data.csv format=csv}\n===\n"],
    ["sub/data.csv", "A\nsubval\n"],
    ["data.csv", "A\nROOTVAL\n"],
  ]);
  const doc = parse("=== view {#v src=sub/other.geml#t}\n===\n", { resolveDoc: (d) => files.get(d) ?? null, self: "host.geml" });
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.deepEqual(doc.children[0].table.rows.map((r) => r[0].text), ["subval"]);
});

// A view the remote document could not resolve carries the scan's EMPTY model,
// not undefined. Returned as a relation, it made the consumer a silently empty
// table while the reason sat in the remote document's discarded diagnostics.
test("a remote view that did not resolve in its own document is an error at the consumer, never an empty table", () => {
  const docs = new Map([["B.geml", "=== view {#v src=missing.geml#x}\n===\n"]]);
  const doc = parse("=== view {#v src=B.geml#v}\n===\n", { resolveDoc: (d) => docs.get(d) ?? null, self: "host.geml" });
  const err = doc.diagnostics.find((d) => d.severity === "error" && /did not resolve in `B\.geml`/.test(d.message));
  assert.ok(err, "the consumer says the source did not resolve, and where");
  assert.ok(!(doc.children[0].table && doc.children[0].table.columns.length > 0), "and publishes no relation of its own");
});

// ---------------------------------------------------------------- 覆盖率补位：每条诊断、每个比较算子各走一次

const view = (attrs) => parse(`${source}\n=== view {#v src=#tickets ${attrs}}\n===`);
const has = (document, code) => document.diagnostics.some((d) => d.code === code);
const msg = (document, code) => document.diagnostics.find((d) => d.code === code)?.message ?? "";

test("where：词法与语法错误各自点名", () => {
  const cases = [
    ["Status = 'open", /unclosed single-quoted string/],
    ["Status ! 'x'", /unexpected token `!`/],
    ["= 'open'", /a comparison starts with a column name/],
    ["Status = open", /number or single-quoted string/],
    ["(Status = 'open'", /missing \)/],
    ["Status 'open'", /followed by a comparison/],
    ["Status =", /no right-hand value/],
    ["Status = 'open' extra", /unexpected token `extra`/],
    ["Nope = 'x'", /unknown column `Nope`/],
  ];
  for (const [where, re] of cases) {
    const d = view(`where="${where}"`);
    assert.match(msg(d, "view-where-error"), re, where);
  }
});

test("where：数字比较与文本比较的六个算子都能求值，结果与直接过滤一致", () => {
  const base = byId(parse(source), "tickets").table;
  const ages = base.rows.map((r) => r[2].value);
  const statuses = base.rows.map((r) => r[1].text);
  const num = {
    "Age = 8": (v) => v === 8, "Age != 8": (v) => v !== 8, "Age < 5": (v) => v < 5,
    "Age <= 2": (v) => v <= 2, "Age > 5": (v) => v > 5, "Age >= 8": (v) => v >= 8,
  };
  for (const [w, f] of Object.entries(num)) {
    const d = view(`where="${w}"`);
    assert.deepEqual(errors(d), [], w);
    assert.equal(byId(d, "v").table.rows.length, ages.filter((v) => typeof v === "number" && f(v)).length, w);
  }
  const txt = {
    "Status = 'open'": (s) => s === "open", "Status != 'open'": (s) => s !== "open", "Status < 'open'": (s) => s < "open",
    "Status <= 'open'": (s) => s <= "open", "Status > 'closed'": (s) => s > "closed", "Status >= 'open'": (s) => s >= "open",
  };
  for (const [w, f] of Object.entries(txt)) {
    const d = view(`where="${w}"`);
    assert.deepEqual(errors(d), [], w);
    assert.equal(byId(d, "v").table.rows.length, statuses.filter(f).length, w);
  }
});

test("compute / aggregate：写坏了的声明各自点名", () => {
  assert.ok(has(view('by="Nope" aggregate="N = count(Id)"'), "view-unknown-column"));
  assert.ok(has(view('by="Area" aggregate="nonsense"'), "bad-aggregate-entry"));  assert.ok(has(view('by="Area" aggregate="S = sum(Age) +"'), "aggregate-error"));
});

test("aggregate：count 数非空格、sum 对无数字的列得 0、avg 求均值", () => {
  const g = ["=== table {#g format=csv header=1}", "Area,Age,Note", "infra,8,x", "infra,2,", "ops,5,y", "==="].join("\n");
  const d = parse(`${g}\n=== view {#v src=#g by="Area" aggregate="N = count(Note)" aggregate2="S = sum(Note)" aggregate3="A = avg(Age)"}\n===`);
  assert.deepEqual(errors(d), [], JSON.stringify(d.diagnostics));
  const rows = byId(d, "v").table.rows.map((r) => r.map((c) => c.text));
  assert.deepEqual(rows, [["infra", "1", "0", "5"], ["ops", "1", "0", "5"]]);
});

test("order / select / limit / summary：其余诊断，以及文本键排序的三种比较结果", () => {
  assert.ok(has(view(`order="' ' desc"`), "view-order-error"));
  assert.ok(has(view('order="Nope"'), "view-unknown-column"));
  const tie = view('order="Status, Id desc"');
  assert.deepEqual(errors(tie), []);
  const ordered = byId(tie, "v").table.rows.map((r) => r[1].text);
  assert.deepEqual(ordered, [...ordered].sort());
  assert.ok(has(view('select="Id, X = Age + 1"'), "view-select-expression"));
  assert.ok(has(view('select="Id, Nope"'), "view-unknown-column"));
  assert.ok(has(view("limit=abc"), "view-limit-error"));
  assert.ok(has(view("limit=-1"), "view-limit-error"));
  assert.ok(has(view('select="Id" summary="Age = sum(Age)"'), "summary-projected-away"));
  assert.ok(has(view('compute="Age = Age + 1"'), "shadowed-source-column"));
  assert.ok(has(view('by="Area" compute="T = sum(Age)"'), "grouping-compute-aggregate"));
  // 聚合列存在时 where 词法化失败：先探聚合名的那一步吞掉异常，留给 filterPredicate 正式报
  assert.ok(has(view(`compute="T = sum(Age)" where="Status = 'open"`), "view-where-error"));
});

test("table：外部 src 的表带 caption；空的坐标尾巴不是路径", () => {
  const d = parse('=== table {#c src="missing.csv" caption="Sales"}\n===\n');
  assert.equal(byId(d, "c").table.caption, "Sales");
  assert.equal(parseCoordPath(""), null);
});


test("aggregate：带格式的聚合按格式打印；算不出有限值的打成 `-` 且不带 value", () => {
  const d = view('by="Area" aggregate="A[%.1f] = avg(Age)" aggregate2="R[%.1f] = sum(Age) / 0"');
  assert.deepEqual(errors(d), [], JSON.stringify(d.diagnostics));
  const rows = byId(d, "v").table.rows;
  for (const r of rows) {
    assert.match(r[1].text, /^\d+\.\d$/, r[1].text);
    assert.equal(r[2].text, "-");
    assert.equal(r[2].value, undefined);
  }
});


// --- a view whose src= is a DATA FILE rather than a relation -----------------
// `src=#id` is the relation case the suite above pins. A view may also read a
// `.csv`/`.tsv`, and then it lands in the same resolution the table has — every
// answer below is one the author sees at build time, not at render time.

const viewOn = (src, opts) => parse(`=== view {#v src=${src}}\n===\n`, opts).diagnostics ?? [];
const codesOf = (ds) => ds.map((d) => d.code);

test("a view reading http(s) is left to the renderer, exactly as a table is", () => {
  // `sourceOf` answers `null` — settled, nothing to build — and not `undefined`,
  // which the resolution loop reads as "not ready yet". It used to answer
  // `undefined`, so the entry never left `unresolved` and the closing sweep
  // reported the view as a cycle it had never been part of.
  const view = parse("=== view {#v src=https://example.com/fy.csv}\n===\n");
  const table = parse("=== table {#t src=https://example.com/fy.csv}\n===\n");
  assert.deepEqual(codesOf(view.diagnostics ?? []), []);
  assert.equal(view.children[0].table.src, table.children[0].table.src,
    "the view carries the same renderer-time source a table does");
  assert.deepEqual(view.children[0].table.rows, [], "no rows at build time — the renderer fetches them");
});

test("the remote-source answer does not soften a real cycle", () => {
  const two = parse("=== view {#a src=#b}\n===\n\n=== view {#b src=#a}\n===\n");
  assert.ok(codesOf(two.diagnostics ?? []).includes("view-source-cycle"), JSON.stringify(two.diagnostics));
  const self = parse("=== view {#a src=#a}\n===\n");
  assert.ok(codesOf(self.diagnostics ?? []).includes("view-source-cycle"), JSON.stringify(self.diagnostics));
  // A chain that is not a cycle still resolves.
  const chain = parse("=== table {#facts format=csv header=1}\nS,Q\nc,8\n===\n\n"
    + "=== view {#a src=#facts}\n===\n\n=== view {#b src=#a}\n===\n");
  assert.deepEqual(codesOf(chain.diagnostics ?? []), []);
});

test("a view src that is neither a relation nor a .csv/.tsv is refused by name", () => {
  for (const src of ["notes.txt", "fy.json", "ftp://host/fy.csv"]) {
    const ds = viewOn(src);
    const hit = ds.find((d) => d.code === "unresolvable-table-source");
    assert.ok(hit, `${src}: ${JSON.stringify(codesOf(ds))}`);
    assert.match(hit.message, /is not a `\.csv`\/`\.tsv` data file or a relation target/, src);
  }
});

test("a local data file: unchecked without a resolver, named when the resolver cannot read it", () => {
  const unchecked = viewOn("fy.csv");
  const warn = unchecked.find((d) => d.code === "unchecked-cross-document-reference");
  assert.ok(warn, JSON.stringify(codesOf(unchecked)));
  assert.equal(warn.severity, "warning");
  assert.match(warn.message, /view source `fy\.csv` not checked \(no document resolver\)/);

  const gone = viewOn("fy.csv", { resolveDoc: () => null });
  const err = gone.find((d) => d.code === "unresolvable-table-source");
  assert.ok(err, JSON.stringify(codesOf(gone)));
  assert.match(err.message, /cannot resolve view source `fy\.csv`/);
});

test("a local data file that reads: the delimiter comes from the extension", () => {
  const csv = parse('=== view {#v src=fy.csv}\n===\n', { resolveDoc: () => "Segment,Q1\nCloud,8\n" });
  assert.deepEqual(codesOf(csv.diagnostics ?? []), []);
  assert.deepEqual(csv.children[0].table.columns, ["Segment", "Q1"]);

  const tsv = parse('=== view {#v src=fy.tsv}\n===\n', { resolveDoc: () => "Segment\tQ1\nCloud\t8\n" });
  assert.deepEqual(codesOf(tsv.diagnostics ?? []), []);
  assert.deepEqual(tsv.children[0].table.columns, ["Segment", "Q1"],
    "a .tsv is read tab-delimited, not as one wide column");
});

console.log(`\n${passed} GEP-0012 view tests passed.`);
