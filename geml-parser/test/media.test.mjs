// geml-media/v1 的检查器（profile 文档 §7）。诊断码属于 profile，不进规范 Appendix A；
// 它们按**地址**报（文档 + 块 id）而不是按行号 —— 这是 profile 自己的选择，和这个
// 项目"id 优于行号"的立场一致，也因为跨文档的诊断没有单一的行号可言。
import { checkMedia } from "../dist/media-check.js";
import { mediaIoFor } from "../dist/host-fs.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

/** 在临时目录里搭一个项目，返回它的根。 */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), "geml-media-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : body, typeof body === "string" ? "utf8" : undefined);
  }
  return root;
}
const META = '=== meta\nprofile = "geml-media/v1"\n===\n\n';
const codes = (ds) => ds.map((d) => d.code).sort();

test("干净的一份素材库没有诊断", () => {
  const root = project({
    "lib.geml": META + '=== media-asset {#a src=a.txt sha256=' + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" + ' kind=other}\n===\n',
    "a.txt": "",
  });
  const ds = checkMedia("lib.geml", mediaIoFor(root));
  assert.deepEqual(ds, [], JSON.stringify(ds));
  rmSync(root, { recursive: true, force: true });
});

test("哈希不符是 error，文件缺失是 warning，没哈希是 warning", () => {
  const root = project({
    "lib.geml": META
      + "=== media-asset {#wrong src=a.txt sha256=aaaa kind=other}\n===\n\n"
      + "=== media-asset {#gone src=nope.txt sha256=bbbb kind=other}\n===\n\n"
      + "=== media-asset {#bare src=a.txt kind=other}\n===\n",
    "a.txt": "",
  });
  const ds = checkMedia("lib.geml", mediaIoFor(root));
  assert.deepEqual(codes(ds), ["media-asset-unhashed", "media-file-missing", "media-hash-mismatch"], JSON.stringify(ds));
  const mismatch = ds.find((d) => d.code === "media-hash-mismatch");
  assert.equal(mismatch.severity, "error");
  assert.equal(mismatch.id, "wrong", "诊断要点名是哪个块");
  rmSync(root, { recursive: true, force: true });
});

test("轨道：名字缺种类、种类不认识、片段没有 track=", () => {
  const root = project({
    "cut.geml": '=== meta\nprofile = "geml-media/v1"\ntracks = "video:video bare subtitle:caption"\n===\n\n'
      + "=== media-clip {#c1 src=#x}\n===\n",
  });
  const ds = checkMedia("cut.geml", mediaIoFor(root));
  const c = codes(ds);
  assert.ok(c.includes("media-track-kind-missing"), JSON.stringify(ds));
  assert.ok(c.includes("media-track-kind-unknown"), JSON.stringify(ds));
  assert.ok(c.includes("media-track-missing"), JSON.stringify(ds));
  rmSync(root, { recursive: true, force: true });
});

// ---- 血缘：过期与传播 -------------------------------------------------------

import { createHash } from "node:crypto";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** 一个最小的血缘项目：角色卡 → 提示词 → 素材 → 片段。 */
function lineageProject(look = "银灰短发齐耳。") {
  const asset = "TAKE-BYTES";
  const promptText = look + " 特写，缓推。";
  return {
    files: {
      "a.mp4": asset,
      "script.geml": META
        + `=== media-text {#look .look}\n${look}\n===\n\n`
        + "=== media-text {#p .prompt shot=s01}\n![[#look]] 特写，缓推。\n===\n",
      "lib.geml": META
        + `=== media-asset {#take src=a.mp4 sha256=${sha(asset)} kind=video duration=5}\n===\n\n`
        + '=== data {#gen-log .gen-log format=jsonl}\n'
        + JSON.stringify({
            output: "#take", "output-sha256": sha(asset), model: "m", mode: "t2v",
            prompt: "script.geml#p", "prompt-sha256": sha(promptText),
            "prompt-refs": [{ ref: "script.geml#look", sha256: sha(look) }],
            at: "2026-09-15T00:00:00Z",
          }) + "\n===\n",
      "cut.geml": '=== meta\nprofile = "geml-media/v1"\ntracks = "video:video"\n===\n\n'
        + "=== media-clip {#c1 track=video src=lib.geml#take in=0 out=5}\n===\n",
    },
  };
}

test("血缘：源头没动时，没有过期", () => {
  const root = project(lineageProject().files);
  const ds = checkMedia("cut.geml", mediaIoFor(root));
  assert.deepEqual(ds, [], JSON.stringify(ds));
  rmSync(root, { recursive: true, force: true });
});

