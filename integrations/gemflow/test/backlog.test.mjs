import { test } from "node:test";
import assert from "node:assert/strict";
import { readBacklog, renderBacklog, bindItem, bindInDocument, itemFor } from "../dist/core/backlog.js";

const DOC = '=== meta\ntitle = "Backlog"\nprofile = "geml-statechart/v1"\n===\n\n=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| rate-limit | 登录接口加限流 | feat/rate-limit |\n| dark-mode | 设置页支持深色模式 | |\n===\n';

test("read: rows become items; an empty target is a to-do", () => {
  const b = readBacklog(DOC);
  assert.deepEqual(b.diagnostics, []);
  assert.equal(b.key, "branch");
  assert.deepEqual(b.items, [
    { id: "rate-limit", title: "登录接口加限流", target: "feat/rate-limit" },
    { id: "dark-mode", title: "设置页支持深色模式", target: "" },
  ]);
  assert.equal(itemFor(b.items, "feat/rate-limit").id, "rate-limit");
});

test("bind, then render round-trips", () => {
  const b = readBacklog(DOC);
  const bound = bindItem(b.items, "dark-mode", "feat/dark");
  assert.equal(bound.ok, true);
  const text = renderBacklog(bound.items, "branch");
  assert.deepEqual(readBacklog(text).items[1], { id: "dark-mode", title: "设置页支持深色模式", target: "feat/dark" });
  assert.deepEqual(bindItem(bound.items, "dark-mode", "feat/other"), { ok: false, reason: "dark-mode is already bound to feat/dark" });
  assert.deepEqual(bindItem(b.items, "nope", "x"), { ok: false, reason: "no backlog item nope" });
});

test("a file-unit backlog uses a file column; a pipe in a title survives", () => {
  const items = [{ id: "ep03", title: "第三集 | 雨夜", target: "" }];
  const text = renderBacklog(items, "file");
  assert.match(text, /\| id \| title \| file \|/);
  assert.deepEqual(readBacklog(text), { key: "file", items, diagnostics: [] });
});

test("no backlog table is a diagnostic, not a throw", () => {
  assert.deepEqual(readBacklog("=== meta\ntitle = \"x\"\n===\n").diagnostics, ["no table block #backlog"]);
});

test("a pipe is written escaped and every cell round-trips, a pipe-and-backslash text included", () => {
  const items = [
    { id: "a|b", title: "x | y || z", target: "feat/a|b" },
    { id: "c", title: "ends in a backslash \\", target: "" },
    { id: "d", title: "literal \\| text", target: "feat/d" },
    { id: "e", title: "**bold** and `code` and [l](u)", target: "" },
  ];
  const text = renderBacklog(items, "branch");
  assert.match(text, /\| a\\\|b \| x \\\| y \\\|\\\| z \| feat\/a\\\|b \|/);
  assert.deepEqual(readBacklog(text), { key: "branch", items, diagnostics: [] });
});

test("bound in place: a target ending in a backslash is written with a space before the pipe, so the two never read as an escaped pipe (§6(a))", () => {
  const doc = "=== table {#backlog}\n|id|title|branch|\n|---|---|---|\n|c|t|x|\n|d|u||\n===\n";
  const r = bindInDocument(doc, "d", "feat\\");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.text, "=== table {#backlog}\n|id|title|branch|\n|---|---|---|\n|c|t|x|\n|d|u| feat\\ |\n===\n");
  assert.deepEqual(readBacklog(r.text).items[1], { id: "d", title: "u", target: "feat\\" });
  const padded = bindInDocument(DOC, "dark-mode", "feat\\");
  assert.equal(padded.ok, true, padded.reason);
  assert.match(padded.text, /\| dark-mode \| 设置页支持深色模式 \| feat\\ \|/, "a padded row is padded as it always was");
});

