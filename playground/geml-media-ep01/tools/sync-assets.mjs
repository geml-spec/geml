// 把素材块里的事实同步成文件的真值：sha256 与 duration。
//
//   node tools/sync-assets.mjs
//
// 为什么两件一起做：只刷新日志、不更新素材块的 sha256，库里就继续声称一个文件已经
// 没有的哈希 —— 下一次 check 是 media-hash-mismatch，走血缘时每个素材都「来历不明」。
// P1 的 `geml media log` 把这两件绑在一起，正是因为在这里踩过。
//
// duration 用 ffprobe 读：h264 按 GOP 收尾，标称 5 秒的片子实际是 5.083 秒。手写的
// 时长是意图，ffprobe 读的是事实，而时间线要按事实算才能和出片对得上（设计 §5.1）。
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const haveProbe = spawnSync("ffprobe", ["-version"], { encoding: "utf8" }).status === 0;
if (!haveProbe) console.error("ffprobe 不在 PATH 上：只同步 sha256，时长保持文档里声明的值");

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const probe = (p) => {
  if (!haveProbe) return null;
  try {
    const n = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" }).trim());
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
  } catch { return null; }
};

let changed = 0;
for (const [rel, base] of [["library-shared.geml", ""], ["ep01/ep01-library.geml", "ep01"]]) {
  const f = join(R, rel);
  const text = readFileSync(f, "utf8");
  const next = text.replace(/\{"src":\s*"([^"]+)",\s*"sha256":\s*"[^"]*"([^}]*)/g, (m, src, tail) => {
    const p = join(R, base, src);
    let h;
    try { h = sha(p); } catch { return m; }
    let out = '{"src": "' + src + '", "sha256": "' + h + '"' + tail;
    if (/"duration":\s*[0-9.]+/.test(tail)) {
      const d = probe(p);
      if (d !== null) out = out.replace(/"duration":\s*[0-9.]+/, '"duration": ' + d);
    }
    changed++;
    return out;
  });
  if (next !== text) writeFileSync(f, next);
}
console.log(changed + " 个素材块的 sha256 / duration 已同步为文件真值");
