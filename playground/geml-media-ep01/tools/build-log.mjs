import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "../../../geml-parser/dist/geml.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const R = fileURLToPath(new URL("..", import.meta.url));
// 素材哈希当场算，项目自包含。
const H = new Proxy({}, { get: (_, p) => createHash("sha256").update(readFileSync(join(R, String(p)))).digest("hex") });
const P = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("hash-prompts.mjs", import.meta.url)), join(R, "ep01/ep01-script.geml")], { encoding: "utf8" }));
const chars = parse(readFileSync(`${R}/characters.geml`, "utf8")).children;
const findB = (bs, id) => { for (const b of bs) { if (b.id === id) return b; if (b.children) { const h = findB(b.children, id); if (h) return h; } } return null; };
const txt = (n) => n.map((x) => x.type === "text" ? x.value : (x.children ? txt(x.children) : (x.value ?? ""))).join("");
// 角色卡块的哈希：块正文的纯文本，与展开器同一口径。
const look = (id) => { const b = findB(chars, id); const para = (b.children ?? []).find((c) => c.kind === "paragraph"); return createHash("sha256").update(txt(para.inlines), "utf8").digest("hex"); };
const ref = (id) => ({ ref: "../characters.geml#" + id, sha256: look(id) });
const A = (p) => H["ep01/assets/gen/" + p];
const S = (p) => H["assets/" + p];
const rows = [
  { output: "#s01-key", "output-sha256": A("s01-key.png"), model: "jimeng-4.5", mode: "t2i", seed: 20481,
    prompt: "ep01-script.geml#s01-prompt", "prompt-sha256": P["s01-prompt"].sha256,
    "prompt-refs": [ref("look"), ref("hero-look")],
    inputs: [{ ref: "../library-shared.geml#hero-sheet", sha256: S("hero-sheet.png") }], at: "2026-09-15T09:12:03Z" },
  { output: "#s01-take3", "output-sha256": A("s01-take3.mp4"), model: "seedance-2.0", mode: "i2v", seed: 88213,
    prompt: "ep01-script.geml#s01-prompt", "prompt-sha256": P["s01-prompt"].sha256,
    "prompt-refs": [ref("look"), ref("hero-look")],
    inputs: [{ ref: "#s01-key", sha256: A("s01-key.png"), role: "first-frame" }], at: "2026-09-15T09:20:41Z" },
  { output: "#s01-take5", "output-sha256": A("s01-take5.mp4"), model: "seedance-2.0", mode: "i2v", seed: 88217,
    prompt: "ep01-script.geml#s01-prompt", "prompt-sha256": P["s01-prompt"].sha256,
    "prompt-refs": [ref("look"), ref("hero-look")],
    inputs: [{ ref: "#s01-key", sha256: A("s01-key.png"), role: "first-frame" }], at: "2026-09-15T09:26:15Z" },
  { output: "#s02-take1", "output-sha256": A("s02-take1.mp4"), model: "kling-3.0", mode: "t2v", seed: 5150,
    prompt: "ep01-script.geml#s02-prompt", "prompt-sha256": P["s02-prompt"].sha256,
    "prompt-refs": [ref("look"), ref("hero-look"), ref("mourning-hall-desc")],
    inputs: [{ ref: "../library-shared.geml#mourning-hall", sha256: S("mourning-hall.png"), role: "master" }], at: "2026-09-15T09:31:07Z" },
  { output: "#s03-take2", "output-sha256": A("s03-take2.mp4"), model: "seedance-2.0", mode: "t2v", seed: 41007,
    prompt: "ep01-script.geml#s03-prompt", "prompt-sha256": P["s03-prompt"].sha256,
    "prompt-refs": [ref("look"), ref("sister-look"), ref("hero-look")],
    inputs: [{ ref: "../library-shared.geml#hero-sheet", sha256: S("hero-sheet.png"), role: "sheet" },
             { ref: "../library-shared.geml#sister-sheet", sha256: S("sister-sheet.png"), role: "sheet" }], at: "2026-09-15T10:02:55Z" },
  { output: "#s01-l1-vo", "output-sha256": A("s01-l1-vo.wav"), model: "cosyvoice-3", mode: "tts",
    prompt: "ep01-script.geml#s01-l1", "prompt-sha256": P["s01-l1"].sha256, "prompt-refs": [],
    inputs: [{ ref: "../library-shared.geml#narrator-voice", sha256: S("narrator-voice.wav"), role: "voice" }],
    params: { emotion: "平", speed: 0.9 }, at: "2026-09-15T10:10:22Z" },
  { output: "#s03-l1-vo", "output-sha256": A("s03-l1-vo.wav"), model: "cosyvoice-3", mode: "tts",
    prompt: "ep01-script.geml#s03-l1", "prompt-sha256": P["s03-l1"].sha256, "prompt-refs": [],
    inputs: [{ ref: "../library-shared.geml#sister-voice", sha256: S("sister-voice.wav"), role: "voice" }],
    params: { emotion: "假哭" }, at: "2026-09-15T10:11:40Z" },
  { output: "#s03-l2-vo", "output-sha256": A("s03-l2-vo.wav"), model: "cosyvoice-3", mode: "tts",
    prompt: "ep01-script.geml#s03-l2", "prompt-sha256": P["s03-l2"].sha256, "prompt-refs": [],
    inputs: [{ ref: "../library-shared.geml#hero-voice", sha256: S("hero-voice.wav"), role: "voice" }],
    params: { emotion: "冷" }, at: "2026-09-15T10:12:05Z" },
  { output: "#s03-take2-lips", "output-sha256": A("s03-take2-lips.mp4"), model: "sekotalk-2.0", mode: "lipsync",
    inputs: [{ ref: "#s03-take2", sha256: A("s03-take2.mp4") },
             { ref: "#s03-l1-vo", sha256: A("s03-l1-vo.wav") },
             { ref: "#s03-l2-vo", sha256: A("s03-l2-vo.wav") }],
    params: { speakers: 2 }, at: "2026-09-15T10:20:31Z" },
];
const f = `${R}/ep01/ep01-library.geml`;
writeFileSync(f, readFileSync(f, "utf8").replace("PROMPT_HASHES_GO_HERE", rows.map((r) => JSON.stringify(r)).join("\n")));
console.log(rows.length + " 条记录写入日志");
