// produce-episode.test.mjs —— 做一集的纯规则：产出命名、归属、抠像命令、步骤顺序、运镜、字幕配对、分镜表。
import { test } from "node:test";
import assert from "node:assert/strict";
import { outputOf, standOf, ofFor, roleFor, keyArgs, KEY_PARAMS, keyParamsChanged, STEPS, diskOk, assertDisk, motionExpr, cues, shots, SEEDS, EP } from "../produce-episode.mjs";

test("提示词 → 产出：角色图与母版直接出图，立绘先出一张 take 再抠成 stand", () => {
  assert.equal(outputOf("hero-sheet-prompt"), "hero-sheet");
  assert.equal(outputOf("rooftop-plate-prompt"), "rooftop-plate");
  assert.equal(outputOf("hero-fall-prompt"), "hero-fall-take");
  assert.equal(standOf("hero-fall-take"), "hero-fall");
  assert.equal(standOf("rooftop-plate"), null, "母版不抠");
  assert.equal(standOf("hero-sheet"), null, "角色图不抠");
});

test("道具也是一张抠好的图，但角色是 prop 不是 stand；归属指道具块", () => {
  assert.equal(roleFor("bowl"), "prop");
  assert.equal(roleFor("hero-fall"), "stand");
  assert.equal(ofFor("bowl-take"), "characters.geml#bowl");
  assert.equal(standOf("bowl-take"), "bowl");
});

test("产出的 of=：角色的归角色，母版归场景", () => {
  assert.equal(ofFor("hero-fall-take"), "characters.geml#hero");
  assert.equal(ofFor("hero-fall"), "characters.geml#hero");
  assert.equal(ofFor("sister-hand"), "characters.geml#sister");
  assert.equal(ofFor("hero-sheet"), "characters.geml#hero");
  assert.equal(ofFor("rooftop-plate"), "characters.geml#rooftop");
  assert.equal(ofFor("bedroom-door-plate"), "characters.geml#bedroom-door");
});

test("每个要出的图都有种子：两张角色图、三张母版、八张立绘、一张道具", () => {
  const ids = ["hero-sheet", "sister-sheet", "rooftop-plate", "bedroom-plate", "bedroom-door-plate",
    "hero-fall-take", "hero-wake-take", "hero-mirror-take", "hero-sit-take", "hero-refuse-take", "sister-door-take", "sister-hand-take",
    "sister-offer-take", "bowl-take"];
  for (const id of ids) assert.ok(Number.isInteger(SEEDS[id]), id);
  assert.equal(Object.keys(SEEDS).length, ids.length, "种子表里没有多余的名字");
});

test("抠像：松容差 colorkey 之后从角落 floodfill —— 只有和边缘连通的才是背景，银发里的洞补回不透明", () => {
  const a = keyArgs("in.png", "out.png", "847ff6");
  const graph = a[a.indexOf("-filter_complex") + 1];
  assert.match(graph, /colorkey=0x847ff6:0\.22:0\.0/, graph);
  assert.match(graph, /alphaextract,format=gray,floodfill=x=0:y=0:s0=0:d0=1/, graph);
  assert.match(graph, /lut=y='if\(eq\(val,1\),0,255\)'/, graph);
  assert.match(graph, /alphamerge/, graph);
  assert.deepEqual(a.slice(-3), ["-pix_fmt", "rgba", "out.png"]);
  assert.deepEqual(KEY_PARAMS, { method: "colorkey+floodfill", similarity: 0.22, feather: 1 });
});

test("抠像参数变了就重抠：看日志里该产出最后一条记录的 params", () => {
  const log = [
    JSON.stringify({ output: "#hero-fall", model: "ffmpeg-colorkey", mode: "other", params: { key: "#959be8", similarity: 0.18, blend: 0.1 } }),
    JSON.stringify({ output: "#hero-wake", model: "ffmpeg-colorkey", mode: "other", params: { key: "#aab0e9", ...KEY_PARAMS } }),
    JSON.stringify({ output: "#hero-fall", model: "ffmpeg-colorkey", mode: "other", params: { key: "#959be8", ...KEY_PARAMS } }),
  ].join("\n");
  assert.equal(keyParamsChanged(log, "hero-fall"), false, "最后一条已经是现在的参数");
  assert.equal(keyParamsChanged(log, "hero-wake"), false);
  assert.equal(keyParamsChanged(log.split("\n").slice(0, 1).join("\n"), "hero-fall"), true, "旧参数");
  assert.equal(keyParamsChanged(log, "sister-door"), true, "没记录也算变了");
});

test("出图前看磁盘：q8 模型的换页文件会把盘吃掉，低于 2GB 就停，不猜", () => {
  assert.equal(diskOk(2 * 1024 ** 3), true);
  assert.equal(diskOk(2 * 1024 ** 3 - 1), false);
  assert.throws(() => assertDisk(1.5 * 1024 ** 3), /磁盘只剩 1\.5GB/);
});

test("八步：抠像与合成接在出图之后、运镜之前", () => {
  assert.deepEqual(STEPS, ["images", "stands", "compose", "takes", "voices", "music", "cut", "render"]);
});

test("分镜表：六镜，时长、运镜、台词都读得出", () => {
  const list = shots(EP);
  assert.equal(list.length, 6);
  assert.deepEqual(list[0], { id: "s01", duration: 5, motion: "拉远", line: "n1" });
  assert.equal(list.reduce((a, s) => a + s.duration, 0), 36);
});

test("运镜：四种都有表达式，不认识的直接报错", () => {
  for (const m of ["推近", "缓推", "拉远", "横移"]) {
    const e = motionExpr(m);
    assert.ok(e.z && e.x && e.y, m);
  }
  assert.match(motionExpr("拉远").z, /^1\.22-/);
  assert.throws(() => motionExpr("甩镜"), /不认识的运镜/);
});

test("字幕：同一时段的中英两条合成一组；谁是中文按内容认，不按先后", () => {
  const srt = "1\n00:00:00,400 --> 00:00:02,000\nThat night\n\n2\n00:00:00,400 --> 00:00:02,000\n那一夜\n\n3\n00:00:05,400 --> 00:00:07,000\n再睁眼\n";
  assert.deepEqual(cues(srt), [{ a: 0.4, b: 2, zh: "那一夜", en: "That night" }, { a: 5.4, b: 7, zh: "再睁眼", en: "" }]);
});
