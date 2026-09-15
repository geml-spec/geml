// 算「模型看到的那串字」的哈希：把一个提示词/台词块里的投射全部展开，取纯文本的
// SHA-256。核心今天没有按块展开的办法（`geml get` 返回原文，投射标记原样留着；
// 只有整篇 `--to md` 才展开），所以这个项目不得不自带一个展开器。
// 这段代码存在本身就是 §9 第 2 条（`get --resolved`）的用例。
//
//   node tools/hash-prompts.mjs ep01/ep01-script.geml
import { parse } from "../../../geml-parser/dist/geml.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const entry = process.argv[2];
const base = dirname(resolve(entry));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const opts = { resolveDoc: (p) => read(join(base, p)) };

const docCache = new Map();
function blocksOf(path) {
  if (path === undefined) return parse(read(resolve(entry)), opts).children;
  if (!docCache.has(path)) docCache.set(path, parse(read(join(base, path)) ?? "", opts).children);
  return docCache.get(path);
}
function findBlock(blocks, id) {
  for (const b of blocks) {
    if ((b.kind === "block" || b.kind === "heading") && b.id === id) return b;
    if (b.kind === "block" && b.children) { const hit = findBlock(b.children, id); if (hit) return hit; }
  }
  return null;
}
function inlineText(nodes, depth = 0) {
  if (depth > 8) throw new Error("投射嵌套过深");
  return nodes.map((n) => {
    if (n.type === "text") return n.value;
    if (n.type === "project") {
      const target = findBlock(blocksOf(n.doc), n.anchor);
      if (!target) throw new Error("投射目标不存在: " + (n.doc ?? "") + "#" + n.anchor);
      const para = (target.children ?? []).find((c) => c.kind === "paragraph");
      if (!para) throw new Error("投射目标不是单段落文本块: " + n.anchor);
      return inlineText(para.inlines, depth + 1);
    }
    if (n.type === "strong" || n.type === "emph") return inlineText(n.children ?? [], depth);
    if (n.type === "code") return n.value;
    if (n.type === "link" || n.type === "image") return inlineText(n.children ?? [], depth);
    return n.value ?? "";
  }).join("");
}

const out = {};
for (const b of blocksOf()) {
  const walk = (blocks) => {
    for (const x of blocks) {
      if (x.kind === "block" && x.id && (x.classes ?? []).some((c) => c === "prompt" || c === "line")) {
        const para = (x.children ?? []).find((c) => c.kind === "paragraph");
        const text = para ? inlineText(para.inlines) : "";
        out[x.id] = { text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
      }
      if (x.kind === "block" && x.children) walk(x.children);
      if (x.kind === "heading" && x.children) walk(x.children);
    }
  };
  walk([b]);
}
console.log(JSON.stringify(out, null, 1));
