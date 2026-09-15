// 走血缘 DAG，报出过期项。这是设计稿 §8 第 4 步的一次性实现：
//   · 先按 output-sha256 给每个素材定位「当前记录」（同一个 output 可能有多条）
//   · 当前记录里的每个输入比现值：素材比文件哈希，提示词比展开后文本的哈希，
//     prompt-refs 比各投射源的现值
//   · 过期沿 DAG 向下传播；最后查每个片段的 src 是不是过期产出
//
//   node tools/stale.mjs
import { parse } from "../../../geml-parser/dist/geml.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const R = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(R, p), "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const docs = new Map();
const load = (p) => { if (!docs.has(p)) docs.set(p, parse(read(p)).children); return docs.get(p); };
const find = (bs, id) => { for (const b of bs) { if (b.id === id) return b; if (b.children) { const h = find(b.children, id); if (h) return h; } } return null; };
const paraText = (b) => { const p = (b?.children ?? []).find((c) => c.kind === "paragraph"); const t = (n) => n.map((x) => x.type === "text" ? x.value : (x.children ? t(x.children) : (x.value ?? ""))).join(""); return p ? t(p.inlines) : null; };

// 素材：库文档里带 src+sha256 的 data 块
const assets = new Map();
for (const lib of ["library-shared.geml", "ep01/ep01-library.geml"]) {
  const dir = lib.includes("/") ? lib.slice(0, lib.lastIndexOf("/")) : "";
  for (const b of load(lib)) {
    const walk = (x) => {
      if (x.id && x.value && x.value.src && x.value.sha256) assets.set(`${lib}#${x.id}`, { ...x.value, file: join(dir, x.value.src), short: x.id });
      (x.children ?? []).forEach(walk);
    };
    walk(b);
  }
}
const cur = new Map();
for (const [k, a] of assets) { try { cur.set(k, sha(readFileSync(join(R, a.file)))); } catch { cur.set(k, null); } }

// 提示词现值：展开投射后的纯文本
const promptNow = (addr) => {
  const [doc, id] = addr.split("#");
  const b = find(load("ep01/" + doc), id);
  const t = (nodes) => nodes.map((n) => {
    if (n.type === "text") return n.value;
    if (n.type === "project") { const tb = find(load(n.doc.replace(/^\.\.\//, "")), n.anchor); return paraText(tb) ?? ""; }
    return n.children ? t(n.children) : (n.value ?? "");
  }).join("");
  const p = (b?.children ?? []).find((c) => c.kind === "paragraph");
  return p ? sha(Buffer.from(t(p.inlines), "utf8")) : null;
};
const refNow = (ref) => { const [doc, id] = ref.replace(/^\.\.\//, "").split("#"); const b = find(load(doc), id); const x = paraText(b); return x === null ? null : sha(Buffer.from(x, "utf8")); };

// 日志
const log = find(load("ep01/ep01-library.geml"), "gen-log").value;
const key = (out) => out.startsWith("#") ? "ep01/ep01-library.geml" + out : out;
const byOutput = new Map();
for (const r of log) { if (!r.output) continue; const k = key(r.output); (byOutput.get(k) ?? byOutput.set(k, []).get(k)).push(r); }

const stale = new Map(); const orphan = [];
for (const [k, recs] of byOutput) {
  const now = cur.get(k);
  let rec = recs.filter((r) => r["output-sha256"] === now).sort((a, b) => a.at < b.at ? 1 : -1)[0];
  if (!rec) { orphan.push(k); rec = recs[recs.length - 1]; }
  const why = [];
  if (rec["prompt-sha256"] && promptNow(rec.prompt) !== rec["prompt-sha256"]) why.push("提示词 " + rec.prompt);
  for (const pr of rec["prompt-refs"] ?? []) if (refNow(pr.ref) !== pr.sha256) why.push("投射源 " + pr.ref);
  for (const inp of rec.inputs ?? []) { const ik = key(inp.ref); if ((cur.get(ik) ?? inp.sha256) !== inp.sha256) why.push("输入 " + inp.ref); }
  if (why.length) stale.set(k, why);
}
// 传播
let grew = true;
while (grew) {
  grew = false;
  for (const [k, recs] of byOutput) {
    if (stale.has(k)) continue;
    const rec = recs[recs.length - 1];
    for (const inp of rec.inputs ?? []) { const ik = key(inp.ref); if (stale.has(ik)) { stale.set(k, ["上游过期 " + inp.ref]); grew = true; break; } }
  }
}
// 片段
const clips = [];
for (const b of load("ep01/ep01-cut.geml")) {
  const walk = (x) => { if (x.id && x.value && x.value.src) clips.push({ id: x.id, src: x.value.src }); (x.children ?? []).forEach(walk); };
  walk(b);
}
const staleClips = clips.filter((c) => stale.has("ep01/" + c.src));

console.log(`素材 ${assets.size} · 记录 ${log.length} · 片段 ${clips.length}`);
if (orphan.length) console.log("来历不明（没有记录的 output-sha256 等于现值）: " + orphan.join(", "));
if (!stale.size) { console.log("过期：无"); }
else { console.log("过期记录 " + stale.size + " 条:"); for (const [k, why] of stale) console.log("  " + k.split("#")[1] + "  ← " + why.join("; ")); }
console.log(staleClips.length ? "受影响的片段: " + staleClips.map((c) => "#" + c.id).join(" ") : "受影响的片段：无");
