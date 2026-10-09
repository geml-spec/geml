// A stateful stand-in for the Anytype desktop app's local API v2 — only the
// routes the bridge uses, with the semantics its specification states
// (anytype-heart core/api/APIV2.md): objects listed newest-modified first with
// offset/limit paging, an object read as an AnyBlock document with an ETag
// header, PATCH ops addressed by block id (an If-Match that does not match is
// a 409), object create, file upload and download. Where the real response
// shape was not pinned down, the shape here is an assumption the live
// acceptance run checks.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const mint = () => randomBytes(12).toString("hex"); // 24 hex, like Anytype's minted block ids

export function fakeAnytype({ apiKey = "test-key", space = "space1" } = {}) {
  const objects = new Map(); // id -> { doc, modified }
  const files = new Map();   // id -> { bytes, name, mime }
  let clock = Date.UTC(2026, 9, 1);
  let conflicts = 0;
  const log = [];
  const tick = () => (clock += 1000);

  const etagOf = (doc) => createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 8);
  const parentIdx = (blocks, i) => {
    for (let j = i - 1; j >= 0; j--) if ((blocks[j].indent ?? 0) < (blocks[i].indent ?? 0)) return j;
    return -1;
  };
  const subtreeEnd = (blocks, i) => {
    let k = i + 1;
    while (k < blocks.length && (blocks[k].indent ?? 0) > (blocks[i].indent ?? 0)) k++;
    return k;
  };
  const find = (blocks, id) => {
    const i = blocks.findIndex((b) => b.id === id);
    if (i < 0) throw Object.assign(new Error(`no block ${id}`), { status: 400, code: "validation_failed" });
    return i;
  };
  const rebase = (run, indent) => run.map((b) => {
    const out = { ...b };
    const v = (b.indent ?? 0) + indent;
    if (v) out.indent = v; else delete out.indent;
    return out;
  });
  /** Where a target object puts a run, and the indent its `indent: 0` means. */
  const slot = (blocks, t) => {
    if (t.after) { const i = find(blocks, t.after); return { at: subtreeEnd(blocks, i), indent: blocks[i].indent ?? 0 }; }
    if (t.inside) {
      const i = find(blocks, t.inside);
      return { at: t.position === "last" ? subtreeEnd(blocks, i) : i + 1, indent: (blocks[i].indent ?? 0) + 1 };
    }
    return { at: t.position === "last" ? blocks.length : 0, indent: 0 };
  };

  function applyOp(blocks, op, created) {
    switch (op.op) {
      case "update_block": {
        const b = blocks[find(blocks, op.id)];
        for (const [k, v] of Object.entries(op.set)) { if (v === null) delete b[k]; else b[k] = v; }
        return;
      }
      case "replace_subtree": {
        const i = find(blocks, op.id);
        const s = { at: i, indent: blocks[i].indent ?? 0 };
        const run = rebase(op.blocks, s.indent).map((b, k) => ({ ...b, id: k === 0 ? op.id : mint() }));
        blocks.splice(i, subtreeEnd(blocks, i) - i, ...run);
        return;
      }
      case "insert_blocks": {
        for (const b of op.blocks) if (b.id) throw Object.assign(new Error(`payload id ${b.id} resolves to nothing`), { status: 400, code: "validation_failed" });
        const s = slot(blocks, op);
        const run = rebase(op.blocks, s.indent).map((b) => ({ id: mint(), ...b }));
        created.push(run.map((b) => b.id));
        blocks.splice(s.at, 0, ...run);
        return;
      }
      case "move_block": {
        const i = find(blocks, op.id);
        const run = blocks.splice(i, subtreeEnd(blocks, i) - i);
        const s = slot(blocks, op);
        const base = run[0].indent ?? 0;
        blocks.splice(s.at, 0, ...rebase(run, s.indent - base));
        return;
      }
      case "delete_block": {
        const i = find(blocks, op.id);
        const end = subtreeEnd(blocks, i);
        if (end > i + 1 && !op.recursive) throw Object.assign(new Error("has descendants"), { status: 400, code: "validation_failed" });
        blocks.splice(i, end - i);
        return;
      }
      default: throw Object.assign(new Error(`unknown op ${op.op}`), { status: 400, code: "validation_failed" });
    }
  }

  const handlers = async (req, res, body) => {
    const url = new URL(req.url, "http://x");
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { status: 401, code: "unauthorized", message: "missing or invalid api key", issues: [] });
    const parts = url.pathname.split("/").filter(Boolean); // v2 spaces :space ...
    if (parts[0] !== "v2" || parts[1] !== "spaces" || parts[2] !== space) return send(404, { status: 404, code: "not_found", message: "space not found", issues: [] });
    const rest = parts.slice(3);
    log.push(`${req.method} /${rest.join("/")}`);

    if (rest[0] === "objects" && rest.length === 1 && req.method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 25);
      const fields = (url.searchParams.get("fields") ?? "").split(",").filter(Boolean);
      const all = [...objects.entries()].sort((a, b) => b[1].modified - a[1].modified);
      const data = all.slice(offset, offset + limit).map(([id, o]) => ({
        id, name: o.doc.properties?.Name ?? "", type: o.doc.type ?? "Page",
        ...(fields.includes("last_modified_date") ? { properties: { last_modified_date: new Date(o.modified).toISOString() } } : {}),
      }));
      return send(200, { data, total: all.length, offset, limit, has_more: offset + limit < all.length });
    }
    if (rest[0] === "objects" && rest.length === 2 && req.method === "GET") {
      const o = objects.get(rest[1]);
      if (!o) return send(404, { status: 404, code: "not_found", message: "object not found", issues: [] });
      return send(200, o.doc, { etag: `"${etagOf(o.doc)}"` });
    }
    if (rest[0] === "objects" && rest.length === 2 && req.method === "PATCH") {
      const o = objects.get(rest[1]);
      if (!o) return send(404, { status: 404, code: "not_found", message: "object not found", issues: [] });
      const match = (req.headers["if-match"] ?? "").replace(/^W\//, "").replace(/"/g, "");
      if (conflicts > 0) { conflicts--; return send(409, { status: 409, code: "etag_mismatch", message: "the object changed (injected)", etag: etagOf(o.doc), issues: [] }); }
      if (match && match !== etagOf(o.doc)) return send(409, { status: 409, code: "etag_mismatch", message: "the object changed", etag: etagOf(o.doc), issues: [] });
      const blocks = structuredClone(o.doc.blocks ?? []);
      // EditResult.created_blocks: payload position -> minted id.
      const createdBlocks = {};
      try {
        JSON.parse(body).ops.forEach((op, i) => {
          const created = [];
          applyOp(blocks, op, created);
          (created[0] ?? []).forEach((id, j) => { createdBlocks[`ops[${i}].blocks[${j}]`] = id; });
        });
      } catch (e) {
        return send(e.status ?? 400, { status: e.status ?? 400, code: e.code ?? "validation_failed", message: e.message, issues: [] });
      }
      o.doc.blocks = blocks;
      o.modified = tick();
      return send(200, { etag: etagOf(o.doc), created_blocks: createdBlocks }, { etag: `"${etagOf(o.doc)}"` });
    }
    if (rest[0] === "objects" && rest.length === 1 && req.method === "POST") {
      const doc = JSON.parse(body);
      const id = `bafy${mint()}`;
      const full = { ...doc, id, blocks: (doc.blocks ?? []).map((b) => ({ id: mint(), ...b })) };
      objects.set(id, { doc: full, modified: tick() });
      return send(201, { id, etag: etagOf(full) });
    }
    if (rest[0] === "files" && rest.length === 1 && req.method === "POST") {
      // multipart/form-data with a `file` field (FileUploadResult answers).
      const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] ?? "")?.[1];
      if (!boundary) return send(400, { status: 400, code: "validation_failed", message: "expected multipart/form-data", issues: [] });
      const text = body.toString("latin1");
      const part = text.split(`--${boundary}`).find((p) => /name="file"/.test(p));
      if (!part) return send(400, { status: 400, code: "validation_failed", message: "no file field", issues: [] });
      const [head, ...restOfPart] = part.split("\r\n\r\n");
      const name = /filename="([^"]*)"/.exec(head)?.[1] ?? "file";
      const mime = /Content-Type:\s*(\S+)/i.exec(head)?.[1] ?? "application/octet-stream";
      const bytes = Buffer.from(restOfPart.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1");
      const id = `bafyfile${mint()}`;
      files.set(id, { bytes, name, mime });
      return send(201, { id, name, mime_type: mime, size: bytes.length });
    }
    if (rest[0] === "files" && rest[2] === "content") {
      const f = files.get(rest[1]);
      if (!f) return send(404, { status: 404, code: "not_found", message: "file not found", issues: [] });
      res.writeHead(200, { "content-type": f.mime, "content-length": f.bytes.length });
      return res.end(req.method === "HEAD" ? undefined : f.bytes);
    }
    return send(404, { status: 404, code: "not_found", message: `no route ${req.method} ${url.pathname}`, issues: [] });
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const isBinary = (req.url ?? "").includes("/files") && req.method === "POST";
      handlers(req, res, isBinary ? raw : raw.toString("utf8")).catch((e) => { res.writeHead(500); res.end(String(e)); });
    });
  });

  return {
    apiKey, space, log, objects, files,
    async start() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop: () => new Promise((r) => server.close(r)),
    /** Seed an object, as if it had been made in the app. */
    add(doc) {
      const id = doc.id ?? `bafy${mint()}`;
      objects.set(id, { doc: { ...structuredClone(doc), id, blocks: (doc.blocks ?? []).map((b) => ({ id: mint(), ...b })) }, modified: tick() });
      return id;
    },
    /** Another device edits an object: `fn` mutates its document. */
    edit(id, fn) {
      const o = objects.get(id);
      fn(o.doc);
      o.modified = tick();
    },
    addFile(bytes, name, mime = "image/png") {
      const id = `bafyfile${mint()}`;
      files.set(id, { bytes: Buffer.from(bytes), name, mime });
      return id;
    },
    doc: (id) => structuredClone(objects.get(id).doc),
    /** The next `n` PATCHes answer 409, as if another device had just written. */
    conflictNext(n = 1) { conflicts = n; },
    /** The fake's clock, for a test that needs edits ordered against it. */
    now: () => new Date(clock),
  };
}
