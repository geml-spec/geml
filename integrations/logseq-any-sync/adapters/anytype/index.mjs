// The Anytype adapter: what the sync engine needs from an app, spoken in the
// Anytype local API v2. The engine owns the history, the files and the
// cursor; this owns how an Anytype object becomes GEML and how GEML becomes
// the operations that edit it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { anytypeApi } from "./api.mjs";
import { anyToGeml, gemlToAny } from "./mapping.mjs";
import { patchOps } from "./diff.mjs";

export { AnytypeUnavailable, AnytypeError } from "./api.mjs";

const FILES = new Set(["file", "image", "video", "audio", "pdf"]);
const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };

const toMillis = (t) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "file";
/** The asset file a file block's bytes are kept in, relative to the vault. */
export const assetFile = (b) => `assets/${b.object_id}-${safeName(b.name ?? b.type)}`;

/**
 * @param {{ baseUrl: string, apiKey: string, space: string, version?: string,
 *           fetchImpl?: typeof fetch, maxFileBytes?: number }} o
 */
export function anytypeAdapter(o) {
  const api = anytypeApi(o);
  const maxFileBytes = o.maxFileBytes ?? 20 * 1024 * 1024;

  /** Give every block the vault created without an id a name that is stable
   *  across push rounds (its position among such blocks), so the ids Anytype
   *  mints for them can be paired and they are not inserted twice. */
  function target(text, ids) {
    const t = gemlToAny(text, { ids });
    let k = 0;
    for (const b of t.blocks) {
      if (b.gid === undefined && b.id === undefined) b.gid = `__new${k++}`;
      if (b.id === undefined && ids[b.gid] !== undefined) b.id = ids[b.gid];
    }
    return t;
  }

  /** A paragraph that is only `![alt](local file)` is an image to upload. */
  async function uploads(blocks, pageDir, vaultDir, uploaded) {
    for (const [i, b] of blocks.entries()) {
      if (b.type !== "paragraph" || b.id !== undefined) continue;
      const m = IMAGE_ONLY.exec(b.text ?? "");
      if (!m || /^[a-z]+:/i.test(m[2])) continue;
      const path = resolve(pageDir, m[2]);
      if (!path.startsWith(resolve(vaultDir)) || !existsSync(path)) continue;
      let up = uploaded.get(path);
      if (!up) {
        up = await api.upload(readFileSync(path), basename(path), MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
        uploaded.set(path, up);
      }
      blocks[i] = { gid: b.gid, type: "image", object_id: up.id, name: m[1] || basename(path), ...(b.indent ? { indent: b.indent } : {}) };
    }
  }

  return {
    name: "anytype",
    api,

    /** Objects modified after `cursor` (epoch ms), and the cursor to keep. When
     *  the list does not report modification times, every object is returned
     *  and the engine compares etags. */
    async changedSince(cursor) {
      const changed = [];
      let newest = cursor ?? 0;
      for (let offset = 0; ;) {
        const page = await api.listObjects({ offset, limit: 100, fields: "last_modified_date" });
        const rows = page.data ?? [];
        let stop = false;
        for (const r of rows) {
          const raw = r.properties?.last_modified_date ?? r.properties?.lastModifiedDate;
          if (raw === undefined) { changed.push({ ref: r.id, name: r.name }); continue; }
          const t = toMillis(raw);
          if (cursor && t <= cursor) { stop = true; break; }
          changed.push({ ref: r.id, name: r.name, modifiedAt: t });
          newest = Math.max(newest, t);
        }
        if (stop || !page.has_more || rows.length === 0) break;
        offset += rows.length;
      }
      return { changed, cursor: newest };
    },

    read: (ref) => api.getObject(ref),

    /** Download the bytes of the document's file blocks that are not in the
     *  vault yet and are small enough. */
    async fetchAssets(doc, vaultDir) {
      for (const b of doc.blocks ?? []) {
        if (!FILES.has(b.type) || !b.object_id) continue;
        const dest = join(vaultDir, assetFile(b));
        if (existsSync(dest)) continue;
        const size = b.size ?? (await api.fileSize(b.object_id));
        if (size === undefined || size > maxFileBytes) continue;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, await api.download(b.object_id));
      }
    },

    /** The object as GEML, links to assets relative to the page. */
    toGeml(doc, state, { vaultDir, pageDir }) {
      const rel = (p) => {
        const from = resolve(pageDir).split(/[\\/]/), to = resolve(vaultDir, p).split(/[\\/]/);
        let k = 0;
        while (k < from.length && k < to.length && from[k] === to[k]) k++;
        return [...from.slice(k).map(() => ".."), ...to.slice(k)].join("/");
      };
      const r = anyToGeml(doc, {
        ids: state.ids,
        assetPath: (b) => (b.object_id && existsSync(join(vaultDir, assetFile(b))) ? rel(assetFile(b)) : undefined),
      });
      return { text: r.text, state: { ...state, ids: r.ids } };
    },

    /**
     * Make the object hold `text`. Rounds: an operation that needs a block
     * minted in this request waits for the next one.
     * @returns {Promise<{ status: "nothing" | "ok" | "conflict" | "dry-run", doc?, etag?, state?, ops? }>}
     */
    async push(ref, pulled, text, state, ctx) {
      let { doc, etag } = pulled;
      const ids = { ...(state.ids ?? {}) };
      const uploaded = new Map();
      let pushed = false;
      for (let round = 0; round < 5; round++) {
        const t = target(text, ids);
        await uploads(t.blocks, ctx.pageDir, ctx.vaultDir, uploaded);
        const { ops, inserted, pending } = patchOps(doc.blocks ?? [], t.blocks);
        if (!ops.length) break;
        if (ctx.dryRun) return { status: "dry-run", ops };
        ctx.backup?.(doc);
        const r = await api.patchObject(ref, ops, etag);
        if (r.conflict) return { status: "conflict" };
        pushed = true;
        for (const ins of inserted) {
          ins.gids.forEach((g, j) => {
            const id = r.result.created_blocks?.[`ops[${ins.op}].blocks[${j}]`];
            if (g !== undefined && id) ids[g] = id;
          });
        }
        ({ doc, etag } = await api.getObject(ref));
        if (!pending) break;
      }
      for (const k of Object.keys(ids)) if (k.startsWith("__new")) delete ids[k];
      return { status: pushed ? "ok" : "nothing", doc, etag, state: { ...state, ids } };
    },

    /** A new object holding `text`. */
    async create(text, state, ctx) {
      const t = target(text, {});
      await uploads(t.blocks, ctx.pageDir, ctx.vaultDir, new Map());
      const env = t.envelope ?? {};
      const body = {
        type: env.type ?? "Page",
        properties: { ...(env.properties ?? {}), Name: t.title ?? env.properties?.Name ?? "Untitled" },
        blocks: t.blocks.map(({ id: _i, gid: _g, ...b }) => b),
      };
      if (ctx.dryRun) return { status: "dry-run", doc: body };
      const { id } = await api.createObject(body);
      const { doc, etag } = await api.getObject(id);
      // The created blocks come back in the order they were sent.
      const ids = {};
      t.blocks.forEach((b, i) => { const minted = doc.blocks?.[i]?.id; if (b.gid && !b.gid.startsWith("__new") && minted) ids[b.gid] = minted; });
      return { status: "ok", ref: id, doc, etag, state: { ...state, ids } };
    },
  };
}
