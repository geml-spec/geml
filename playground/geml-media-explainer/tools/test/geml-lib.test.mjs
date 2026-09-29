// geml-lib.test.mjs —— 在临时副本上跑真实的 geml CLI。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "../lib/geml.mjs";
import {
  assetHead, hasBlock, registerFile, logGen, checkJson,
  needsRegen, shotTable, lineIds, blockBody, blockAttrs,
} from "../lib/geml.mjs";
const awaitImport = () => lib;

// 夹具自带最小文档，不复制工作区里的：真实的库会随渲染长出块，真实的剧本会随计划 B 长出镜头，
// 复制它们的测试结果取决于你上次跑了什么。
const CONCEPTS = `=== meta
title = "t"
profile = "geml-media/v1"
===

# 旁白 {#narrator}

# 血缘 {#lineage}
`;
const SCRIPT = `=== meta
title = "t"
profile = "geml-media/v1"
===

=== table {#shots}
| 镜号 | 时长 | 概念 |
|---|---|---|
| s07 | 14 | concepts.geml#lineage |
| s08 | 10 | concepts.geml#lineage |
===

=== media-text {#vo-s07-zh-2 .line speaker=concepts.geml#narrator}
第二句。
===

=== media-text {#vo-s07-zh-1 .line speaker=concepts.geml#narrator}
每一次生成，都记下当时每个输入的哈希。
===

=== media-text {#vo-s07-en-1 .line speaker=concepts.geml#narrator}
First.
===
`;

// 与仓库里 library.geml 初始的骨架同形：素材一节、生成日志一节，日志为空。
const LIBRARY = `=== meta
title = "t"
profile = "geml-media/v1"
===

# 素材 {#assets}

# 生成日志 {#gen}

=== data {#gen-log .gen-log format=jsonl}
===
`;

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "explainer-lib-"));
  writeFileSync(join(d, "concepts.geml"), CONCEPTS);
  writeFileSync(join(d, "script.geml"), SCRIPT);
  writeFileSync(join(d, "library.geml"), LIBRARY);
  mkdirSync(join(d, "scenes"));
  return d;
}

test("assetHead 属性顺序固定；含空白的值加引号（points 就是这样），路径里的空白仍然拒", () => {
  assert.equal(
    assetHead("x", { role: "take", kind: "video", src: "a.mp4", sha256: "ab", duration: 2, origin: "generated" }),
    "=== media-asset {#x src=a.mp4 sha256=ab kind=video duration=2 origin=generated role=take}",
  );
  assert.equal(
    assetHead("x", { src: "a.png", kind: "image", points: "hand:1,2 eyes:3,4" }),
    '=== media-asset {#x src=a.png kind=image points="hand:1,2 eyes:3,4"}',
  );
  assert.throws(() => assetHead("x", { src: "a b.mp4" }), /空白/);
});

