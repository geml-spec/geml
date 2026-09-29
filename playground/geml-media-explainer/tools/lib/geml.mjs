// 讲解片工具的公共部分：调用本仓库的 geml CLI、算哈希与时长、读写素材库。
//
// 素材块与生成记录**一律经 CLI 写入**（`geml add` / `geml set` / `geml media log`），
// 不直接改文档文本：片子里演的那条流水线，就是造出这支片子的那条流水线。
//
// 不用 `geml media import`：它按文件名派生 id、不写 role/of，同一路径的新字节
// 会派生出同一个 id 而撞车（设计 §10 待办 #8）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 讲解片目录。每个函数都收一个 root，缺省是它；测试传临时副本。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = process.env.GEML_CLI ?? resolve(ROOT, "../../geml-parser/dist/geml.js");
export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE ?? "ffprobe";
/** 每个镜头渲这几种语言；时间线也是每种语言一份。 */
export const LANGS = ["zh", "en"];

export function geml(args, { root = ROOT, input, allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`geml ${args.join(" ")} → 退出码 ${r.status}\n${r.stderr}${r.stdout}`);
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

export function probeDuration(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe ${path}：${r.stderr}`);
  return Number(Number(r.stdout.trim()).toFixed(3));
}

// 头行里的属性顺序固定：同一组事实永远写成同一行，否则每次重跑都是一处无意义的 diff。
const ORDER = ["src", "sha256", "kind", "duration", "origin", "of", "role"];

export function assetHead(id, attrs) {
  const keys = [...ORDER.filter((k) => k in attrs), ...Object.keys(attrs).filter((k) => !ORDER.includes(k)).sort()];
  if (/\s/.test(String(attrs.src ?? ""))) throw new Error(`#${id} 的 src=${attrs.src} 含空白：路径不加引号，换个文件名`);
  // 含空白的值加引号：`points="hand:1,2 eyes:3,4"` 就是这样写的。
  const v = (k) => (/\s/.test(String(attrs[k])) ? `"${attrs[k]}"` : String(attrs[k]));
  return `=== media-asset {#${id} ${keys.map((k) => `${k}=${v(k)}`).join(" ")}}`;
}

export const hasBlock = (doc, id, root = ROOT) =>
  geml(["get", doc, `#${id}`], { root, allowFail: true }).code === 0;

export const blockBody = (doc, id, root = ROOT) =>
  geml(["get", doc, `#${id}`, "--body"], { root }).stdout.trim();

/** 一个块头行上的属性。只认本工具写的形状：值不带引号、不含空白。 */
export function blockAttrs(doc, id, root = ROOT) {
  const head = geml(["get", doc, `#${id}`], { root }).stdout.split("\n")[0];
  const out = {};
  for (const m of head.matchAll(/([\w-]+)=("[^"]*"|[^\s}]+)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

/**
 * 没有就 add 到「素材」一节末尾，有就只换头行——手写在头行上的属性（points= 之类）保留，
 * 工具给的覆盖，`drop` 里列的删掉。
 */
export function upsertAsset(lib, id, attrs, root = ROOT, drop = []) {
  if (hasBlock(lib, id, root)) {
    const merged = { ...blockAttrs(lib, id, root), ...attrs };
    for (const k of drop) delete merged[k];
    geml(["set", lib, `#${id}`, "--head", "--in", "-"], { root, input: assetHead(id, merged) + "\n" });
  } else {
    const head = assetHead(id, attrs);
    geml(["add", lib, "--before", "#gen", "--in", "-"], { root, input: `${head}\n===\n\n` });
  }
}

/** 图片的宽高：`720x1280`。点要随 w 缩放，合成器得知道源图多宽（profile §5.2）。 */
export function probeSize(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe ${path}：${r.stderr}`);
  const [w, h] = r.stdout.trim().split(",");
  return `${w}x${h}`;
}

/** 把一个文件登记成素材：哈希、时长、尺寸取现值。file 相对 root（素材库就在 root）。 */
export function registerFile(lib, id, file, { kind, role, of }, root = ROOT) {
  const abs = join(root, file);
  const attrs = { src: file, sha256: sha256File(abs), kind, origin: "generated" };
  if (kind === "video" || kind === "audio") attrs.duration = probeDuration(abs);
  if (kind === "image") attrs.size = probeSize(abs);
  if (of !== undefined) attrs.of = of;
  if (role !== undefined) attrs.role = role;
  // 点是那张图的事实：字节换了，旧坐标随旧图作废，交回给调用方去说 —— 留着它，下一次合成
  // 就把碗放到旧图里手的位置上，而且谁都看不出来。
  const prev = hasBlock(lib, id, root) ? blockAttrs(lib, id, root) : {};
  const dropped = prev.points !== undefined && prev.sha256 !== attrs.sha256 ? prev.points : undefined;
  upsertAsset(lib, id, attrs, root, dropped === undefined ? [] : ["points"]);
  return dropped === undefined ? attrs : { ...attrs, dropped };
}

/** 追加一条生成记录。**必须带 --root .**：引用落在 root 外时 CLI 静默不写 prompt-sha256。 */
export function logGen(lib, { output, model, mode, prompt, inputs = [], seed, params }, root = ROOT) {
  const args = ["media", "log", lib, "--output", `#${output}`, "--model", model, "--mode", mode, "--root", "."];
  if (prompt !== undefined) args.push("--prompt", prompt);
  for (const i of inputs) args.push("--input", `#${i}`);
  if (seed !== undefined) args.push("--seed", String(seed));
  if (params !== undefined) args.push("--params", JSON.stringify(params));
  geml(args, { root });
}

export function checkJson(doc, root = ROOT) {
  const r = geml(["check", doc, "--root", ".", "--json"], { root, allowFail: true });
  const j = JSON.parse(r.stdout);
  return { core: j.core ?? [], profile: j.profile ?? [] };
}

// 这个产出要不要重做 —— 问 check，不自己比哈希。它说过期、说文件不对、说文件没了、
// 说这份字节没有记录认领，或者库里根本还没有这个块，都算。
const REGEN = new Set(["media-stale-generation", "media-hash-mismatch", "media-file-missing", "media-orphan-record"]);

export function needsRegen(lib, id, root = ROOT) {
  if (!hasBlock(lib, id, root)) return true;
  const { profile } = checkJson(lib, root);
  if (profile.some((d) => d.id === id && REGEN.has(d.code))) return true;
  // 有块、字节也对，但一条记录都没有（上次跑到一半断了）：自己看一眼日志。
  const log = blockBody(lib, "gen-log", root);
  return !log.split("\n").some((l) => l.includes(`"output":"#${id}"`));
}

/** 分镜表：| 镜号 | 时长 | 概念 | 声音？ | —— 声音一栏可省（旁白镜 / 成片镜）。 */
export function shotTable(root = ROOT) {
  const rows = blockBody("script.geml", "shots", root).split("\n").slice(2);
  return rows.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .map(([id, dur, concept, voice]) => ({ id, duration: Number(dur), concept, ...(voice ? { voice } : {}) }));
}

export function listIds(doc, root = ROOT) {
  return geml(["list", doc], { root }).stdout.split("\n")
    .map((l) => l.split(/\s+/)[0]).filter((s) => s.startsWith("#")).map((s) => s.slice(1));
}

/** 某镜某语言的旁白块 id，按序号排：vo-s07-zh-1, vo-s07-zh-2, … */
export function lineIds(shot, lang, root = ROOT) {
  const re = new RegExp(`^vo-${shot}-${lang}-(\\d+)$`);
  return listIds("script.geml", root).filter((id) => re.test(id))
    .sort((a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]));
}