test("cells follow the signals table: header names are trimmed, a lone code span reads as its text", () => {
  const doc = '=== table {#backlog}\n|  ID  |  Title |   Branch |\n|---|---|---|\n| `rate-limit` | `login` limit | `feat/rate-limit` |\n| dark | 深色模式 | |\n===\n';
  const b = readBacklog(doc);
  assert.equal(b.key, "branch");
  assert.deepEqual(b.diagnostics, []);
  assert.deepEqual(b.items[0], { id: "rate-limit", title: "`login` limit", target: "feat/rate-limit" });
  assert.equal(b.items[1].id, "dark");
});

test("a table without id and title columns is a diagnostic", () => {
  const b = readBacklog("=== table {#backlog}\n| name | branch |\n|---|---|\n| x | y |\n===\n");
  assert.deepEqual(b.diagnostics, ["#backlog needs id and title columns"]);
});

test("a table block with another id is not the backlog", () => {
  assert.deepEqual(readBacklog("=== table {#other}\n| id | title | branch |\n|---|---|---|\n| a | b | c |\n===\n").diagnostics, ["no table block #backlog"]);
});

test("itemFor never matches an empty target: an unbound row is a to-do, not a binding", () => {
  const items = readBacklog(DOC).items;
  assert.equal(itemFor(items, ""), undefined);
  assert.equal(itemFor(items, "feat/none"), undefined);
});

test("binding to the same target again is allowed; binding leaves the other items alone", () => {
  const items = readBacklog(DOC).items;
  const again = bindItem(items, "rate-limit", "feat/rate-limit");
  assert.deepEqual(again, { ok: true, items });
  const bound = bindItem(items, "dark-mode", "feat/dark");
  assert.deepEqual(bound.items[0], items[0]);
  assert.equal(items[1].target, "");
});

test("a repeated id is a diagnostic from the reader, and bindItem refuses an id that is not unique", () => {
  const doc = '=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| a | one | |\n| b | two | |\n| a | three | |\n| b | four | |\n===\n';
  const b = readBacklog(doc);
  assert.equal(b.items.length, 4);
  assert.deepEqual(b.diagnostics, ['#backlog repeats id "a"', '#backlog repeats id "b"']);
  assert.deepEqual(bindItem(b.items, "a", "feat/x"), { ok: false, reason: "backlog id a is not unique" });
  assert.deepEqual(bindItem(b.items, "c", "feat/x"), { ok: false, reason: "no backlog item c" });
  const unique = readBacklog(DOC);
  assert.deepEqual(unique.diagnostics, []);
  assert.equal(bindItem(unique.items, "dark-mode", "feat/x").ok, true);
});

test("a repeated id is reported once however often it repeats", () => {
  const doc = '=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| a | 1 | |\n| a | 2 | |\n| a | 3 | |\n===\n';
  assert.deepEqual(readBacklog(doc).diagnostics, ['#backlog repeats id "a"']);
});

test("rendering turns a newline in a cell into a space, so a row never breaks", () => {
  const items = [
    { id: "a", title: "line one\nline two", target: "" },
    { id: "b", title: "crlf\r\nbreak and lone\rcr", target: "feat/b" },
  ];
  const text = renderBacklog(items, "branch");
  assert.equal(text.split(/\r\n|\r|\n/).filter((l) => l.startsWith("| a ") || l.startsWith("| b ")).length, 2);
  assert.deepEqual(readBacklog(text), {
    key: "branch",
    items: [
      { id: "a", title: "line one line two", target: "" },
      { id: "b", title: "crlf break and lone cr", target: "feat/b" },
    ],
    diagnostics: [],
  });
});

// -- binding in the document -------------------------------------------------

const RICH = [
  "=== meta", 'title = "Backlog"', 'profile = "geml-statechart/v1"', "===", "",
  "# 待办 | not a row", "",
  "Prose that mentions | pipes | and `code`.", "",
  "=== table {#backlog}",
  "| id        | title                | branch    |  notes  |",
  "|-----------|----------------------|-----------|---------|",
  "| rate-limit | 登录接口加限流        | feat/rate-limit | `a` \\| b |",
  "| dark-mode  | 设置页 \\| 深色模式     |   | keep   |",
  "",
  "|   export   | CSV 导出 |  | |",
  "===", "",
  "=== table {#other}", "| id | title | branch |", "|---|---|---|", "| dark-mode | not this one | |", "===", "",
].join("\n");