test("血缘：改角色卡一个词 —— 记录过期，用它的片段跟着过期，且诊断点名是哪个源", () => {
  const p = lineageProject();
  p.files["script.geml"] = p.files["script.geml"].replace("银灰短发齐耳。", "银灰短发及肩。");
  const root = project(p.files);
  const ds = checkMedia("cut.geml", mediaIoFor(root));
  const gen = ds.find((d) => d.code === "media-stale-generation");
  const clip = ds.find((d) => d.code === "media-stale-clip");
  assert.ok(gen, "记录该过期: " + JSON.stringify(ds));
  assert.match(gen.message, /#look/, "消息要点名变了的那个投射源，而不是只说提示词变了");
  assert.ok(clip, "用它的片段该跟着过期");
  assert.equal(clip.id, "c1");
  rmSync(root, { recursive: true, force: true });
});

test("血缘：日志缺必需字段是 media-gen-schema，点名记录序号与字段", () => {
  const root = project({
    "lib.geml": META + '=== data {#gen-log .gen-log format=jsonl}\n{"output":"#x","model":"m"}\n===\n',
  });
  const ds = checkMedia("lib.geml", mediaIoFor(root));
  const d = ds.find((x) => x.code === "media-gen-schema");
  assert.ok(d, JSON.stringify(ds));
  assert.match(d.message, /\[0\]/, "要点名是第几条记录");
  assert.match(d.message, /mode|at/, "要点名缺的是哪个字段");
  rmSync(root, { recursive: true, force: true });
});

test("片段：src 悬空、指错类型、缺 dur、轨道没声明", () => {
  const root = project({
    "lib.geml": META + "=== media-text {#line .line speaker=#who}\n台词\n===\n\n"
      + "=== media-asset {#still src=s.png kind=image}\n===\n\n"
      + "=== media-text {#who}\n角色\n===\n",
    "s.png": "PNG",
    "cut.geml": '=== meta\nprofile = "geml-media/v1"\ntracks = "video:video sub:prose"\n===\n\n'
      + "=== media-clip {#gone track=video src=lib.geml#nope}\n===\n\n"
      + "=== media-clip {#wrong track=video src=lib.geml#line}\n===\n\n"
      + "=== media-clip {#nodur track=video src=lib.geml#still}\n===\n\n"
      + "=== media-clip {#odd track=ghost src=lib.geml#still dur=2}\n===\n",
  });
  const c = codes(checkMedia("cut.geml", mediaIoFor(root)));
  for (const want of ["media-src-unresolved", "media-src-not-asset", "media-dur-required", "media-track-undeclared"]) {
    assert.ok(c.includes(want), want + " 没报出: " + c.join(","));
  }
  rmSync(root, { recursive: true, force: true });
});

test("散文轨：src 必须指 media-text，且必须有 dur", () => {
  const root = project({
    "lib.geml": META + "=== media-asset {#a src=a.txt kind=other}\n===\n\n=== media-text {#l .line speaker=#w}\n台词\n===\n\n=== media-text {#w}\n人\n===\n",
    "a.txt": "",
    "cut.geml": '=== meta\nprofile = "geml-media/v1"\ntracks = "sub:prose"\n===\n\n'
      + "=== media-clip {#bad track=sub src=lib.geml#a dur=1}\n===\n\n"
      + "=== media-clip {#nodur track=sub src=lib.geml#l}\n===\n",
  });
  const c = codes(checkMedia("cut.geml", mediaIoFor(root)));
  assert.ok(c.includes("media-src-not-asset"), c.join(","));
  assert.ok(c.includes("media-dur-required"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("台词与素材的引用：speaker 必填、speaker/to/of 悬空各自报出", () => {
  const root = project({
    "lib.geml": META
      + "=== media-text {#a .line}\n没有说话人\n===\n\n"
      + "=== media-text {#b .line speaker=#ghost to=#alsogone}\n有，但指不到\n===\n\n"
      + "=== media-asset {#x src=x.txt kind=other of=#nobody}\n===\n",
    "x.txt": "",
  });
  const ds = checkMedia("lib.geml", mediaIoFor(root));
  const c = codes(ds);
  assert.ok(c.includes("media-line-no-speaker"), c.join(","));
  assert.equal(ds.filter((d) => d.code === "media-speaker-unresolved").length, 2, "speaker 与 to 各一条");
  assert.ok(c.includes("media-of-unresolved"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("血缘：现在的字节没有任何记录认领 —— media-orphan-record", () => {
  const p = lineageProject();
  p.files["a.mp4"] = "DIFFERENT-BYTES";      // 文件换了，日志没跟上
  const root = project(p.files);
  const c = codes(checkMedia("lib.geml", mediaIoFor(root)));
  assert.ok(c.includes("media-orphan-record"), c.join(","));
  assert.ok(c.includes("media-hash-mismatch"), "素材块声明的哈希也对不上了: " + c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("血缘：过期沿 DAG 向下传播 —— 上游的 take 变了，吃它的合成也过期", () => {
  const base = "TAKE";
  const comp = "COMPOSITE";
  const root = project({
    "a.mp4": base,
    "b.mp4": comp,
    "lib.geml": META
      + `=== media-asset {#take src=a.mp4 sha256=${sha(base)} kind=video duration=5}\n===\n\n`
      + `=== media-asset {#lips src=b.mp4 sha256=${sha(comp)} kind=video duration=5}\n===\n\n`
      + '=== data {#gen-log .gen-log format=jsonl}\n'
      + JSON.stringify({ output: "#take", "output-sha256": sha(base), model: "m", mode: "t2v",
          inputs: [{ ref: "#seed", sha256: "0000" }], at: "2026-09-15T00:00:00Z" }) + "\n"
      + JSON.stringify({ output: "#lips", "output-sha256": sha(comp), model: "m", mode: "lipsync",
          inputs: [{ ref: "#take", sha256: sha(base) }], at: "2026-09-15T01:00:00Z" }) + "\n===\n\n"
      + `=== media-asset {#seed src=a.mp4 sha256=${sha(base)} kind=video duration=5}\n===\n`,
  });
  const ds = checkMedia("lib.geml", mediaIoFor(root));
  const stale = ds.filter((d) => d.code === "media-stale-generation").map((d) => d.id).sort();
  assert.deepEqual(stale, ["lips", "take"], "take 因输入哈希对不上而过期，lips 因上游过期而过期: " + JSON.stringify(ds));
  assert.match(ds.find((d) => d.id === "lips").message, /上游过期/);
  rmSync(root, { recursive: true, force: true });
});
console.log(`
${passed} passed`);
