// A small client for the Anytype desktop app's local API v2 (served by
// anytype-heart on 127.0.0.1 while the app runs). Only the routes the bridge
// uses. The API key is the caller's: paired in the app, read from the
// environment by the CLI, and sent nowhere but this local server.

export class AnytypeUnavailable extends Error {}

export class AnytypeError extends Error {
  constructor(status, body) {
    super(`Anytype API ${status}: ${body?.message ?? JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {{ baseUrl: string, apiKey: string, space: string, version?: string, fetchImpl?: typeof fetch }} o
 */
export function anytypeApi({ baseUrl, apiKey, space, version = "2025-11-08", fetchImpl = globalThis.fetch }) {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(method, path, { query, json, form, ifMatch } = {}) {
    const url = new URL(`${base}/v2/spaces/${encodeURIComponent(space)}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${apiKey}`, "anytype-version": version };
    let body;
    if (json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
    if (form) body = form;
    if (ifMatch) headers["if-match"] = `"${ifMatch}"`;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body });
    } catch (e) {
      throw new AnytypeUnavailable(`cannot reach the Anytype app at ${base} (${e.cause?.code ?? e.message}) — is the desktop app running?`);
    }
    return res;
  }

  async function json(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
  }

  const etagOf = (res, body) => (res.headers.get("etag") ?? body?.etag ?? "").replace(/^W\//, "").replace(/"/g, "");

  return {
    /** One page of the object list (newest-modified first), rows carrying `fields`. */
    async listObjects({ offset = 0, limit = 100, fields } = {}) {
      const res = await call("GET", "/objects", { query: { offset, limit, fields } });
      const body = await json(res);
      if (!res.ok) throw new AnytypeError(res.status, body);
      return body;
    },

    /** The object as an AnyBlock document with full ids, and its etag. */
    async getObject(id) {
      const res = await call("GET", `/objects/${encodeURIComponent(id)}`, { query: { ids: "full" } });
      const body = await json(res);
      if (!res.ok) throw new AnytypeError(res.status, body);
      return { doc: body, etag: etagOf(res, body) };
    },

    /** Apply ops atomically. A changed object (If-Match) answers `{ conflict: true }`. */
    async patchObject(id, ops, ifMatch) {
      const res = await call("PATCH", `/objects/${encodeURIComponent(id)}`, { query: { ids: "full" }, json: { ops }, ifMatch });
      const body = await json(res);
      if (res.status === 409) return { conflict: true, body };
      if (!res.ok) throw new AnytypeError(res.status, body);
      return { conflict: false, result: body, etag: etagOf(res, body) };
    },

    async createObject(doc) {
      const res = await call("POST", "/objects", { json: doc });
      const body = await json(res);
      if (!res.ok) throw new AnytypeError(res.status, body);
      return { id: body.id, etag: etagOf(res, body) };
    },

    /** A file's size, without its bytes; undefined when the app does not say. */
    async fileSize(id) {
      const res = await call("HEAD", `/files/${encodeURIComponent(id)}/content`);
      if (!res.ok) return undefined;
      const n = Number(res.headers.get("content-length"));
      return Number.isFinite(n) ? n : undefined;
    },

    async download(id) {
      const res = await call("GET", `/files/${encodeURIComponent(id)}/content`);
      if (!res.ok) throw new AnytypeError(res.status, await json(res));
      return Buffer.from(await res.arrayBuffer());
    },

    /** Upload bytes as a file object: multipart/form-data with a `file` field. */
    async upload(bytes, name, mime = "application/octet-stream") {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime }), name);
      const res = await call("POST", "/files", { form });
      const body = await json(res);
      if (!res.ok) throw new AnytypeError(res.status, body);
      return body; // { id, name, mime_type, size }
    },
  };
}
