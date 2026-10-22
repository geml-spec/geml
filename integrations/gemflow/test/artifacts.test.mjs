// What each work item made: the home's .geml/artifacts.geml #artifacts, the
// copies in .geml/artifacts/, and what the board shows of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyName, COPY_LIMIT, isMadeForPeople, pageTitle, artifactsOfItem, readArtifacts, renderArtifacts, withArtifacts } from "../dist/core/artifacts.js";
import { publishedLink } from "../dist/core/artifact-tool.js";
import { readArtifactRows, recordFile, recordLink, syncDocs, syncWritten } from "../dist/artifacts-store.js";
import { listRevisions } from "@geml/geml/dist/history.js";
import { artifactRows, sizeText } from "../dist/hosts/claude-code/board.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";
import { gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";
import { fileURLToPath } from "node:url";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const row = (over = {}) => ({ item: "feat/x", kind: "file", name: "out/a.txt", where: "artifacts/x.txt", version: "1", size: 5, at: "2026-10-20T01:00:00.000Z", sha256: "ab", ...over });
const git = (root, ...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
/** A repository that ignores out/; `home` is the repository itself, as a main checkout is. */
const repo = () => {
  const root = gitRepo();
  writeFileSync(join(root, ".gitignore"), "out/\n.geml/\n");
  mkdirSync(join(root, "out"), { recursive: true });
  return root;
};
const later = (path, s) => { const t = new Date(Date.now() + s * 1000); utimesSync(path, t, t); };

test("the #artifacts table: rows read back as written; a link's address, a path with markup characters and an empty size survive", () => {
  const rows = [
    row({ kind: "link", name: "Gemflow 界面示意", where: "https://claude.ai/artifact/Aw9u6PXP", version: "55", size: null, sha256: "" }),
    row({ name: "out/my_file [1].txt" }),
    row({ kind: "doc", name: "README.md", where: "git", version: "d366c414", size: null, sha256: "" }),
  ];
  assert.deepEqual(readArtifacts(renderArtifacts(rows)), rows);
  assert.deepEqual(readArtifacts("=== meta\ntitle = \"x\"\n===\n"), [], "no table, no rows");
});

test("withArtifacts rewrites only the #artifacts block; a document with none gets it appended; none at all is made whole", () => {
  const doc = "=== meta\ntitle = \"p\"\n===\n\nA person wrote this.\n\n" + renderArtifacts([row()]) + "\n\nAnd this.\n";
  const next = withArtifacts(doc, [row(), row({ version: "2" })]);
  assert.match(next, /A person wrote this\./);
  assert.match(next, /And this\./);
  assert.equal(readArtifacts(next).length, 2);
  assert.equal(readArtifacts(withArtifacts("=== meta\ntitle = \"p\"\n===\n", [row()])).length, 1);
  assert.match(withArtifacts(null, [row()]), /^=== meta\ntitle = "Gemflow artifacts"/);
});

test("a work item's artifacts: its rows by kind and name, versions oldest first, the most recently changed first", () => {
  const rows = [row({ at: "2026-10-18T00:00:00Z" }), row({ item: "other" }), row({ name: "b.png", kind: "image", at: "2026-10-19T00:00:00Z" }), row({ version: "2", at: "2026-10-20T00:00:00Z" })];
  const ps = artifactsOfItem(rows, "feat/x");
  assert.deepEqual(ps.map((p) => [p.kind, p.name, p.versions.map((v) => v.version)]), [["file", "out/a.txt", ["1", "2"]], ["image", "b.png", ["1"]]]);
  assert.equal(copyName("abc", "out/Pic.PNG"), "abc.png");
  assert.equal(copyName("abc", "Makefile"), "abc");
});

test("the Artifact tool's result names the link it published and its version; a page's title names it", () => {
  const said = "Published C:\\Users\\x\\page.html at https://claude.ai/artifact/MHHivk8Ef5NQSRjSeubrYZ (Version 3, version id 1792086025-315b) Icon: \"layout\".";
  assert.deepEqual(publishedLink(said), { url: "https://claude.ai/artifact/MHHivk8Ef5NQSRjSeubrYZ", version: "3" });
  assert.deepEqual(publishedLink("Published x at https://claude.ai/code/artifact/0b1c-22"), { url: "https://claude.ai/code/artifact/0b1c-22" });
  assert.equal(publishedLink("[Artifact a43c (version 1) — owned by you] https://claude.ai/artifact/MHH"), undefined, "a read is no publish");
  assert.deepEqual(publishedLink("Updated the Artifact at https://claude.ai/artifact/Aw9u6PXPAaXpFZYWppafY8 (Version 61, version id 1792479469-84e3) with C:\\s\\canvas.json"), { url: "https://claude.ai/artifact/Aw9u6PXPAaXpFZYWppafY8", version: "61" }, "published again: an update names its link too");
  assert.equal(pageTitle("<title>Gemflow 界面\n 示意</title><style>"), "Gemflow 界面 示意");
  assert.equal(pageTitle("<p>no title</p>"), undefined);
});

test("a file git does not keep: copied under its hash when first seen and again when its content changes; one git keeps, or will, is not", () => {
  const root = repo();
  writeFileSync(join(root, "out", "a.txt"), "first");
  writeFileSync(join(root, "b.ts"), "export {}\n");
  let rows = syncWritten(root, root, "feat/x", ["out/a.txt", "b.ts"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.version, r.where, r.size, r.sha256]), [["file", "out/a.txt", "1", `artifacts/${sha("first")}.txt`, 5, sha("first")]], "b.ts is not ignored: git will keep it");
  assert.equal(readFileSync(join(root, ".geml", "artifacts", `${sha("first")}.txt`), "utf8"), "first");
  assert.equal(syncWritten(root, root, "feat/x", ["out/a.txt"]).length, 1, "unchanged: no new version");
  writeFileSync(join(root, "out", "a.txt"), "second!");
  later(join(root, "out", "a.txt"), 5);
  rows = syncWritten(root, root, "feat/x", ["out/a.txt"]);
  assert.deepEqual(rows.map((r) => r.version), ["1", "2"]);
  assert.ok(existsSync(join(root, ".geml", "artifacts", `${sha("first")}.txt`)), "the first version's copy stays");
  assert.ok(existsSync(join(root, ".geml", "artifacts", `${sha("second!")}.txt`)));
  // The same content again, written anew: no version, the time is not news.
  writeFileSync(join(root, "out", "a.txt"), "second!");
  later(join(root, "out", "a.txt"), 10);
  assert.equal(syncWritten(root, root, "feat/x", ["out/a.txt"]).length, 2);
  assert.match(readFileSync(join(root, ".geml", "artifacts.geml"), "utf8"), /=== table \{#artifacts\}/);
});

test("only what is made for a person is an artifact on its own: a script, code or a config the work wrote for itself is not", () => {
  const root = repo();
  for (const f of ["run.mjs", "needs.json", "report.html", "chart.png", "notes.md"]) writeFileSync(join(root, "out", f), f);
  const rows = syncWritten(root, root, "feat/x", ["out/run.mjs", "out/needs.json", "out/report.html", "out/chart.png", "out/notes.md"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.name]), [["file", "out/report.html"], ["image", "out/chart.png"], ["file", "out/notes.md"]]);
  assert.deepEqual([isMadeForPeople("a/b.MP4"), isMadeForPeople("x.ts"), isMadeForPeople("Makefile")], [true, false, false]);
});

test("a GEML document git does not keep: one copy; its later versions go into the copy's .gemlhistory", () => {
  const root = repo();
  const doc = join(root, "out", "n.geml");
  writeFileSync(doc, "=== meta\ntitle = \"n\"\n===\n\nFirst.\n");
  syncWritten(root, root, "feat/x", ["out/n.geml"]);
  writeFileSync(doc, "=== meta\ntitle = \"n\"\n===\n\nFirst.\n\nSecond.\n");
  later(doc, 5);
  const rows = syncWritten(root, root, "feat/x", ["out/n.geml"]);
  const first = sha("=== meta\ntitle = \"n\"\n===\n\nFirst.\n");
  assert.deepEqual(rows.map((r) => [r.version, r.where]), [["1", `artifacts/${first}.geml`], ["2", `artifacts/${first}.geml`]], "one copy, named by its first version");
  const copy = join(root, ".geml", "artifacts", `${first}.geml`);
  assert.match(readFileSync(copy, "utf8"), /Second\./, "the copy holds the newest");
  assert.equal(listRevisions(join(root, ".geml", "artifacts", `${first}.gemlhistory`)).length, 2);
});

test("a file bigger than the copy limit is kept by where it is and its hash; a root in no repository has every file copied", () => {
  const root = repo();
  const big = join(root, "out", "big.mp4");
  writeFileSync(big, Buffer.alloc(COPY_LIMIT + 1, 1));
  const [r] = syncWritten(root, root, "feat/x", ["out/big.mp4"]);
  assert.equal(r.where, big.split("\\").join("/"));
  assert.equal(r.size, COPY_LIMIT + 1);
  assert.equal(r.sha256.length, 64);
  assert.equal(existsSync(join(root, ".geml", "artifacts", `${r.sha256}.mp4`)), false);
  const bare = mkdtempSync(join(tmpdir(), "gemflow-nogit-"));
  writeFileSync(join(bare, "notes.md"), "x");
  assert.deepEqual(syncWritten(bare, bare, "notes", ["notes.md"]).map((x) => x.name), ["notes.md"]);
});

test("links: a new row for a new version; the same one again is not; without a name it keeps the one it had. A picture the model names; the documents in git", () => {
  const home = repo();
  const at = "2026-10-20T01:00:00.000Z";
  recordLink(home, "feat/x", { name: "画布", url: "https://claude.ai/artifact/A", version: "1", at });
  recordLink(home, "feat/x", { name: "画布", url: "https://claude.ai/artifact/A", version: "1", at });
  const rows = recordLink(home, "feat/x", { url: "https://claude.ai/artifact/A", version: "2", at });
  assert.deepEqual(rows.map((r) => [r.name, r.version]), [["画布", "1"], ["画布", "2"]]);
  const outside = mkdtempSync(join(tmpdir(), "gemflow-pic-"));
  writeFileSync(join(outside, "p.png"), "png");
  const pic = recordFile(home, home, "feat/x", join(outside, "p.png"), "image");
  assert.equal(pic.kind, "image");
  assert.equal(pic.name, join(outside, "p.png").split("\\").join("/"), "outside the project: by its own path");
  assert.equal(recordFile(home, home, "feat/x", join(outside, "p.png"), "image"), undefined, "recorded already");
  syncDocs(home, "feat/x", [{ path: "README.md", sha: "d366c414aa", at }]);
  const docs = syncDocs(home, "feat/x", [{ path: "spec.md", sha: "0c4832cbbb", at }]).filter((r) => r.kind === "doc");
  assert.deepEqual(docs.map((r) => [r.name, r.where, r.version]), [["spec.md", "git", "0c4832cb"]], "git keeps their versions: the item's rows are what its commits changed now");
  assert.equal(readArtifactRows(home).filter((r) => r.kind === "link").length, 2);
});

test("a link's versions read again — a resumed or forked session's transcript holds the publishes before it — add no row", () => {
  const home = repo();
  const at = "2026-10-20T01:00:00.000Z";
  for (const version of ["1", "2", "3"]) recordLink(home, "feat/x", { name: "画布", url: "https://claude.ai/artifact/A", version, at });
  for (const version of ["1", "2", "3"]) recordLink(home, "feat/x", { name: "画布", url: "https://claude.ai/artifact/A", version, at });
  for (const version of ["1", "2"]) recordLink(home, "feat/x", { url: "https://claude.ai/artifact/A", version, at });
  assert.deepEqual(readArtifactRows(home).map((r) => r.version), ["1", "2", "3"]);
});

test("board: what the work item made, under what waits on the person — links, documents in git, files with copies, its code in one line", () => {
  const NOW = "2026-10-20T12:00:00+08:00";
  const t = wordsFor("zh");
  const made = {
    links: [{ kind: "link", name: "Gemflow 界面示意", open: "https://claude.ai/artifact/A", versions: [{ version: "55", at: NOW, size: null }] }],
    files: [{ kind: "file", name: ".geml/exports/s.geml", open: "/r/.geml/exports/s.geml", versions: [{ version: "2", at: NOW, size: 20480, copy: "/h/.geml/artifacts/aa.geml" }, { version: "1", at: NOW, size: 20000 }], history: "/h/.geml/artifacts/aa.gemlhistory" }],
    images: [],
    docs: [{ path: "README.md", open: "/r/README.md", commits: 12, at: NOW }, { path: "spec/workflow.md", open: "/r/spec/workflow.md", commits: 3, at: NOW }, { path: "x.md", open: "/r/x.md", commits: 1, at: NOW }],
    code: { commits: 39, files: 313 },
    folder: "/h/.geml/artifacts",
  };
  const artifacts = { item: "feat/x", written: [], commits: [], made };
  const words = (rows) => rows.map((r) => r.kind === "entry" ? `${r.title}|${r.tag}|${r.detail ?? ""}${r.link ? `|${r.link.label}` : ""}` : r.kind === "links" ? r.items.map((x) => x.label).join("/") : r.kind === "button" ? `[${r.label}]` : r.text);
  const rows = artifactRows(artifacts, "feat/x", { t, columns: 80, now: NOW, menu: null, docsOpen: false });
  assert.deepEqual(words(rows), [
    "产物 · feat/x",
    "链接 · 1", "Gemflow 界面示意||第 55 版 · 今天|打开 ↗",
    "文档 · 3 · 在 git 里", "README.md||12 次提交 · 今天", "spec/workflow.md||3 次提交 · 今天", "[其余 1 份]",
    "文件 · 1 · 不在 git 里，存了副本", ".geml/exports/s.geml||20 KB · 2 版 · 今天",
    "代码|39 个提交 · 改了 313 个文件|",
  ]);
  const open = artifactRows(artifacts, "feat/x", { t, columns: 80, now: NOW, menu: "file:.geml/exports/s.geml", docsOpen: true });
  // Each a press that opens it on the machine: a file: link is drawn as plain text on a remote surface and opens nothing.
  const opens = (path) => ({ op: "open-file", path });
  assert.deepEqual(open.find((r) => r.kind === "links").items.map((x) => [x.label, x.href, x.action]), [
    ["打开", undefined, opens("/r/.geml/exports/s.geml")], ["打开第 2 版副本", undefined, opens("/h/.geml/artifacts/aa.geml")], ["查看历史", undefined, opens("/h/.geml/artifacts/aa.gemlhistory")], ["在文件夹里显示", undefined, { ...opens("/r/.geml/exports/s.geml"), reveal: true }],
  ], "a GEML document's older versions are in its history, not in copies");
  const doc = artifactRows(artifacts, "feat/x", { t, columns: 80, now: NOW, menu: "doc:README.md", docsOpen: false });
  assert.deepEqual(doc.find((r) => r.kind === "links").items.map((x) => [x.label, x.href, x.action]), [["打开", undefined, opens("/r/README.md")], ["查看提交", undefined, { op: "tab", tab: "journal", filter: "artifacts" }]], "a document in git opens the same way");
  assert.ok(open.some((r) => r.kind === "entry" && r.title === "x.md"), "listed whole on a press");
  assert.equal(open.find((r) => r.kind === "button").label, "收起");
  assert.deepEqual(artifactRows(artifacts, "other", { t, columns: 80, now: NOW, menu: null, docsOpen: false }), [], "another work item's artifacts are not the current one's");
  assert.deepEqual([sizeText(512), sizeText(20480), sizeText(3 * 1024 * 1024)], ["512 B", "20 KB", "3.0 MB"]);
});

test("bridge: the board's artifacts — a file the work wrote that git ignores is copied, its documents and code counted; a link is recorded under the work item", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  writeFileSync(join(root, ".gitignore"), "out/\n.geml/\n");
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out", "r.txt"), "report");
  writeFileSync(join(root, "README.md"), "# x\n");
  writeFileSync(join(root, "a.ts"), "export {}\n");
  hook(root, { op: "status" });
  for (const [id, file] of [["w1", "out/r.txt"], ["w2", "README.md"]]) hook(root, { op: "after", tool: "Write", callId: id, input: { file_path: join(root, file) }, isError: false, gitOperation: false, wrotePath: file, lastFile: file });
  git(root, "add", "README.md", "a.ts", ".gitignore");
  git(root, "commit", "-qm", "docs");
  const made = hook(root, { op: "board" }).board.artifacts.made;
  assert.deepEqual(made.files.map((f) => [f.name, f.versions.length]), [["out/r.txt", 1]]);
  assert.deepEqual(made.docs.map((d) => [d.path, d.commits]), [["README.md", 1]]);
  assert.deepEqual(made.code, { commits: 1, files: 3 });
  const said = hook(root, { op: "artifact", kind: "link", where: "https://claude.ai/artifact/Z", version: "4", page: join(root, "out", "nope.html") });
  assert.equal(said.ok, true, JSON.stringify(said.error));
  assert.match(said.text, /Recorded the link under feat\/x/);
  assert.deepEqual(hook(root, { op: "board" }).board.artifacts.made.links.map((l) => [l.name, l.versions[0].version]), [["nope", "4"]], "a page that cannot be read: named by its file");
  // A design published again through its data file: named by the file's "title", kept on the next update.
  writeFileSync(join(root, "out", "canvas.json"), JSON.stringify({ v: 3, title: "Gemflow 界面示意" }));
  hook(root, { op: "artifact", kind: "link", where: "https://claude.ai/artifact/C", version: "60", page: join(root, "out", "canvas.json") });
  writeFileSync(join(root, "out", "canvas.json"), "{}");
  hook(root, { op: "artifact", kind: "link", where: "https://claude.ai/artifact/C", version: "61", page: join(root, "out", "canvas.json") });
  const canvas = hook(root, { op: "board" }).board.artifacts.made.links.find((l) => l.open === "https://claude.ai/artifact/C");
  assert.deepEqual([canvas.name, canvas.versions.map((v) => v.version)], ["Gemflow 界面示意", ["61", "60"]], "an update with no title keeps the name it had, not its file's");
  assert.equal(hook(root, { op: "artifact", kind: "link", where: "ftp://x" }).ok, false);
});

test("what the person gave and what was made for them outside the project: an upload by its file's name, a draft by its path; a script outside is still none", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  hook(root, { op: "status" });
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const up = hook(root, { op: "artifact", kind: "image", where: "upload", data: png, mediaType: "image/png", name: "C:\\Users\\me\\Desktop\\logo.png" });
  assert.match(up.text, /Recorded upload\/logo\.png under feat\/x/);
  assert.match(hook(root, { op: "artifact", kind: "image", where: "upload", data: png, mediaType: "image/png" }).text, /Nothing new/, "the same bytes again: recorded already");
  const anon = hook(root, { op: "artifact", kind: "image", where: "upload", data: Buffer.from("other").toString("base64"), mediaType: "image/png" });
  assert.match(anon.text, /upload\/upload-[0-9a-f]{8}\.png/, "a paste with no file name: named by its hash");
  const scratch = mkdtempSync(join(tmpdir(), "gemflow-scratch-"));
  writeFileSync(join(scratch, "icon-a.svg"), "<svg/>");
  writeFileSync(join(scratch, "tool.mjs"), "export {}");
  hook(root, { op: "artifacts", elsewhere: [join(scratch, "icon-a.svg"), join(scratch, "tool.mjs")] });
  const made = hook(root, { op: "board" }).board.artifacts.made;
  const images = made.images.map((i) => [i.name.split("\\").join("/").replace(/^.*\//, ""), i.given === true]).sort();
  assert.deepEqual(images, [["icon-a.svg", false], ["logo.png", true], ["upload-" + images.find(([n]) => n.startsWith("upload-"))[0].slice(7), true]], "the draft (not adopted, still counted), the uploads; no script");
  const logo = made.images.find((i) => i.name === "logo.png");
  assert.ok(logo.open.split("\\").join("/").includes("/.geml/artifacts/"), "an upload opens as its copy: there is no file of its own");
  assert.deepEqual(artifactRows({ item: "feat/x", written: [], commits: [], made: { ...made, docs: [], code: { commits: 0, files: 0 } } }, "feat/x", { t: wordsFor("zh"), columns: 80, menu: null, docsOpen: false })
    .filter((r) => r.kind === "entry" && r.title === "logo.png").map((r) => r.detail.split(" · ")[0]), ["用户提供"]);
});