test("registerFile 重登记：字节没变，手写的 points= 保留；字节变了，点随旧图作废并说出来", () => {
  const d = fixture();
  writeFileSync(join(d, "scenes/s07.js"), "export default 1\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  const { geml } = awaitImport();
  const sha = blockAttrs("library.geml", "scene-s07", d).sha256;
  geml(["set", "library.geml", "#scene-s07", "--head", "--in", "-"], { root: d, input: `=== media-asset {#scene-s07 src=scenes/s07.js sha256=${sha} kind=other origin=generated role=workflow points="p:1,2"}\n` });
  const same = registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  assert.equal(blockAttrs("library.geml", "scene-s07", d).points, "p:1,2", "同一份字节，点还是那张图的事实");
  assert.equal(same.dropped, undefined);
  writeFileSync(join(d, "scenes/s07.js"), "export default 2\n");
  const changed = registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  const a = blockAttrs("library.geml", "scene-s07", d);
  assert.equal(a.points, undefined, "图换了，旧坐标不能留");
  assert.equal(changed.dropped, "p:1,2", "作废的点要交回给调用方去说");
  assert.notEqual(a.sha256, sha);
});

test("shotTable 读出分镜表，保持表里的顺序", () => {
  assert.deepEqual(shotTable(fixture()), [
    { id: "s07", duration: 14, concept: "concepts.geml#lineage" },
    { id: "s08", duration: 10, concept: "concepts.geml#lineage" },
  ]);
});

test("lineIds 按序号排（不按文档里的先后），只收本镜本语言", () => {
  const d = fixture();
  assert.deepEqual(lineIds("s07", "zh", d), ["vo-s07-zh-1", "vo-s07-zh-2"]);
  assert.deepEqual(lineIds("s07", "en", d), ["vo-s07-en-1"]);
  assert.deepEqual(lineIds("s08", "zh", d), []);
  assert.equal(blockBody("script.geml", "vo-s07-zh-1", d), "每一次生成，都记下当时每个输入的哈希。");
});

test("夹具是一份空库：不受工作区里渲染过什么影响", () => {
  const d = fixture();
  assert.equal(hasBlock("library.geml", "scene-s07", d), false);
  assert.equal(blockBody("library.geml", "gen-log", d), "");
  assert.deepEqual(checkJson("library.geml", d), { core: [], profile: [] });
});

test("registerFile：没有就 add，有就 set 头行；check 保持干净", () => {
  const d = fixture();
  writeFileSync(join(d, "scenes/s07.js"), "export default 1\n");
  assert.equal(hasBlock("library.geml", "scene-s07", d), false);
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow", of: "concepts.geml#lineage" }, d);
  assert.equal(hasBlock("library.geml", "scene-s07", d), true);
  const first = blockAttrs("library.geml", "scene-s07", d);
  assert.equal(first.role, "workflow");
  writeFileSync(join(d, "scenes/s07.js"), "export default 2\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow", of: "concepts.geml#lineage" }, d);
  assert.notEqual(blockAttrs("library.geml", "scene-s07", d).sha256, first.sha256);
  const { core, profile } = checkJson("library.geml", d);
  assert.deepEqual([core, profile], [[], []]);
});

test("registerFile：图片登记时带 size=宽x高 —— 点要随 w 缩放，合成器得知道源图多宽", () => {
  const d = fixture();
  mkdirSync(join(d, "assets"));
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=4x6", "-frames:v", "1", join(d, "assets/pic.png")]);
  if (r.status !== 0) { console.log("skip: 没有 ffmpeg"); return; }
  registerFile("library.geml", "pic", "assets/pic.png", { kind: "image", role: "stand" }, d);
  assert.equal(blockAttrs("library.geml", "pic", d).size, "4x6");
  registerFile("library.geml", "txt", "concepts.geml", { kind: "other", role: "workflow" }, d);
  assert.equal(blockAttrs("library.geml", "txt", d).size, undefined, "不是图片不写 size");
});

test("needsRegen：没块、没记录、输入变了都算；记过之后不算", () => {
  const d = fixture();
  writeFileSync(join(d, "scenes/s07.js"), "export default 1\n");
  writeFileSync(join(d, "out.txt"), "rendered 1\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), true);             // 没块
  registerFile("library.geml", "shot-s07", "out.txt", { kind: "other", role: "take" }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), true);             // 有块没记录
  logGen("library.geml", { output: "shot-s07", model: "render-scenes", mode: "code2v", inputs: ["scene-s07"] }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), false);            // 记过了
  writeFileSync(join(d, "scenes/s07.js"), "export default 2\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), true);             // 输入变了
});

test("logGen 带 --root .：提示词的哈希一定写进记录", () => {
  const d = fixture();
  writeFileSync(join(d, "v.txt"), "voice\n");
  registerFile("library.geml", "voice-s07-zh-1", "v.txt", { kind: "other", role: "voice" }, d);
  logGen("library.geml", { output: "voice-s07-zh-1", model: "say-Tingting", mode: "tts", prompt: "script.geml#vo-s07-zh-1" }, d);
  const log = blockBody("library.geml", "gen-log", d).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(log.at(-1)["prompt-sha256"], /^[0-9a-f]{64}$/);
});