/** The lines of `text` that are not the lines of `before`, by position (the two must have the same number of lines). */
const changedLines = (before, after) => {
  const a = before.split("\n"), b = after.split("\n");
  assert.equal(b.length, a.length, "no line was added or removed");
  return b.flatMap((l, i) => (l === a[i] ? [] : [[i, a[i], l]]));
};

test("bindInDocument rewrites the one target cell and nothing else: prose, meta, other blocks, other columns, padding", () => {
  const r = bindInDocument(RICH, "dark-mode", "feat/dark");
  assert.equal(r.ok, true, r.reason);
  const changed = changedLines(RICH, r.text);
  assert.equal(changed.length, 1, "one line differs");
  assert.match(changed[0][1], /^\| dark-mode {2}\| 设置页 \\\| 深色模式 {5}\| {3}\| keep {3}\|$/);
  assert.match(changed[0][2], /^\| dark-mode {2}\| 设置页 \\\| 深色模式 {5}\| +feat\/dark +\| keep {3}\|$/);
  const b = readBacklog(r.text);
  assert.deepEqual(b.diagnostics, []);
  assert.deepEqual(b.items.map((i) => [i.id, i.title, i.target]), [
    ["rate-limit", "登录接口加限流", "feat/rate-limit"], ["dark-mode", "设置页 | 深色模式", "feat/dark"], ["export", "CSV 导出", ""],
  ]);
});

test("bindInDocument fills an empty cell however it was written: padded, a single space, none at all", () => {
  const r = bindInDocument(RICH, "export", "feat/csv");
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(changedLines(RICH, r.text).map(([, , l]) => l), ["|   export   | CSV 导出 | feat/csv | |"]);
  for (const row of ["| a | one | |", "| a | one ||", "| a | one |", "| a | one", "| a | one |    |", "a | one | "]) {
    const doc = `=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n${row}\n===\n`;
    const bound = bindInDocument(doc, "a", "feat/x");
    assert.equal(bound.ok, true, `${row}: ${bound.reason}`);
    assert.deepEqual(readBacklog(bound.text).items, [{ id: "a", title: "one", target: "feat/x" }], row);
  }
});

test("bindInDocument grows a short row to reach the column, and leaves the columns after it alone", () => {
  const doc = "=== table {#backlog}\n| id | title | branch | notes |\n|---|---|---|---|\n| a | one |\n| b | two | | n |\n===\n";
  const a = bindInDocument(doc, "a", "feat/a");
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(changedLines(doc, a.text).map(([, , l]) => l), ["| a | one | feat/a |"]);
  const wide = "=== table {#backlog}\n| id | title | notes | branch |\n|---|---|---|---|\n| a | one |\n===\n";
  const w = bindInDocument(wide, "a", "feat/a");
  assert.deepEqual(readBacklog(w.text).items, [{ id: "a", title: "one", target: "feat/a" }]);
  assert.deepEqual(changedLines(wide, w.text).map(([, , l]) => l), ["| a | one | | feat/a |"]);
});

test("bindInDocument keeps the line ends of a CRLF document and of a Markdown-flavoured one", () => {
  const crlf = RICH.replace(/\n/g, "\r\n");
  const r = bindInDocument(crlf, "dark-mode", "feat/dark");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.text.replace(/\r\n/g, "").includes("\n") || r.text.replace(/\r\n/g, "").includes("\r"), false, "every line end is still CRLF");
  assert.deepEqual(changedLines(crlf.replace(/\r\n/g, "\n"), r.text.replace(/\r\n/g, "\n")).length, 1);
  const noFinal = RICH.trimEnd();
  const t = bindInDocument(`${noFinal}`, "dark-mode", "feat/dark");
  assert.equal(t.ok, true);
});

test("bindInDocument: the same target again changes nothing; another target is refused; unknown, empty and repeated ids are refused", () => {
  const bound = bindInDocument(RICH, "rate-limit", "feat/rate-limit");
  assert.deepEqual(bound, { ok: true, text: RICH });
  const coded = "=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| a | one | `feat/x` |\n===\n";
  assert.deepEqual(bindInDocument(coded, "a", "feat/x"), { ok: true, text: coded }, "a code-span cell that already reads as the target is left as it is");
  assert.deepEqual(bindInDocument(RICH, "rate-limit", "feat/other"), { ok: false, reason: "rate-limit is already bound to feat/rate-limit" });
  assert.deepEqual(bindInDocument(RICH, "nope", "feat/x"), { ok: false, reason: "no backlog item nope" });
  assert.deepEqual(bindInDocument(RICH, "", "feat/x"), { ok: false, reason: "an empty id names no backlog item" });
  assert.deepEqual(bindInDocument(RICH, "dark-mode", ""), { ok: false, reason: "a work item to bind is needed" });
  const twice = "=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| a | 1 | |\n| a | 2 | |\n===\n";
  assert.deepEqual(bindInDocument(twice, "a", "feat/x"), { ok: false, reason: "backlog id a is not unique" });
});

test("bindInDocument writes a pipe in the target escaped, and a file backlog binds its file column", () => {
  const r = bindInDocument(RICH, "export", "feat/a|b");
  assert.equal(r.ok, true, r.reason);
  assert.equal(readBacklog(r.text).items[2].target, "feat/a|b");
  assert.match(r.text, /feat\/a\\\|b/);
  const file = "=== table {#backlog}\n| id | title | file |\n|---|---|---|\n| ep03 | 第三集 | |\n===\n";
  const f = bindInDocument(file, "ep03", "episodes/ep03.geml");
  assert.deepEqual(readBacklog(f.text), { key: "file", items: [{ id: "ep03", title: "第三集", target: "episodes/ep03.geml" }], diagnostics: [] });
});

test("bindInDocument refuses what it cannot write as itself: no column, another body form, rows from elsewhere, a value a cell cannot hold", () => {
  const noCol = "=== table {#backlog}\n| id | title |\n|---|---|\n| a | one |\n===\n";
  assert.deepEqual(bindInDocument(noCol, "a", "feat/x"), { ok: false, reason: "#backlog has no branch column" });
  const csv = "=== table {#backlog format=csv}\nid,title,branch\na,one,\n===\n";
  assert.match(bindInDocument(csv, "a", "feat/x").reason, /pipe table/);
  const elsewhere = "=== table {#backlog src=backlog.csv}\n===\n";
  assert.equal(bindInDocument(elsewhere, "a", "feat/x").ok, false);
  assert.equal(bindInDocument("=== meta\ntitle = \"x\"\n===\n", "a", "feat/x").reason, "no table block #backlog");
  // A newline becomes a space, and a lone code span reads as its text: neither reads back as what was asked for.
  assert.match(bindInDocument(RICH, "export", "a\nb").reason, /cannot be written/);
  assert.match(bindInDocument(RICH, "export", "`x`").reason, /cannot be written/);
  assert.match(bindInDocument(RICH, "export", "  ").reason, /cannot be written|needed/);
});

test("a row with no id is a diagnostic, and bindItem will not bind it", () => {
  const doc = "=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| a | one | |\n| | nameless | |\n===\n";
  const b = readBacklog(doc);
  assert.deepEqual(b.diagnostics, ["#backlog row 2 has no id"]);
  assert.deepEqual(bindItem(b.items, "", "feat/x"), { ok: false, reason: "an empty id names no backlog item" });
  assert.deepEqual(bindItem(b.items, "a", ""), { ok: false, reason: "a work item to bind is needed" });
  assert.deepEqual(readBacklog("=== table {#backlog}\n| name | branch |\n|---|---|\n| x | y |\n===\n").diagnostics, ["#backlog needs id and title columns"], "a table with no id column is not a table of nameless rows");
});
