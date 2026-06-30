(() => {
  // <define:process.argv>
  var define_process_argv_default = [];

  // src/node-stub.js
  var readFileSync = () => "";
  var writeFileSync = () => {
  };
  var existsSync = () => false;
  var basename = (p) => p;
  var dirname = (p) => p;
  var resolve = (...p) => p.join("/");
  var createHash = () => ({
    update() {
      return this;
    },
    digest() {
      return "";
    }
  });

  // ../geml-parser/dist/history.js
  function loadBytes(path) {
    const raw = readFileSync(path);
    const nl = raw.includes(13) && raw.includes(10) ? "\r\n" : "\n";
    return { lf: raw.toString("utf8").replace(/\r\n/g, "\n"), nl };
  }
  function bytesOf(lf, nl) {
    return Buffer.from(lf.replace(/\n/g, nl), "utf8");
  }
  function writeBytes(path, lf, nl) {
    writeFileSync(path, bytesOf(lf, nl));
  }
  function fullHash(lf, nl) {
    return "sha256:" + createHash("sha256").update(bytesOf(lf, nl)).digest("hex");
  }
  function shortOf(hash) {
    return hash.replace(/^sha256:/, "").slice(0, 8);
  }
  function makeId(stamp, hash) {
    return `${stamp}-${shortOf(hash)}`;
  }
  function stampUTC(d) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }
  var FENCE_OPEN = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;
  function locate(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const m = FENCE_OPEN.exec(lines[i]);
      if (m) {
        const fenceLen = m[1].length;
        const attrLine = m[3] ?? "";
        const idm = /#([A-Za-z][A-Za-z0-9_-]*)/.exec(attrLine);
        let j = i + 1;
        while (j < lines.length) {
          const t = lines[j].replace(/\s+$/, "");
          if (/^=+$/.test(t) && t.length === fenceLen)
            break;
          j++;
        }
        out.push({ type: m[2], id: idm?.[1], attrLine, fenceLen, start: i, end: Math.min(j, lines.length - 1) });
        i = j + 1;
      } else {
        i++;
      }
    }
    return out;
  }
  function attr(attrLine, key) {
    const m = new RegExp(`${key}=("([^"]*)"|[^\\s}]+)`).exec(attrLine);
    return m ? m[2] !== void 0 ? m[2] : m[1] : void 0;
  }
  function fenceFor(contentLf) {
    let longest = 0;
    for (const line of contentLf.split("\n")) {
      const m = /^=+/.exec(line);
      if (m)
        longest = Math.max(longest, m[0].length);
    }
    return "=".repeat(Math.max(longest + 1, 3));
  }
  var KEY = String.raw`(#[A-Za-z][A-Za-z0-9_-]*|@[0-9a-f]+(?:~\d+)?)`;
  function sha8(s) {
    return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex").slice(0, 8);
  }
  function tile(lines) {
    const units = [];
    const n = lines.length;
    let i = 0;
    while (i < n) {
      const start = i;
      if (lines[i].trim() === "") {
        while (i < n && lines[i].trim() === "")
          i++;
        units.push({ start, bodyEnd: i, endExcl: i });
        continue;
      }
      const fo = FENCE_OPEN.exec(lines[i]);
      let id;
      if (fo) {
        const fenceLen = fo[1].length;
        id = /#([A-Za-z][A-Za-z0-9_-]*)/.exec(fo[3] ?? "")?.[1];
        i++;
        while (i < n) {
          const t = lines[i].replace(/\s+$/, "");
          const close = /^=+$/.test(t) && t.length === fenceLen;
          i++;
          if (close)
            break;
        }
      } else {
        i++;
        while (i < n && lines[i].trim() !== "" && !FENCE_OPEN.test(lines[i]))
          i++;
      }
      const bodyEnd = i;
      while (i < n && lines[i].trim() === "")
        i++;
      units.push({ start, bodyEnd, endExcl: i, id });
    }
    return units;
  }
  function keyedUnits(lines) {
    const counts = /* @__PURE__ */ new Map();
    return tile(lines).map((u) => {
      if (u.id)
        return { u, key: `#${u.id}` };
      const base = `@${sha8(lines.slice(u.start, u.bodyEnd).join("\n"))}`;
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      return { u, key: n === 0 ? base : `${base}~${n}` };
    });
  }
  function locateUnit(lines, key) {
    const ku = keyedUnits(lines).find((x) => x.key === key);
    if (!ku)
      throw new Error(`history: unit ${key} not found while applying reverse patch`);
    return ku.u;
  }
  function parseAnchor(s) {
    if (s === "at-start" || s === "at-end")
      return s;
    const m = new RegExp("^after\\s+" + KEY + "$").exec(s);
    if (!m)
      throw new Error(`history: bad anchor: ${s}`);
    return { after: m[1] };
  }
  function anchorStr(a) {
    return a === "at-start" || a === "at-end" ? a : `after ${a.after}`;
  }
  function parseOps(body) {
    const ops = [];
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line)
        continue;
      let m;
      if (m = new RegExp("^delete\\s+" + KEY + "$").exec(line)) {
        ops.push({ kind: "delete", key: m[1] });
      } else if (m = new RegExp("^replace\\s+" + KEY + "\\s+<-\\s+blob:(\\S+)$").exec(line)) {
        ops.push({ kind: "replace", key: m[1], blob: m[2] });
      } else if (m = /^insert\s+<-\s+blob:(\S+)\s+(.+)$/.exec(line)) {
        ops.push({ kind: "insert", blob: m[1], anchor: parseAnchor(m[2]) });
      } else if (m = new RegExp("^move\\s+" + KEY + "\\s+(.+)$").exec(line)) {
        ops.push({ kind: "move", key: m[1], anchor: parseAnchor(m[2]) });
      } else {
        throw new Error(`history: unrecognized reverse-patch op: ${line}`);
      }
    }
    return ops;
  }
  function insertAt(lines, anchor, payload) {
    if (anchor === "at-start") {
      lines.splice(0, 0, ...payload);
      return;
    }
    if (anchor === "at-end") {
      lines.push(...payload);
      return;
    }
    const a = locateUnit(lines, anchor.after);
    lines.splice(a.endExcl, 0, ...payload);
  }
  function applyReverse(textLf, ops, blobs) {
    const lines = textLf.split("\n");
    const blob = (id) => {
      const p = blobs.get(id);
      if (p === void 0)
        throw new Error(`history: unresolved blob:${id}`);
      return p.split("\n");
    };
    for (const op of ops) {
      if (op.kind === "delete") {
        const u = locateUnit(lines, op.key);
        lines.splice(u.start, u.endExcl - u.start);
      } else if (op.kind === "replace") {
        const u = locateUnit(lines, op.key);
        lines.splice(u.start, u.endExcl - u.start, ...blob(op.blob));
      } else if (op.kind === "insert") {
        insertAt(lines, op.anchor, blob(op.blob));
      } else {
        const u = locateUnit(lines, op.key);
        const cut = lines.slice(u.start, u.endExcl);
        lines.splice(u.start, u.endExcl - u.start);
        insertAt(lines, op.anchor, cut);
      }
    }
    return lines.join("\n");
  }
  function lcsMatch(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i2 = n - 1; i2 >= 0; i2--)
      for (let j2 = m - 1; j2 >= 0; j2--)
        dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    const aMatch = new Array(n).fill(-1);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        aMatch[i] = j;
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1])
        i++;
      else
        j++;
    }
    return aMatch;
  }
  function diffReverse(oldLf, newLf) {
    const oldLines = oldLf.split("\n");
    const newLines = newLf.split("\n");
    const oldU = keyedUnits(oldLines);
    const newU = keyedUnits(newLines);
    const oldKeys = oldU.map((x) => x.key);
    const newKeys = newU.map((x) => x.key);
    const aMatch = lcsMatch(newKeys, oldKeys);
    const oldMatched = new Array(oldU.length).fill(false);
    for (const j of aMatch)
      if (j >= 0)
        oldMatched[j] = true;
    const ops = [];
    const blobs = [];
    let blobN = 0;
    const addBlob = (payload) => {
      const id = `b${++blobN}`;
      blobs.push({ id, payload });
      return id;
    };
    const full = (lines, u) => lines.slice(u.start, u.endExcl).join("\n");
    for (let i = 0; i < newU.length; i++)
      if (aMatch[i] === -1)
        ops.push({ kind: "delete", key: newKeys[i] });
    for (let i = 0; i < newU.length; i++) {
      const j = aMatch[i];
      if (j >= 0 && full(newLines, newU[i].u) !== full(oldLines, oldU[j].u)) {
        ops.push({ kind: "replace", key: newKeys[i], blob: addBlob(full(oldLines, oldU[j].u)) });
      }
    }
    for (let j = 0; j < oldU.length; j++) {
      if (!oldMatched[j]) {
        const prev = j > 0 ? oldKeys[j - 1] : null;
        ops.push({ kind: "insert", blob: addBlob(full(oldLines, oldU[j].u)), anchor: prev ? { after: prev } : "at-start" });
      }
    }
    return { ops, blobs };
  }
  function opLine(op) {
    if (op.kind === "delete")
      return `delete ${op.key}`;
    if (op.kind === "replace")
      return `replace ${op.key} <- blob:${op.blob}`;
    if (op.kind === "insert")
      return `insert <- blob:${op.blob} ${anchorStr(op.anchor)}`;
    return `move ${op.key} ${anchorStr(op.anchor)}`;
  }
  function parseHistory(path) {
    const { lf, nl } = loadBytes(path);
    const lines = lf.split("\n");
    const blocks = locate(lines);
    const keyframes = /* @__PURE__ */ new Map();
    const revisions = /* @__PURE__ */ new Map();
    const blobs = /* @__PURE__ */ new Map();
    let current = "";
    for (const b of blocks) {
      const body = lines.slice(b.start + 1, b.end).join("\n");
      if (b.type === "meta") {
        const m = /^\s*current\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(body);
        if (m)
          current = m[1];
      } else if (b.type === "keyframe") {
        keyframes.set(attr(b.attrLine, "id"), body);
      } else if (b.type === "revision") {
        const id = attr(b.attrLine, "id");
        revisions.set(id, {
          id,
          parent: attr(b.attrLine, "parent"),
          author: attr(b.attrLine, "author"),
          summary: attr(b.attrLine, "summary"),
          hash: attr(b.attrLine, "hash") ?? "",
          ops: parseOps(body)
        });
      } else if (b.type === "blob") {
        blobs.set(b.id, body);
      }
    }
    return { nl, current, keyframes, revisions, blobs };
  }
  function chainFrom(h) {
    const out = [];
    let id = h.current;
    const seen = /* @__PURE__ */ new Set();
    while (id) {
      const r = h.revisions.get(id);
      if (!r)
        throw new Error(`history: revision ${id} missing (broken chain)`);
      if (seen.has(id))
        throw new Error(`history: cycle at ${id}`);
      seen.add(id);
      out.push(r);
      id = r.parent;
    }
    return out;
  }
  function reconstruct(h, targetId) {
    const chain = chainFrom(h);
    const t = chain.findIndex((r) => r.id === targetId);
    if (t < 0)
      throw new Error(`history: unknown revision ${targetId}`);
    let kf = -1;
    for (let i = t; i >= 0; i--)
      if (h.keyframes.has(chain[i].id)) {
        kf = i;
        break;
      }
    if (kf < 0)
      throw new Error(`history: no keyframe to reconstruct ${targetId}`);
    let text = h.keyframes.get(chain[kf].id);
    for (let i = kf; i < t; i++)
      text = applyReverse(text, chain[i].ops, h.blobs);
    return text;
  }
  function renderHistory(h, baseName) {
    const chain = chainFrom(h);
    const parts = [];
    parts.push(`# History of ${baseName}
`);
    parts.push(`=== meta
history-of        = "${baseName}"
geml-version      = "0.1"
current           = "${h.current}"
keyframe-interval = 10
===
`);
    const kfContent = h.keyframes.get(h.current);
    const kf = fenceFor(kfContent);
    parts.push(`# Committed-current mirror (always present):
${kf} keyframe {id="${h.current}" hash="${chain[0].hash}"}
${kfContent}
${kf}
`);
    for (const r of chain) {
      const at = [
        `id="${r.id}"`,
        r.parent ? `parent="${r.parent}"` : "",
        r.author ? `author="${r.author}"` : "",
        r.summary ? `summary="${r.summary}"` : "",
        `hash="${r.hash}"`
      ].filter(Boolean).join(" ");
      parts.push(`=== revision {${at}}
${r.ops.map(opLine).join("\n")}${r.ops.length ? "\n" : ""}===
`);
      for (const op of r.ops) {
        if (op.blob && h.blobs.has(op.blob)) {
          const payload = h.blobs.get(op.blob);
          const bf = fenceFor(payload);
          parts.push(`${bf} blob {#${op.blob} lang=geml}
${payload}
${bf}
`);
        }
      }
    }
    return parts.join("\n");
  }
  function commit(o) {
    const { lf: working, nl } = loadBytes(o.gemlPath);
    const hash = fullHash(working, nl);
    const stamp = stampUTC(o.at ?? /* @__PURE__ */ new Date());
    const id = makeId(stamp, hash);
    const baseName = o.gemlPath.replace(/^.*[\\/]/, "");
    let h;
    if (existsSync(o.historyPath)) {
      h = parseHistory(o.historyPath);
      const prevId = h.current;
      const prevContent = reconstruct(h, prevId);
      const patch = diffReverse(prevContent, working);
      const blobMap = new Map(patch.blobs.map((b) => [b.id, b.payload]));
      const back = applyReverse(working, patch.ops, blobMap);
      if (bytesOf(back, nl).compare(bytesOf(prevContent, nl)) !== 0) {
        throw new Error("history: reverse patch does NOT round-trip to the previous revision; aborting commit");
      }
      for (const b of patch.blobs)
        h.blobs.set(b.id, b.payload);
      h.revisions.set(id, { id, parent: prevId, author: o.author, summary: o.summary, hash, ops: patch.ops });
      h.keyframes.delete(prevId);
      h.keyframes.set(id, working);
      h.current = id;
    } else {
      h = {
        nl,
        current: id,
        keyframes: /* @__PURE__ */ new Map([[id, working]]),
        revisions: /* @__PURE__ */ new Map([[id, { id, author: o.author, summary: o.summary, hash, ops: [] }]]),
        blobs: /* @__PURE__ */ new Map()
      };
    }
    writeBytes(o.historyPath, renderHistory(h, baseName), nl);
    return { id, hash };
  }
  function verify(historyPath, gemlPath) {
    const errors = [];
    const warnings = [];
    const h = parseHistory(historyPath);
    let checked = 0;
    let chain = [];
    try {
      chain = chainFrom(h);
    } catch (e) {
      errors.push(String(e.message));
    }
    for (const r of chain) {
      try {
        const content = reconstruct(h, r.id);
        const got = fullHash(content, h.nl);
        if (got !== r.hash)
          errors.push(`revision ${r.id}: reconstructed hash ${got} != recorded ${r.hash}`);
        checked++;
      } catch (e) {
        errors.push(`revision ${r.id}: ${e.message}`);
      }
    }
    if (gemlPath && existsSync(gemlPath)) {
      const { lf, nl } = loadBytes(gemlPath);
      if (fullHash(lf, nl) !== (chain[0]?.hash ?? "")) {
        warnings.push("uncommitted changes: hash(doc.geml) differs from current");
      }
    }
    return { ok: errors.length === 0, errors, warnings, checked };
  }
  function restore(o) {
    const h = parseHistory(o.historyPath);
    const ids = [...h.revisions.keys()];
    const matches = ids.filter((x) => x === o.revision || x.startsWith(o.revision) || x.endsWith(o.revision));
    if (matches.length !== 1)
      throw new Error(`history: revision selector "${o.revision}" matched ${matches.length} revisions`);
    const target = matches[0];
    const content = reconstruct(h, target);
    if (o.write) {
      if (existsSync(o.gemlPath)) {
        const { lf, nl: nl2 } = loadBytes(o.gemlPath);
        if (fullHash(lf, nl2) !== h.revisions.get(h.current).hash && !o.force) {
          throw new Error("history: uncommitted changes in doc.geml; rerun with force to discard them, or commit first");
        }
      }
      const chain = chainFrom(h);
      const keep = /* @__PURE__ */ new Set();
      let id = target;
      while (id) {
        keep.add(id);
        id = h.revisions.get(id).parent;
      }
      for (const r of chain)
        if (!keep.has(r.id)) {
          h.revisions.delete(r.id);
          h.keyframes.delete(r.id);
        }
      h.keyframes.clear();
      h.keyframes.set(target, content);
      h.current = target;
      const { nl } = loadBytes(o.historyPath);
      writeBytes(o.gemlPath, content, nl);
      writeBytes(o.historyPath, renderHistory(h, o.gemlPath.replace(/^.*[\\/]/, "")), nl);
    }
    return content;
  }

  // ../geml-parser/dist/render.js
  var PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#ea580c"];
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;");
  }
  var RenderCtx = class {
    doc;
    usedMath = false;
    usedMermaid = false;
    labels = /* @__PURE__ */ new Map();
    // id -> link label for [[#id]] auto-refs
    constructor(doc) {
      this.doc = doc;
      this.indexLabels(doc.children);
    }
    // Build the id -> label map: a heading's text, or a block's caption, or its id.
    indexLabels(blocks) {
      for (const b of blocks) {
        if (b.kind === "heading")
          this.labels.set(b.id ?? "", b.text);
        else if (b.kind === "block") {
          if (b.id) {
            const cap = b.attrs["caption"];
            this.labels.set(b.id, typeof cap === "string" ? cap : b.table?.caption ?? b.id);
          }
          if (b.children)
            this.indexLabels(b.children);
        }
      }
    }
    docTitle() {
      for (const b of this.doc.children) {
        if (b.kind === "block" && b.type === "meta" && b.data && typeof b.data["title"] === "string") {
          return b.data["title"];
        }
      }
      for (const b of this.doc.children)
        if (b.kind === "heading")
          return b.text;
      return void 0;
    }
    // ----- inline -----
    inlines(ns) {
      return ns.map((n) => this.inline(n)).join("");
    }
    inline(n) {
      switch (n.type) {
        case "text":
          return esc(n.value);
        case "emph":
          return `<em>${this.inlines(n.children)}</em>`;
        case "strong":
          return `<strong>${this.inlines(n.children)}</strong>`;
        case "strike":
          return `<del>${this.inlines(n.children)}</del>`;
        case "code":
          return `<code>${esc(n.value)}</code>`;
        case "math":
          this.usedMath = true;
          return `<span class="math">\\(${esc(n.value)}\\)</span>`;
        case "break":
          return "<br>\n";
        case "image":
          return this.media(n);
        case "link":
          return this.link(n);
        case "autoref": {
          const href = n.doc ? `${n.doc.replace(/\.geml$/, ".html")}#${n.anchor}` : `#${n.anchor}`;
          const label = n.doc ? n.anchor ?? n.doc : this.labels.get(n.anchor) ?? n.anchor;
          return `<a href="${escAttr(href)}">${esc(label)}</a>`;
        }
        case "footnote":
          return `<sup class="fn"><a href="#${escAttr(n.ref)}">${esc(n.ref)}</a></sup>`;
      }
    }
    media(n) {
      const src = escAttr(n.src);
      if (n.as === "video")
        return `<video class="media" src="${src}" controls></video>`;
      if (n.as === "audio")
        return `<audio class="media" src="${src}" controls></audio>`;
      return `<img class="media" src="${src}" alt="${escAttr(n.alt)}">`;
    }
    link(n) {
      let href = "#";
      if (n.href)
        href = n.href;
      else if (n.doc)
        href = `${n.doc.replace(/\.geml$/, ".html")}${n.anchor ? "#" + n.anchor : ""}`;
      else if (n.anchor)
        href = `#${n.anchor}`;
      const rel = typeof n.attrs["rel"] === "string" ? ` rel="${escAttr(n.attrs["rel"])}"` : "";
      const target = typeof n.attrs["target"] === "string" ? ` target="${escAttr(n.attrs["target"])}"` : "";
      return `<a href="${escAttr(href)}"${rel}${target}>${this.inlines(n.children)}</a>`;
    }
    // ----- blocks -----
    block(b) {
      switch (b.kind) {
        case "hidden":
          return "";
        case "heading": {
          if (b.hidden)
            return "";
          const id = b.id ? ` id="${escAttr(b.id)}"` : "";
          const lvl = Math.min(6, Math.max(1, b.level));
          return `<h${lvl}${id}>${this.inlines(b.inlines)}</h${lvl}>`;
        }
        case "paragraph": {
          const html = this.inlines(b.inlines).trim();
          return html === "" ? "" : `<p>${html}</p>`;
        }
        case "list":
          return this.list(b);
        case "block":
          return this.typed(b);
      }
    }
    list(b) {
      const tag = b.ordered ? "ol" : "ul";
      const start = b.ordered && b.start !== void 0 && b.start !== 1 ? ` start="${b.start}"` : "";
      const isTask = b.items.some((it) => it.checked !== void 0);
      const items = b.items.map((it) => {
        let inner = this.inlines(it.inlines);
        if (b.loose)
          inner = `<p>${inner}</p>`;
        const box = it.checked === void 0 ? "" : `<input type="checkbox" disabled${it.checked ? " checked" : ""}> `;
        const kids = (it.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
        const cls = it.checked === void 0 ? "" : ' class="task"';
        return `  <li${cls}>${box}${inner}${kids ? "\n" + kids : ""}</li>`;
      }).join("\n");
      return `<${tag}${isTask ? ' class="task-list"' : ""}${start}>
${items}
</${tag}>`;
    }
    typed(b) {
      if (b.hidden)
        return "";
      const raw = (b.raw ?? []).join("\n");
      const caption = typeof b.attrs["caption"] === "string" ? b.attrs["caption"] : void 0;
      const idAttr = b.id ? ` id="${escAttr(b.id)}"` : "";
      switch (b.type) {
        case "meta":
          return "";
        // header metadata, not body content
        case "code": {
          const lang = typeof b.attrs["lang"] === "string" ? b.attrs["lang"] : "";
          const cls = lang ? ` class="language-${escAttr(lang)}"` : "";
          return `<pre${idAttr}><code${cls}>${esc(raw)}</code></pre>`;
        }
        case "output":
          return `<pre class="output"${idAttr}><code>${esc(raw)}</code></pre>`;
        case "math":
          this.usedMath = true;
          return `<div class="math-block"${idAttr}>\\[${esc(raw)}\\]</div>`;
        case "note":
        case "aside": {
          const classes = ["callout", b.type, ...b.classes].join(" ");
          const inner = (b.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
          return `<aside class="${classes}"${idAttr}>
${inner}
</aside>`;
        }
        case "table":
          return b.table ? this.table(b.table, b.id, caption) : `<p class="render-error">table failed to parse</p>`;
        case "diagram":
          return this.diagram(b, raw, caption);
        default: {
          return `<figure${idAttr}><pre class="diagram-src" data-type="${escAttr(b.type)}">${esc(raw)}</pre><figcaption>unknown block type <code>${esc(b.type)}</code>; shown as raw</figcaption></figure>`;
        }
      }
    }
    diagram(b, raw, caption) {
      const idAttr = b.id ? ` id="${escAttr(b.id)}"` : "";
      const fmt2 = typeof b.attrs["format"] === "string" ? b.attrs["format"] : "";
      const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
      if (fmt2 === "geml-chart") {
        if (b.chart)
          return `<figure class="chart"${idAttr}>${chartSvg(b.chart, caption)}${cap}</figure>`;
        return `<figure${idAttr}><p class="render-error">chart could not be built (see diagnostics)</p>${cap}</figure>`;
      }
      if (fmt2 === "mermaid") {
        this.usedMermaid = true;
        return `<figure${idAttr}><pre class="mermaid">${esc(raw)}</pre>${cap}</figure>`;
      }
      return `<figure${idAttr}><pre class="diagram-src" data-format="${escAttr(fmt2)}">${esc(raw)}</pre><figcaption>${caption ? esc(caption) + " \u2014 " : ""}<code>${esc(fmt2 || "diagram")}</code> (no bundled renderer in this build)</figcaption></figure>`;
    }
    table(t, id, caption) {
      const idAttr = id ? ` id="${escAttr(id)}"` : "";
      const alignStyle = (a) => a ? ` style="text-align:${a}"` : "";
      const covered = t.rows.map((r) => r.map(() => false));
      t.rows.forEach((row, r) => row.forEach((cell, c) => {
        if (!cell.span)
          return;
        for (let dr = 0; dr < cell.span.rows; dr++)
          for (let dc = 0; dc < cell.span.cols; dc++) {
            if (dr === 0 && dc === 0)
              continue;
            const rr = r + dr, cc = c + dc;
            if (covered[rr]?.[cc] !== void 0)
              covered[rr][cc] = true;
          }
      }));
      const thead = t.header ? `<thead><tr>${t.columns.map((col, c) => `<th${alignStyle(t.align[c])}>${esc(col)}</th>`).join("")}</tr></thead>` : "";
      const bodyRows = t.rows.map((row, r) => {
        const cells = row.map((cell, c) => {
          if (covered[r]?.[c])
            return "";
          const span = cell.span ? `${cell.span.rows > 1 ? ` rowspan="${cell.span.rows}"` : ""}${cell.span.cols > 1 ? ` colspan="${cell.span.cols}"` : ""}` : "";
          const cls = cell.computed ? ' class="computed"' : "";
          const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
          return `<td${alignStyle(cell.align ?? t.align[c])}${span}${cls}${sortVal}>${this.inlines(cell.inlines)}</td>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      }).join("\n");
      const tfoot = t.summary ? `<tfoot><tr>${t.summary.map((cell, c) => {
        const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
        return `<td${alignStyle(cell.align ?? t.align[c])}${sortVal}>${this.inlines(cell.inlines)}</td>`;
      }).join("")}</tr></tfoot>` : "";
      const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
      const tools = `<div class="table-tools"><input class="table-filter" type="search" placeholder="Filter rows\u2026" aria-label="Filter table rows"></div>`;
      return `<figure class="table-figure"${idAttr}>${tools}<table class="geml-table">${thead}<tbody>
${bodyRows}
</tbody>${tfoot}</table>${cap}</figure>`;
    }
  };
  function niceMax(v) {
    if (v <= 0)
      return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / pow;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nice * pow;
  }
  function chartSvg(m, title) {
    if (m.type === "pie")
      return pieSvg(m, title);
    if (m.type === "scatter")
      return scatterSvg(m, title);
    return cartesianSvg(m, title);
  }
  function svgFrame(title, W2, H2, body) {
    const t = title ? `<text x="${W2 / 2}" y="22" text-anchor="middle" class="c-title">${esc(title)}</text>` : "";
    return `<svg viewBox="0 0 ${W2} ${H2}" class="geml-chart" role="img" aria-label="${escAttr(title ?? "chart")}">${t}${body}</svg>`;
  }
  function legend(names, x, y) {
    return names.map((n, i) => {
      const yy = y + i * 18;
      return `<rect x="${x}" y="${yy}" width="11" height="11" rx="2" fill="${PALETTE[i % PALETTE.length]}"></rect><text x="${x + 16}" y="${yy + 10}" class="c-legend">${esc(n)}</text>`;
    }).join("");
  }
  function cartesianSvg(m, title) {
    const W2 = 760, H2 = 380;
    const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
    const pw = W2 - left - right, ph = H2 - top - bottom;
    const cats = m.dataset.categories;
    const series = m.y;
    const vals = series.map((s) => m.dataset.numbers[s] ?? []);
    const flat = vals.flat();
    const dataMax = Math.max(0, ...flat);
    const dataMin = Math.min(0, ...flat);
    const yMax = niceMax(dataMax);
    const yMin = dataMin < 0 ? -niceMax(-dataMin) : 0;
    const range = yMax - yMin || 1;
    const yOf = (v) => top + ph * (1 - (v - yMin) / range);
    const n = Math.max(1, cats.length);
    const band = pw / n;
    const cx = (i) => left + band * (i + 0.5);
    const ticks = 5;
    let grid = "";
    for (let i = 0; i <= ticks; i++) {
      const v = yMin + range * i / ticks;
      const y = yOf(v);
      grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
      grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
    }
    let xlab = "";
    cats.forEach((c, i) => {
      xlab += `<text x="${cx(i)}" y="${top + ph + 18}" text-anchor="middle" class="c-tick">${esc(trunc(c, 12))}</text>`;
    });
    let marks = "";
    if (m.type === "bar") {
      const groupW = band * 0.8;
      const bw = groupW / series.length;
      series.forEach((s, si) => {
        (m.dataset.numbers[s] ?? []).forEach((v, i) => {
          const x = cx(i) - groupW / 2 + si * bw;
          const y0 = yOf(0), y1 = yOf(v);
          const y = Math.min(y0, y1), h = Math.abs(y1 - y0);
          marks += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${h.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(s)} \xB7 ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></rect>`;
        });
      });
    } else {
      series.forEach((s, si) => {
        const color = PALETTE[si % PALETTE.length];
        const pts = (m.dataset.numbers[s] ?? []).map((v, i) => `${cx(i).toFixed(1)},${yOf(v).toFixed(1)}`);
        if (pts.length === 0)
          return;
        if (m.type === "area") {
          const base = yOf(Math.max(yMin, 0));
          marks += `<polygon points="${cx(0).toFixed(1)},${base} ${pts.join(" ")} ${cx(cats.length - 1).toFixed(1)},${base}" fill="${color}" fill-opacity="0.18"></polygon>`;
        }
        marks += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"></polyline>`;
        (m.dataset.numbers[s] ?? []).forEach((v, i) => {
          marks += `<circle cx="${cx(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(s)} \xB7 ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></circle>`;
        });
      });
    }
    const axis = `<line x1="${left}" y1="${yOf(Math.max(yMin, 0))}" x2="${left + pw}" y2="${yOf(Math.max(yMin, 0))}" class="c-axis"></line>`;
    const leg = series.length > 1 ? legend(series, left + 8, top + 4) : "";
    return svgFrame(title, W2, H2, grid + axis + marks + xlab + leg);
  }
  function pieSvg(m, title) {
    const W2 = 760, H2 = 380, top = title ? 40 : 22;
    const cx = 250, cy = top + (H2 - top) / 2, r = Math.min(140, (H2 - top) / 2 - 16);
    const col = m.y[0];
    const data = m.dataset.numbers[col] ?? [];
    const total = data.reduce((a, b) => a + b, 0) || 1;
    let a0 = -Math.PI / 2;
    let slices = "";
    data.forEach((v, i) => {
      const a1 = a0 + v / total * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      slices += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}"><title>${esc(m.dataset.categories[i] ?? "")}: ${fmtNum(v)} (${(v / total * 100).toFixed(1)}%)</title></path>`;
      a0 = a1;
    });
    const leg = legend(m.dataset.categories, 470, top + 16);
    return svgFrame(title, W2, H2, slices + leg);
  }
  function scatterSvg(m, title) {
    const W2 = 760, H2 = 380;
    const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
    const pw = W2 - left - right, ph = H2 - top - bottom;
    const yCol = m.y[0];
    const ys = m.dataset.numbers[yCol] ?? [];
    const xs = m.dataset.categories.map((c, i) => {
      const v = parseFloat(c);
      return Number.isFinite(v) ? v : i;
    });
    const sizes = m.size ? m.dataset.numbers[m.size] ?? [] : [];
    const xMax = niceMax(Math.max(1, ...xs)), xMin = Math.min(0, ...xs);
    const yMax = niceMax(Math.max(1, ...ys)), yMin = Math.min(0, ...ys);
    const xr = xMax - xMin || 1, yr = yMax - yMin || 1;
    const xOf = (v) => left + pw * ((v - xMin) / xr);
    const yOf = (v) => top + ph * (1 - (v - yMin) / yr);
    const sMax = Math.max(1, ...sizes);
    const rOf = (i) => m.size ? 4 + 14 * Math.sqrt((sizes[i] ?? 0) / sMax) : 5;
    let grid = "";
    for (let i = 0; i <= 5; i++) {
      const v = yMin + yr * i / 5, y = yOf(v);
      grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
      grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
    }
    let pts = "";
    ys.forEach((v, i) => {
      pts += `<circle cx="${xOf(xs[i] ?? 0).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${rOf(i).toFixed(1)}" fill="${PALETTE[0]}" fill-opacity="0.7"><title>${esc(m.dataset.categories[i] ?? "")}: (${fmtNum(xs[i] ?? 0)}, ${fmtNum(v)})</title></circle>`;
    });
    const axis = `<line x1="${left}" y1="${top + ph}" x2="${left + pw}" y2="${top + ph}" class="c-axis"></line>`;
    return svgFrame(title, W2, H2, grid + axis + pts);
  }
  function fmtNum(v) {
    if (Math.abs(v) >= 1e3)
      return v.toLocaleString("en-US");
    return String(parseFloat(v.toPrecision(4)));
  }
  function trunc(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  }
  var CSS = `
:root { --fg:#1f2328; --muted:#656d76; --bd:#d0d7de; --bg:#fff; --accent:#2563eb; --code-bg:#f6f8fa; }
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:#fafbfc; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft Yahei",sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; background:var(--bg); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.6em 0 .6em; scroll-margin-top:16px; }
h1 { font-size:2em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h3 { font-size:1.25em; } h4 { font-size:1em; }
p { margin:.7em 0; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
code { background:var(--code-bg); padding:.15em .35em; border-radius:6px; font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow:auto; }
pre code { background:none; padding:0; font-size:.85em; }
pre.output { background:#0d1117; color:#e6edf3; }
pre.output code { color:inherit; }
ul,ol { padding-left:1.6em; } li { margin:.2em 0; }
ul.task-list { list-style:none; padding-left:.2em; } li.task input { margin-right:.5em; }
aside.callout { border-left:4px solid var(--accent); background:#f0f6ff; padding:.4em 16px; border-radius:0 8px 8px 0; margin:1em 0; }
aside.aside { border-left-color:#8b949e; background:#f6f8fa; }
aside.warning { border-left-color:#d97706; background:#fff8f0; }
aside.callout > :first-child { margin-top:0; } aside.callout > :last-child { margin-bottom:0; }
figure { margin:1.2em 0; }
figcaption { color:var(--muted); font-size:.86em; text-align:center; margin-top:.5em; }
table.geml-table { border-collapse:collapse; width:100%; font-size:.92em; }
table.geml-table th, table.geml-table td { border:1px solid var(--bd); padding:6px 12px; }
table.geml-table thead th { background:var(--code-bg); cursor:pointer; user-select:none; white-space:nowrap; }
table.geml-table thead th::after { content:" \\2195"; color:var(--muted); font-size:.8em; }
table.geml-table thead th.asc::after { content:" \\2191"; color:var(--accent); }
table.geml-table thead th.desc::after { content:" \\2193"; color:var(--accent); }
table.geml-table tbody tr:nth-child(2n) { background:#fafbfc; }
table.geml-table td.computed { color:#0a7c52; }
table.geml-table tfoot td { background:var(--code-bg); font-weight:600; border-top:2px solid var(--bd); }
.table-tools { margin-bottom:6px; } .table-filter { width:240px; max-width:100%; padding:5px 9px; border:1px solid var(--bd); border-radius:7px; font-size:.85em; }
.geml-chart { width:100%; height:auto; background:var(--bg); border:1px solid var(--bd); border-radius:8px; }
.c-title { font-size:15px; font-weight:600; fill:var(--fg); }
.c-grid { stroke:#eaecef; } .c-axis { stroke:#aab1b8; } .c-tick { font-size:11px; fill:var(--muted); } .c-legend { font-size:12px; fill:var(--fg); }
.media { max-width:100%; border-radius:8px; }
.diagram-src { color:var(--muted); } .render-error { color:#cf222e; }
.math-block { overflow-x:auto; padding:.4em 0; }
sup.fn a { font-size:.75em; }
.geml-footer { max-width:860px; margin:0 auto; padding:16px 24px 40px; color:var(--muted); font-size:.82em; }
.geml-footer code { font-size:.95em; }
`;
  var JS = `
(function () {
  function cmp(a, b) {
    var na = a.dataset.sort, nb = b.dataset.sort;
    if (na !== undefined && nb !== undefined) return parseFloat(na) - parseFloat(nb);
    return (a.textContent || "").localeCompare(b.textContent || "");
  }
  document.querySelectorAll("table.geml-table").forEach(function (table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    // Sort on header click.
    var ths = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(ths, function (th, col) {
      th.addEventListener("click", function () {
        var dir = th.classList.contains("asc") ? "desc" : "asc";
        Array.prototype.forEach.call(ths, function (h) { h.classList.remove("asc", "desc"); });
        th.classList.add(dir);
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (r1, r2) {
          var c = cmp(r1.cells[col], r2.cells[col]);
          return dir === "asc" ? c : -c;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
    // Filter rows.
    var fig = table.closest(".table-figure");
    var input = fig ? fig.querySelector(".table-filter") : null;
    if (input) input.addEventListener("input", function () {
      var q = input.value.toLowerCase();
      Array.prototype.forEach.call(tbody.rows, function (r) {
        r.style.display = (r.textContent || "").toLowerCase().indexOf(q) >= 0 ? "" : "none";
      });
    });
  });
})();
`;
  function page(title, body, ctx, source) {
    const mathHead = ctx.usedMath ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"><\/script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false}]})"><\/script>
` : "";
    const mermaidHead = ctx.usedMermaid ? `<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true});<\/script>
` : "";
    const footer = source ? `<footer class="geml-footer">Rendered from <code>${esc(source)}</code> by the GEML runtime. Tables are sortable and filterable; the chart is inline SVG drawn from its bound table.</footer>` : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
${mathHead}${mermaidHead}</head>
<body>
<main>
${body}
</main>
${footer}
<script>${JS}<\/script>
</body>
</html>
`;
  }
  function renderHtml(doc, opts = {}) {
    const ctx = new RenderCtx(doc);
    const body = doc.children.map((b) => ctx.block(b)).filter((s) => s !== "").join("\n");
    const title = opts.title ?? ctx.docTitle() ?? "GEML document";
    return page(title, body, ctx, opts.source);
  }

  // ../geml-parser/dist/attrs.js
  function coerce(raw) {
    const t = raw.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      return t.slice(1, -1);
    }
    if (t === "true")
      return true;
    if (t === "false")
      return false;
    if (/^[+-]?\d+$/.test(t))
      return parseInt(t, 10);
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t))
      return parseFloat(t);
    return t;
  }
  function tokenize(s) {
    const out = [];
    let cur = "";
    let inQuote = false;
    for (const ch of s) {
      if (ch === '"') {
        inQuote = !inQuote;
        cur += ch;
      } else if (!inQuote && /\s/.test(ch)) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
      } else {
        cur += ch;
      }
    }
    if (cur)
      out.push(cur);
    return out;
  }
  function parseAttrs(src) {
    const inner = src.trim().replace(/^\{/, "").replace(/\}$/, "");
    const out = { classes: [], attrs: {} };
    for (const tok of tokenize(inner)) {
      if (tok.startsWith("#")) {
        out.id = tok.slice(1);
      } else if (tok.startsWith(".")) {
        out.classes.push(tok.slice(1));
      } else {
        const eq = tok.indexOf("=");
        if (eq > 0)
          out.attrs[tok.slice(0, eq)] = coerce(tok.slice(eq + 1));
        else
          out.attrs[tok] = true;
      }
    }
    return out;
  }

  // ../geml-parser/dist/inline.js
  var SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  var VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|mkv)(?:[?#].*)?$/i;
  var AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)(?:[?#].*)?$/i;
  var IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)(?:[?#].*)?$/i;
  function inferAs(src) {
    if (VIDEO_EXT.test(src))
      return "video";
    if (AUDIO_EXT.test(src))
      return "audio";
    if (IMAGE_EXT.test(src))
      return "image";
    return void 0;
  }
  function classifyDest(dest) {
    const d = dest.trim();
    if (SCHEME.test(d))
      return { href: d };
    const hash = d.indexOf("#");
    if (hash === 0)
      return { anchor: d.slice(1) };
    if (hash > 0)
      return { doc: d.slice(0, hash), anchor: d.slice(hash + 1) };
    if (d)
      return { doc: d };
    return {};
  }
  function readParen(s, i) {
    if (s[i] !== "(")
      return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === "(")
        depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0)
          return { content: s.slice(i + 1, j), end: j + 1 };
      }
    }
    return null;
  }
  function readBracket(s, i) {
    if (s[i] !== "[")
      return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === "[")
        depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0)
          return { content: s.slice(i + 1, j), end: j + 1 };
      }
    }
    return null;
  }
  function readAttrs(s, i) {
    if (s[i] !== "{")
      return null;
    const close = s.indexOf("}", i);
    if (close < 0)
      return null;
    return { attrs: parseAttrs(s.slice(i, close + 1)), end: close + 1 };
  }
  function scanAtoms(s, line, sink) {
    const out = [];
    let buf = "";
    const flush = () => {
      if (buf) {
        out.push(buf);
        buf = "";
      }
    };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        const next = s[i + 1];
        if (next === void 0 || next === "\n") {
          flush();
          out.push({ type: "break" });
          i += next === void 0 ? 1 : 2;
          continue;
        }
        if (/[!-/:-@[-`{-~]/.test(next)) {
          flush();
          out.push({ type: "text", value: next });
          i += 2;
          continue;
        }
        buf += c;
        i++;
        continue;
      }
      if (c === "`") {
        let n = 0;
        while (s[i + n] === "`")
          n++;
        const fence2 = "`".repeat(n);
        const close = s.indexOf(fence2, i + n);
        if (close >= 0) {
          flush();
          out.push({ type: "code", value: s.slice(i + n, close) });
          i = close + n;
          continue;
        }
        buf += fence2;
        i += n;
        continue;
      }
      if (c === "$") {
        const close = s.indexOf("$", i + 1);
        if (close > i + 1) {
          flush();
          out.push({ type: "math", value: s.slice(i + 1, close) });
          i = close + 1;
          continue;
        }
        buf += c;
        i++;
        continue;
      }
      if (c === "!" && s[i + 1] === "[") {
        const label = readBracket(s, i + 1);
        const paren = label ? readParen(s, label.end) : null;
        if (label && paren) {
          const a = readAttrs(s, paren.end);
          const attrObj = a ? a.attrs : { classes: [], attrs: {} };
          const node = {
            type: "image",
            alt: label.content,
            src: paren.content.trim(),
            attrs: attrObj.attrs
          };
          const as = attrObj.attrs["as"];
          if (typeof as === "string")
            node.as = as;
          else {
            const inf = inferAs(node.src);
            if (inf)
              node.as = inf;
          }
          flush();
          out.push(node);
          i = a ? a.end : paren.end;
          continue;
        }
      }
      if (c === "[" && s[i + 1] === "[") {
        const inner = readBracket(s, i + 1);
        if (inner && s[inner.end] === "]") {
          const target = inner.content.trim();
          const { doc, anchor } = classifyDest(target);
          if (anchor) {
            flush();
            const node = { type: "autoref", anchor };
            if (doc)
              node.doc = doc;
            out.push(node);
            sink.refs.push({ kind: doc ? "cross" : "autoref", doc, anchor, line });
            i = inner.end + 1;
            continue;
          }
        }
      }
      if (c === "[" && s[i + 1] === "^") {
        const br = readBracket(s, i);
        if (br && br.content.startsWith("^")) {
          const ref = br.content.slice(1).trim();
          flush();
          out.push({ type: "footnote", ref });
          sink.refs.push({ kind: "footnote", anchor: ref, line });
          i = br.end;
          continue;
        }
      }
      if (c === "[") {
        const label = readBracket(s, i);
        const paren = label ? readParen(s, label.end) : null;
        if (label && paren) {
          const a = readAttrs(s, paren.end);
          const attrObj = a ? a.attrs : { classes: [], attrs: {} };
          const dest = classifyDest(paren.content);
          const node = {
            type: "link",
            children: parseInline(label.content, line, sink),
            attrs: attrObj.attrs
          };
          if (dest.href)
            node.href = dest.href;
          if (dest.doc)
            node.doc = dest.doc;
          if (dest.anchor)
            node.anchor = dest.anchor;
          if (dest.anchor || dest.doc) {
            sink.refs.push({ kind: dest.doc ? "cross" : "internal", doc: dest.doc, anchor: dest.anchor, line });
          }
          flush();
          out.push(node);
          i = a ? a.end : paren.end;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }
  var ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
  var isPunct = (c) => c !== void 0 && ASCII_PUNCT.test(c);
  var isWS = (c) => c === void 0 || /\s/.test(c);
  function flank(before, after) {
    const bWS = isWS(before), aWS = isWS(after), bP = isPunct(before), aP = isPunct(after);
    return { open: !aWS && (!aP || bWS || bP), close: !bWS && (!bP || aWS || aP) };
  }
  function tokenizeRuns(s) {
    let head = null, tail = null;
    const push = (node) => {
      node.prev = tail;
      if (tail)
        tail.next = node;
      else
        head = node;
      tail = node;
    };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "*" || c === "~") {
        let j = i;
        while (s[j] === c)
          j++;
        const n = j - i;
        if (c === "~" && n < 2)
          push({ t: "text", v: "~", prev: null, next: null });
        else {
          const f = flank(i > 0 ? s[i - 1] : void 0, j < s.length ? s[j] : void 0);
          push({ t: "delim", ch: c, n, open: f.open, close: f.close, prev: null, next: null });
        }
        i = j;
      } else {
        let j = i;
        while (j < s.length && s[j] !== "*" && s[j] !== "~")
          j++;
        push({ t: "text", v: s.slice(i, j), prev: null, next: null });
        i = j;
      }
    }
    return head;
  }
  var nextDelim = (n) => {
    for (; n; n = n.next)
      if (n.t === "delim")
        return n;
    return null;
  };
  var prevDelim = (n) => {
    for (; n; n = n.prev)
      if (n.t === "delim")
        return n;
    return null;
  };
  function rule3(o, c) {
    if (o.close || c.open)
      return (o.n + c.n) % 3 !== 0 || o.n % 3 === 0 && c.n % 3 === 0;
    return true;
  }
  function unlink(node, head) {
    if (node.prev)
      node.prev.next = node.next;
    else
      head = node.next;
    if (node.next)
      node.next.prev = node.prev;
    return head;
  }
  function processEmphasis(head) {
    const bottom = /* @__PURE__ */ new Map();
    let closer = nextDelim(head);
    while (closer) {
      if (closer.t !== "delim" || !closer.close) {
        closer = nextDelim(closer.next);
        continue;
      }
      const ch = closer.ch;
      const key = `${ch}${closer.open ? 1 : 0}${closer.n % 3}`;
      const stop = bottom.has(key) ? bottom.get(key) : null;
      let opener = prevDelim(closer.prev);
      let found = null;
      while (opener && opener !== stop) {
        if (opener.t === "delim" && opener.open && opener.ch === ch && rule3(opener, closer)) {
          found = opener;
          break;
        }
        opener = prevDelim(opener.prev);
      }
      if (found) {
        const use = ch === "~" ? 2 : found.n >= 2 && closer.n >= 2 ? 2 : 1;
        const kind = ch === "~" ? "strike" : use === 2 ? "strong" : "emph";
        let kidsHead = null, kidsTail = null;
        for (let p = found.next; p && p !== closer; ) {
          const q = p.next;
          p.prev = kidsTail;
          p.next = null;
          if (kidsTail)
            kidsTail.next = p;
          else
            kidsHead = p;
          kidsTail = p;
          p = q;
        }
        const wrap = { t: "wrap", kind, kids: kidsHead, prev: found, next: closer };
        found.next = wrap;
        closer.prev = wrap;
        found.n -= use;
        closer.n -= use;
        if (found.n === 0)
          head = unlink(found, head);
        if (closer.n === 0) {
          const after = closer.next;
          head = unlink(closer, head);
          closer = nextDelim(after);
        }
      } else {
        bottom.set(key, closer.prev);
        closer = nextDelim(closer.next);
      }
    }
    return head;
  }
  function finalize(head) {
    const out = [];
    const pushText = (v) => {
      const last = out[out.length - 1];
      if (last && last.type === "text")
        last.value += v;
      else if (v)
        out.push({ type: "text", value: v });
    };
    for (let n = head; n; n = n.next) {
      if (n.t === "text")
        pushText(n.v);
      else if (n.t === "delim")
        pushText(n.ch.repeat(n.n));
      else
        out.push({ type: n.kind, children: finalize(n.kids) });
    }
    return out;
  }
  function emphasize(text) {
    const head = tokenizeRuns(text);
    return head ? finalize(processEmphasis(head)) : [];
  }
  function mergeText(ns) {
    const out = [];
    for (const n of ns) {
      const last = out[out.length - 1];
      if (n.type === "text" && last && last.type === "text")
        last.value += n.value;
      else
        out.push(n);
    }
    return out;
  }
  function parseInline(s, line, sink) {
    const atoms = scanAtoms(s, line, sink);
    const out = [];
    for (const a of atoms) {
      if (typeof a === "string")
        out.push(...emphasize(a));
      else
        out.push(a);
    }
    return mergeText(out);
  }

  // ../geml-parser/dist/table.js
  var SEP_CELL = /^:?-+:?$/;
  function alignOf(sep2) {
    const l = sep2.startsWith(":");
    const r = sep2.endsWith(":");
    if (l && r)
      return "center";
    if (r)
      return "right";
    if (l)
      return "left";
    return void 0;
  }
  function splitPipes(line) {
    let s = line.trim();
    if (s.startsWith("|"))
      s = s.slice(1);
    if (s.endsWith("|"))
      s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }
  function parseVisual(body) {
    const rows = body.filter((l) => l.trim() !== "").map(splitPipes);
    let sepIdx = -1;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].length > 0 && rows[r].every((c) => SEP_CELL.test(c))) {
        sepIdx = r;
        break;
      }
    }
    if (sepIdx >= 0) {
      const headerRow = sepIdx > 0 ? rows[sepIdx - 1] : [];
      const align = rows[sepIdx].map(alignOf);
      const cells = rows.slice(sepIdx + 1);
      const columns = headerRow.length ? headerRow : letters(cells[0]?.length ?? align.length);
      return { columns, align, header: headerRow.length > 0, cells };
    }
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return { columns: letters(width), align: [], header: false, cells: rows };
  }
  function parseDelimited(body, sep2, header) {
    const rows = body.filter((l) => l.trim() !== "").map((l) => l.split(sep2).map((c) => c.trim()));
    if (header && rows.length) {
      return { columns: rows[0], align: [], header: true, cells: rows.slice(1) };
    }
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return { columns: letters(width), align: [], header: false, cells: rows };
  }
  function letters(n) {
    const out = [];
    for (let i = 0; i < n; i++)
      out.push(String.fromCharCode(65 + i));
    return out;
  }
  var AGGS = /* @__PURE__ */ new Set(["sum", "avg", "min", "max", "count"]);
  function lexExpr(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if ("+-*/".includes(c)) {
        out.push({ t: "op", v: c });
        i++;
        continue;
      }
      if (c === "(") {
        out.push({ t: "lp", v: c });
        i++;
        continue;
      }
      if (c === ")") {
        out.push({ t: "rp", v: c });
        i++;
        continue;
      }
      if (c === ",") {
        out.push({ t: "comma", v: c });
        i++;
        continue;
      }
      if (/[0-9.]/.test(c)) {
        let j2 = i;
        while (j2 < s.length && /[0-9.]/.test(s[j2]))
          j2++;
        out.push({ t: "num", v: s.slice(i, j2) });
        i = j2;
        continue;
      }
      if (c === "'") {
        let j2 = i + 1;
        while (j2 < s.length && s[j2] !== "'")
          j2++;
        out.push({ t: "name", v: s.slice(i + 1, j2) });
        i = j2 + 1;
        continue;
      }
      let j = i;
      while (j < s.length && !/[\s+\-*/(),]/.test(s[j]))
        j++;
      out.push({ t: "name", v: s.slice(i, j) });
      i = j;
    }
    return out;
  }
  function splitName(lhs) {
    const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(lhs.trim());
    let name = (m ? m[1] : lhs).trim();
    if (name.startsWith('"') && name.endsWith('"'))
      name = name.slice(1, -1);
    return m ? { name, fmt: m[2] } : { name };
  }
  function defaultNum(v) {
    return String(parseFloat(v.toPrecision(12)));
  }
  function applyFormat(fmt2, v) {
    return fmt2.replace(/%%|%[-+ 0]*\d*(?:\.\d+)?[fFeEgGd]/g, (m) => {
      if (m === "%%")
        return "%";
      const mm = /^%[-+ 0]*\d*(?:\.(\d+))?([fFeEgGd])$/.exec(m);
      if (!mm)
        return m;
      const prec = mm[1] !== void 0 ? parseInt(mm[1], 10) : void 0;
      const type = mm[2];
      if (type === "d")
        return String(Math.round(v));
      if (type === "e" || type === "E")
        return v.toExponential(prec);
      if (type === "g" || type === "G")
        return String(v);
      return v.toFixed(prec ?? 6);
    });
  }
  function evalExpr(toks, row, col, agg) {
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    function parseExpr() {
      let v2 = parseTerm();
      while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
        const op = next().v;
        const r = parseTerm();
        v2 = op === "+" ? v2 + r : v2 - r;
      }
      return v2;
    }
    function parseTerm() {
      let v2 = parseFactor();
      while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
        const op = next().v;
        const r = parseFactor();
        v2 = op === "*" ? v2 * r : v2 / r;
      }
      return v2;
    }
    function parseFactor() {
      const tk = peek();
      if (!tk)
        throw new Error("unexpected end of formula");
      if (tk.t === "op" && tk.v === "-") {
        next();
        return -parseFactor();
      }
      if (tk.t === "lp") {
        next();
        const v2 = parseExpr();
        if (peek()?.t !== "rp")
          throw new Error("missing )");
        next();
        return v2;
      }
      if (tk.t === "num") {
        next();
        return parseFloat(tk.v);
      }
      if (tk.t === "name") {
        next();
        if (peek()?.t === "lp" && AGGS.has(tk.v.toLowerCase())) {
          next();
          const arg = peek();
          if (arg?.t !== "name")
            throw new Error(`bad argument to ${tk.v}()`);
          next();
          if (peek()?.t !== "rp")
            throw new Error("missing )");
          next();
          const a = agg(tk.v.toLowerCase(), arg.v);
          if (a === null)
            throw new Error(`unknown column \`${arg.v}\``);
          return a;
        }
        const cv = col(tk.v, row);
        if (cv === null)
          throw new Error(`unknown column \`${tk.v}\``);
        return cv;
      }
      throw new Error(`unexpected token \`${tk.v}\``);
    }
    const v = parseExpr();
    if (p !== toks.length)
      throw new Error("trailing tokens in formula");
    return v;
  }
  function parseSpan(s) {
    const m = /^r(\d+)c(\d+):(\d+)x(\d+)$/.exec(s.trim());
    if (!m)
      return null;
    return { row: +m[1], col: +m[2], rows: +m[3], cols: +m[4] };
  }
  function parseTable(body, attrs, line, sink) {
    const diagnostics = [];
    const fmt2 = typeof attrs["format"] === "string" ? attrs["format"] : void 0;
    const src = typeof attrs["src"] === "string" ? attrs["src"] : void 0;
    if (src !== void 0) {
      if (body.some((l) => l.trim() !== "")) {
        diagnostics.push({ severity: "error", message: "table has both `src` and an inline body; provide one, not both" });
      }
      const headerAttr = attrs["header"];
      const header = headerAttr === void 0 ? true : headerAttr === true || headerAttr === 1 || headerAttr === "1";
      const model2 = { header, columns: [], align: [], rows: [], src };
      const caption2 = attrs["caption"];
      if (typeof caption2 === "string")
        model2.caption = caption2;
      return { model: model2, diagnostics };
    }
    let raw;
    if (fmt2 === "csv" || fmt2 === "tsv") {
      const headerAttr = attrs["header"];
      const header = headerAttr === void 0 ? true : headerAttr === true || headerAttr === 1 || headerAttr === "1";
      raw = parseDelimited(body, fmt2 === "tsv" ? "	" : ",", header);
    } else {
      if (fmt2 !== void 0)
        diagnostics.push({ severity: "warning", message: `unknown table format \`${fmt2}\`; parsed as visual grid` });
      raw = parseVisual(body);
    }
    const columns = [...raw.columns];
    const model = { header: raw.header, columns, align: raw.align, rows: [] };
    const caption = attrs["caption"];
    if (typeof caption === "string")
      model.caption = caption;
    for (const r of raw.cells) {
      const row = [];
      for (let c = 0; c < columns.length; c++) {
        const text = r[c] ?? "";
        const cell = { text, inlines: parseInline(text, line, sink) };
        const align = raw.align[c];
        if (align)
          cell.align = align;
        const v = coerce(text);
        if (typeof v === "number")
          cell.value = v;
        row.push(cell);
      }
      model.rows.push(row);
    }
    const colIndex = (name) => {
      const byName = columns.indexOf(name);
      if (byName >= 0)
        return byName;
      if (/^[A-Z]$/.test(name))
        return name.charCodeAt(0) - 65;
      return -1;
    };
    const cellNum = (ci, row) => {
      const v = model.rows[row]?.[ci]?.value;
      return typeof v === "number" ? v : null;
    };
    const colResolve = (name, row) => {
      const ci = colIndex(name);
      return ci < 0 ? null : cellNum(ci, row);
    };
    const aggResolve = (fn, name) => {
      const ci = colIndex(name);
      if (ci < 0)
        return null;
      const vals = [];
      for (let r = 0; r < model.rows.length; r++) {
        const v = cellNum(ci, r);
        if (v !== null)
          vals.push(v);
      }
      if (fn === "count")
        return vals.length;
      if (vals.length === 0)
        return 0;
      if (fn === "sum")
        return vals.reduce((a, b) => a + b, 0);
      if (fn === "avg")
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      if (fn === "min")
        return Math.min(...vals);
      if (fn === "max")
        return Math.max(...vals);
      return null;
    };
    const formulas = Object.entries(attrs).filter(([k]) => k === "compute" || /^compute\d+$/.test(k)).map(([, v]) => v).filter((v) => typeof v === "string").flatMap((v) => v.split(";")).map((f) => f.trim()).filter((f) => f !== "");
    for (const f of formulas) {
      const eq = f.indexOf("=");
      if (eq <= 0) {
        diagnostics.push({ severity: "error", message: `bad compute formula \`${f}\` (want \`Name = expr\`)` });
        continue;
      }
      const { name, fmt: fmt3 } = splitName(f.slice(0, eq));
      const expr = f.slice(eq + 1).trim();
      let toks;
      try {
        toks = lexExpr(expr);
      } catch {
        diagnostics.push({ severity: "error", message: `cannot lex formula \`${f}\`` });
        continue;
      }
      let ci = columns.indexOf(name);
      if (ci < 0) {
        columns.push(name);
        ci = columns.length - 1;
      }
      let failed = false;
      for (let r = 0; r < model.rows.length && !failed; r++) {
        try {
          const v = evalExpr(toks, r, colResolve, aggResolve);
          const cell = ensureCell(model.rows[r], ci);
          if (Number.isFinite(v)) {
            const text = fmt3 ? applyFormat(fmt3, v) : defaultNum(v);
            cell.value = v;
            cell.text = text;
            cell.computed = true;
            cell.inlines = [{ type: "text", value: text }];
          }
        } catch (e) {
          diagnostics.push({ severity: "error", message: `compute \`${name}\`: ${e.message}` });
          failed = true;
        }
      }
    }
    const summaryDecls = Object.entries(attrs).filter(([k]) => k === "summary" || /^summary\d+$/.test(k)).map(([, v]) => v).filter((v) => typeof v === "string").flatMap((v) => v.split(";")).map((s) => s.trim()).filter((s) => s !== "");
    if (summaryDecls.length > 0) {
      const summary = columns.map(() => ({ text: "", inlines: [] }));
      const noRow = () => null;
      for (const s of summaryDecls) {
        const eq = s.indexOf("=");
        if (eq <= 0) {
          diagnostics.push({ severity: "error", message: `bad summary \`${s}\` (want \`Cell = value\`)` });
          continue;
        }
        const { name, fmt: fmt3 } = splitName(s.slice(0, eq));
        const rhs = s.slice(eq + 1).trim();
        const ci = colIndex(name);
        if (ci < 0) {
          diagnostics.push({ severity: "error", message: `summary targets unknown column \`${name}\`` });
          continue;
        }
        if (rhs.startsWith("'") && rhs.endsWith("'") && rhs.length >= 2) {
          const text = rhs.slice(1, -1);
          summary[ci] = { text, inlines: [{ type: "text", value: text }] };
          continue;
        }
        let toks;
        try {
          toks = lexExpr(rhs);
        } catch {
          diagnostics.push({ severity: "error", message: `cannot lex summary \`${s}\`` });
          continue;
        }
        try {
          const v = evalExpr(toks, 0, noRow, aggResolve);
          if (Number.isFinite(v)) {
            const text = fmt3 ? applyFormat(fmt3, v) : defaultNum(v);
            summary[ci] = { text, inlines: [{ type: "text", value: text }], value: v, computed: true };
          }
        } catch (e) {
          const msg = /unknown column `(.+)`/.exec(e.message);
          const hint = msg ? `summary \`${name}\`: column \`${msg[1]}\` must be reduced by an aggregate (e.g. sum(${msg[1]}))` : `summary \`${name}\`: ${e.message}`;
          diagnostics.push({ severity: "error", message: hint });
        }
      }
      model.summary = summary;
    }
    const spanDecls = Object.entries(attrs).filter(([k]) => k === "span" || /^span\d+$/.test(k)).map(([, v]) => v).filter((v) => typeof v === "string");
    for (const sd of spanDecls) {
      const sp = parseSpan(sd);
      if (!sp) {
        diagnostics.push({ severity: "error", message: `bad span \`${sd}\` (want \`rNcM:RxC\`)` });
        continue;
      }
      const cell = model.rows[sp.row - 1]?.[sp.col - 1];
      if (!cell) {
        diagnostics.push({ severity: "warning", message: `span \`${sd}\` targets a cell outside the table` });
        continue;
      }
      cell.span = { rows: sp.rows, cols: sp.cols };
    }
    return { model, diagnostics };
  }
  function ensureCell(row, ci) {
    while (row.length <= ci)
      row.push({ text: "", inlines: [] });
    return row[ci];
  }

  // ../geml-parser/dist/chart.js
  var TYPES = /* @__PURE__ */ new Set(["bar", "line", "area", "pie", "scatter"]);
  var USES = {
    bar: /* @__PURE__ */ new Set(["x", "y", "series"]),
    line: /* @__PURE__ */ new Set(["x", "y", "series"]),
    area: /* @__PURE__ */ new Set(["x", "y", "series"]),
    scatter: /* @__PURE__ */ new Set(["x", "y", "series", "size"]),
    pie: /* @__PURE__ */ new Set(["x", "y"])
  };
  function str(v) {
    return v === void 0 ? void 0 : typeof v === "string" ? v : String(v);
  }
  function buildChart(attrs, table) {
    const diagnostics = [];
    const err = (m) => diagnostics.push({ severity: "error", message: m });
    const warn = (m) => diagnostics.push({ severity: "warning", message: m });
    const fail2 = () => ({ model: null, diagnostics });
    const typeRaw = str(attrs["type"]);
    if (!typeRaw) {
      err("chart: missing `type`");
      return fail2();
    }
    if (!TYPES.has(typeRaw)) {
      err(`chart: unknown type \`${typeRaw}\` (supported: bar, line, area, pie, scatter; use format=vega-lite for others)`);
      return fail2();
    }
    const type = typeRaw;
    const rowsAttr = str(attrs["rows"]) ?? "data";
    if (!["data", "all", "summary"].includes(rowsAttr)) {
      err(`chart: unknown rows scope \`${rowsAttr}\` (data|all|summary)`);
      return fail2();
    }
    const x = str(attrs["x"]);
    const yRaw = str(attrs["y"]);
    if (!x)
      err("chart: missing required channel `x`");
    if (!yRaw)
      err("chart: missing required channel `y`");
    if (!x || !yRaw)
      return fail2();
    let y = yRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (y.length === 0) {
      err("chart: `y` lists no columns");
      return fail2();
    }
    if (attrs["size"] !== void 0 && !USES[type].has("size"))
      warn(`chart: \`size\` is ignored for type \`${type}\``);
    if (attrs["series"] !== void 0 && !USES[type].has("series"))
      warn(`chart: \`series\` is ignored for type \`${type}\``);
    if (type === "pie" && y.length > 1) {
      warn("chart: pie uses a single `y`; extra columns ignored");
      y = [y[0]];
    }
    const series = USES[type].has("series") ? str(attrs["series"]) : void 0;
    const size = USES[type].has("size") ? str(attrs["size"]) : void 0;
    const idx = (name) => table.columns.indexOf(name);
    for (const name of [x, ...y, ...series ? [series] : [], ...size ? [size] : []]) {
      if (idx(name) < 0)
        err(`chart: column \`${name}\` not found in table`);
    }
    if (diagnostics.some((d) => d.severity === "error"))
      return fail2();
    let picked;
    if (rowsAttr === "summary") {
      if (!table.summary) {
        err("chart: rows=summary but the table has no summary row");
        return fail2();
      }
      picked = [table.summary];
    } else if (rowsAttr === "all") {
      if (!table.summary)
        warn("chart: rows=all but the table has no summary row; using data rows");
      picked = table.summary ? [...table.rows, table.summary] : table.rows;
    } else {
      picked = table.rows;
    }
    const numCols = [...y, ...size ? [size] : []];
    const xi = idx(x);
    const si = series ? idx(series) : -1;
    const numIs = numCols.map(idx);
    const categories = [];
    const numbers = {};
    const seriesOf = [];
    for (const c of numCols)
      numbers[c] = [];
    for (const row of picked) {
      const cells = numIs.map((i) => row[i]);
      if (cells.some((cell) => (cell?.text ?? "") !== "" && typeof cell?.value !== "number")) {
        err("chart: non-numeric value in a y column");
        return fail2();
      }
      if (cells.some((cell) => (cell?.text ?? "") === ""))
        continue;
      categories.push(row[xi]?.text ?? "");
      numIs.forEach((i, j) => numbers[numCols[j]].push(row[i].value));
      if (series)
        seriesOf.push(row[si]?.text ?? "");
    }
    const dataRef = (str(attrs["data"]) ?? "").replace(/^#/, "");
    const dataset = { categories, numbers };
    if (series)
      dataset.seriesOf = seriesOf;
    const model = { type, x, y, rows: rowsAttr, dataRef, dataset };
    if (series)
      model.series = series;
    if (size)
      model.size = size;
    return { model, diagnostics };
  }

  // ../geml-parser/dist/from-md.js
  function fenceFor2(body) {
    let max = 2;
    for (const l of body) {
      const m = /^\s*(=+)\s*$/.exec(l);
      if (m)
        max = Math.max(max, m[1].length);
    }
    return "=".repeat(Math.max(3, max + 1));
  }
  function emitBlock(out, type, attrs, body, ids) {
    if (ids && type !== "meta" && !attrs.includes("#")) {
      const n = ids[type] = (ids[type] ?? 0) + 1;
      const idAttr = `#${type}-${n}`;
      attrs = attrs ? attrs.replace(/^\{/, `{${idAttr} `) : `{${idAttr}}`;
    }
    const fence2 = fenceFor2(body);
    out.push(attrs ? `${fence2} ${type} ${attrs}` : `${fence2} ${type}`);
    out.push(...body);
    out.push(fence2);
  }
  var DIAGRAM_LANGS = /* @__PURE__ */ new Set(["mermaid", "graphviz", "dot", "d2", "plantuml"]);
  function metaLine(line) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m)
      return null;
    let v = m[2].trim();
    if (v === "")
      return `${m[1]}=""`;
    if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'"))
      v = v.slice(1, -1);
    const bareSafe = /^[^\s"]+$/.test(v);
    return bareSafe ? `${m[1]}=${v}` : `${m[1]}="${v.replace(/"/g, '\\"')}"`;
  }
  function autolinks(s) {
    return s.split(/(`[^`]*`)/).map((seg, i) => i % 2 === 1 ? seg : seg.replace(/<((?:https?|ftp):\/\/[^>\s]+)>/g, "[$1]($1)").replace(/<mailto:([^>\s]+)>/g, "[$1](mailto:$1)")).join("");
  }
  function githubSlug(text) {
    return text.replace(/`/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
  }
  var FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
  var SETEXT_UL = /^=+\s*$/;
  var SETEXT_DASH = /^-+\s*$/;
  var THEMATIC = /^\s*([-*_])(\s*\1){2,}\s*$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  function mdToGeml(source) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const notes = [];
    const ids = {};
    let i = 0;
    if (lines[0] === "---") {
      let j = 1;
      const meta = [];
      while (j < lines.length && lines[j] !== "---" && lines[j] !== "...") {
        const ml = metaLine(lines[j]);
        if (ml)
          meta.push(ml);
        else if (lines[j].trim() !== "")
          notes.push(`frontmatter line not converted: ${lines[j]}`);
        j++;
      }
      if (j < lines.length) {
        emitBlock(out, "meta", "", meta, ids);
        out.push("");
        i = j + 1;
      }
    }
    while (i < lines.length) {
      const line = lines[i];
      const f = FENCE.exec(line);
      if (f) {
        const marker = f[2];
        const info = f[3].trim().split(/\s+/)[0] ?? "";
        const body = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const raw = lines[j];
          const indent = raw.length - raw.trimStart().length;
          const c = raw.replace(/\s+$/, "").trimStart();
          if (indent <= 3 && c.length >= marker.length && c[0] === marker[0] && /^[`~]+$/.test(c))
            break;
          body.push(raw);
        }
        if (DIAGRAM_LANGS.has(info))
          emitBlock(out, "diagram", `{format=${info}}`, body, ids);
        else
          emitBlock(out, "code", info ? `{lang=${info}}` : "", body, ids);
        i = j < lines.length ? j + 1 : j;
        continue;
      }
      if (line.trim() === "$$") {
        const body = [];
        let j = i + 1;
        for (; j < lines.length && lines[j].trim() !== "$$"; j++)
          body.push(lines[j]);
        emitBlock(out, "math", "", body, ids);
        i = j < lines.length ? j + 1 : j;
        continue;
      }
      if (line.trim() !== "" && !THEMATIC.test(line) && i + 1 < lines.length) {
        const nxt = lines[i + 1];
        if (SETEXT_UL.test(nxt)) {
          out.push(`# ${line.trim()}`);
          i += 2;
          continue;
        }
        if (SETEXT_DASH.test(nxt)) {
          out.push(`## ${line.trim()}`);
          i += 2;
          continue;
        }
      }
      if (THEMATIC.test(line)) {
        notes.push(`dropped thematic break at line ${i + 1}`);
        i++;
        continue;
      }
      const fn = /^\[\^([^\]]+)\]:\s?(.*)$/.exec(line);
      if (fn) {
        const body = fn[2].trim() ? [fn[2].trim()] : [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (/^\s{2,}\S/.test(lines[j]))
            body.push(lines[j].replace(/^\s+/, ""));
          else if (lines[j].trim() === "")
            break;
          else
            break;
        }
        emitBlock(out, "note", `{#${fn[1].trim()}}`, body.map(autolinks), ids);
        i = j;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          body.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        emitBlock(out, "note", "", body, ids);
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && line.trim() !== "") {
        const body = [line];
        let j = i + 1;
        body.push(lines[j]);
        j++;
        while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
          body.push(lines[j]);
          j++;
        }
        emitBlock(out, "table", "", body, ids);
        i = j;
        continue;
      }
      const atx = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (atx && atx[2].includes("`") && !/\{[^}]*\}\s*$/.test(atx[2])) {
        const id = githubSlug(atx[2]);
        if (id) {
          out.push(`${atx[1]} ${atx[2]} {#${id}}`);
          i++;
          continue;
        }
      }
      const text = autolinks(line);
      if (/<[a-zA-Z/]/.test(text.replace(/`[^`]*`/g, ""))) {
        notes.push(`raw HTML kept as text at line ${i + 1}: ${line.trim().slice(0, 40)}`);
      }
      out.push(text);
      i++;
    }
    let geml = out.join("\n");
    if (!geml.endsWith("\n"))
      geml += "\n";
    return { geml, notes };
  }

  // ../geml-parser/dist/serialize.js
  function looksTyped(s) {
    return s === "true" || s === "false" || /^[+-]?\d+$/.test(s) || /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(s) && /[.eE]/.test(s);
  }
  function serAttrValue(v) {
    if (v === true)
      return "";
    if (v === false)
      return "false";
    if (typeof v === "number")
      return String(v);
    return `"${v}"`;
  }
  function serAttrs(a) {
    const parts = [];
    if (a.id !== void 0)
      parts.push(`#${a.id}`);
    for (const c of a.classes ?? [])
      parts.push(`.${c}`);
    for (const [k, v] of Object.entries(a.attrs ?? {})) {
      parts.push(v === true ? k : `${k}=${serAttrValue(v)}`);
    }
    return parts.length ? `{${parts.join(" ")}}` : "";
  }
  function serDataValue(v) {
    if (typeof v === "boolean")
      return String(v);
    if (typeof v === "number")
      return String(v);
    return looksTyped(v) || v.trim() !== v ? `"${v}"` : v;
  }
  function escText(s) {
    return s.replace(/[\\`*~$\[\]]/g, (c) => "\\" + c);
  }
  function longestRun(s, ch) {
    let max = 0;
    let run = 0;
    for (const c of s) {
      if (c === ch) {
        run++;
        if (run > max)
          max = run;
      } else
        run = 0;
    }
    return max;
  }
  function linkDest(n) {
    if (n.href !== void 0)
      return n.href;
    if (n.doc !== void 0)
      return n.anchor !== void 0 ? `${n.doc}#${n.anchor}` : n.doc;
    if (n.anchor !== void 0)
      return `#${n.anchor}`;
    return "";
  }
  function serInline(n, esc2) {
    switch (n.type) {
      case "text":
        return esc2 ? escText(n.value) : n.value;
      case "emph":
        return `*${serSeq(n.children, esc2)}*`;
      case "strong":
        return `**${serSeq(n.children, esc2)}**`;
      case "strike":
        return `~~${serSeq(n.children, esc2)}~~`;
      case "code": {
        const f = "`".repeat(longestRun(n.value, "`") + 1);
        return f + n.value + f;
      }
      case "math":
        return `$${n.value}$`;
      case "break":
        return "\\\n";
      case "image":
        return `![${n.alt}](${n.src})${serAttrs({ attrs: n.attrs })}`;
      case "link":
        return `[${serSeq(n.children, esc2)}](${linkDest(n)})${serAttrs({ attrs: n.attrs })}`;
      case "autoref":
        return `[[${n.doc !== void 0 ? `${n.doc}#${n.anchor}` : `#${n.anchor}`}]]`;
      case "footnote":
        return `[^${n.ref}]`;
    }
  }
  function serSeq(ns, esc2) {
    return ns.map((n) => serInline(n, esc2)).join("");
  }
  function serInlines(ns) {
    const lazy = serSeq(ns, false);
    if (JSON.stringify(parseInline(lazy, 0, { refs: [] })) === JSON.stringify(ns))
      return lazy;
    return serSeq(ns, true);
  }
  function serList(list, indent) {
    const out = [];
    const start = list.start ?? 1;
    list.items.forEach((item, k) => {
      const marker = list.ordered ? `${start + k}. ` : "- ";
      const task = item.checked === void 0 ? "" : item.checked ? "[x] " : "[ ] ";
      out.push(indent + marker + task + serInlines(item.inlines));
      for (const child of item.children ?? []) {
        out.push(child.kind === "list" ? serList(child, indent + "  ") : serBlock(child));
      }
      if (list.loose && k < list.items.length - 1)
        out.push("");
    });
    return out.join("\n");
  }
  function serTypedBlock(b) {
    let body;
    if (b.mode === "flow") {
      body = (b.children ?? []).map(serBlock).join("\n\n").split("\n");
    } else if (b.mode === "data") {
      body = Object.entries(b.data ?? {}).map(([k, v]) => `${k} = ${serDataValue(v)}`);
    } else {
      body = b.raw ?? [];
    }
    let maxEq = 2;
    for (const ln of body) {
      const m = /^(=+)[ \t]*$/.exec(ln);
      if (m)
        maxEq = Math.max(maxEq, m[1].length);
    }
    const fence2 = "=".repeat(Math.max(3, maxEq + 1));
    const attrs = serAttrs({ id: b.id, classes: b.classes, attrs: b.attrs });
    const open = fence2 + " " + b.type + (attrs ? " " + attrs : "");
    return [open, ...body, fence2].join("\n");
  }
  function serBlock(b) {
    switch (b.kind) {
      case "heading": {
        const attrs = serAttrs({ id: b.id, classes: b.classes, attrs: b.attrs });
        return "#".repeat(b.level) + " " + serInlines(b.inlines) + (attrs ? " " + attrs : "");
      }
      case "paragraph":
        return serInlines(b.inlines);
      case "hidden":
        return "%%" + (b.text ? " " + b.text : "");
      case "list":
        return serList(b, "");
      case "block":
        return serTypedBlock(b);
    }
  }
  function serialize(doc) {
    const blocks = Array.isArray(doc) ? doc : doc.children;
    return blocks.map(serBlock).join("\n\n") + "\n";
  }

  // ../geml-parser/dist/to-md.js
  function escText2(s) {
    return s.replace(/[\\`*_\[\]]/g, (c) => "\\" + c);
  }
  function linkDest2(n) {
    if (n.href !== void 0)
      return n.href;
    if (n.doc !== void 0)
      return n.anchor !== void 0 ? `${n.doc}#${n.anchor}` : n.doc;
    if (n.anchor !== void 0)
      return `#${n.anchor}`;
    return "";
  }
  function inline(n) {
    switch (n.type) {
      case "text":
        return escText2(n.value);
      case "emph":
        return `*${seq(n.children)}*`;
      case "strong":
        return `**${seq(n.children)}**`;
      case "strike":
        return `~~${seq(n.children)}~~`;
      case "code":
        return "`" + n.value + "`";
      case "math":
        return `$${n.value}$`;
      case "break":
        return "  \n";
      case "image":
        return `![${n.alt}](${n.src})`;
      case "link":
        return `[${seq(n.children)}](${linkDest2(n)})`;
      // Markdown has no auto-reference; project to a plain link to the anchor.
      case "autoref":
        return n.doc !== void 0 ? `[${n.doc}#${n.anchor}](${n.doc}#${n.anchor})` : `[#${n.anchor}](#${n.anchor})`;
      case "footnote":
        return `[^${n.ref}]`;
    }
  }
  function seq(ns) {
    return ns.map(inline).join("");
  }
  function cellText(c) {
    return seq(c.inlines).replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
  function sep(a) {
    if (a === "center")
      return ":--:";
    if (a === "right")
      return "---:";
    if (a === "left")
      return ":---";
    return "---";
  }
  function tableToMd(t, notes) {
    if (t.src !== void 0)
      notes.add(`table from external source \`${t.src}\` is not inlined; emitted header only`);
    const cols = t.columns;
    const lines = [];
    if (t.caption)
      lines.push(`*${t.caption}*`, "");
    lines.push(`| ${cols.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`);
    lines.push(`| ${cols.map((_, i) => sep(t.align[i])).join(" | ")} |`);
    const pad = (cells) => {
      while (cells.length < cols.length)
        cells.push("");
      return cells.slice(0, cols.length);
    };
    for (const row of t.rows)
      lines.push(`| ${pad(row.map(cellText)).join(" | ")} |`);
    if (t.summary)
      lines.push(`| ${pad(t.summary.map(cellText)).join(" | ")} |`);
    return lines.join("\n");
  }
  function listToMd(b, indent, notes) {
    const out = [];
    const start = b.start ?? 1;
    b.items.forEach((item, k) => {
      const marker = b.ordered ? `${start + k}. ` : "- ";
      const task = item.checked === void 0 ? "" : item.checked ? "[x] " : "[ ] ";
      out.push(indent + marker + task + seq(item.inlines));
      for (const child of item.children ?? []) {
        out.push(child.kind === "list" ? listToMd(child, indent + "  ", notes) : block(child, notes));
      }
      if (b.loose && k < b.items.length - 1)
        out.push("");
    });
    return out.join("\n");
  }
  function fence(lang, body) {
    let max = 2;
    for (const ln of body) {
      const m = /^(`+)/.exec(ln.trim());
      if (m)
        max = Math.max(max, m[1].length);
    }
    const f = "`".repeat(Math.max(3, max + 1));
    return [f + lang, ...body, f].join("\n");
  }
  function attr2(b, key) {
    const v = b.attrs[key];
    return typeof v === "string" ? v : v === void 0 ? void 0 : String(v);
  }
  function typedToMd(b, notes) {
    if (b.hidden) {
      notes.add("`{hidden}` block(s) dropped (not part of the rendered output)");
      return "";
    }
    if (b.mode === "flow") {
      if (b.type === "note" && b.classes.includes("footnote") && b.id) {
        const text = (b.children ?? []).map((c) => block(c, notes)).join(" ").replace(/\n+/g, " ").trim();
        return `[^${b.id}]: ${text}`;
      }
      if (b.type === "aside")
        notes.add("`aside` block(s) projected to blockquote (Markdown has no aside)");
      const inner = (b.children ?? []).map((c) => block(c, notes)).filter(Boolean).join("\n\n");
      return inner.split("\n").map((l) => l ? `> ${l}` : ">").join("\n");
    }
    const raw = b.raw ?? [];
    if (b.type === "code")
      return fence(attr2(b, "lang") ?? "", raw);
    if (b.type === "math")
      return ["$$", ...raw, "$$"].join("\n");
    if (b.type === "output")
      return fence("", raw);
    if (b.type === "table" && b.table)
      return tableToMd(b.table, notes);
    if (b.type === "diagram") {
      const fmt2 = attr2(b, "format") ?? "";
      if (fmt2 === "geml-chart") {
        notes.add("`geml-chart` block(s) cannot render in Markdown; emitted a descriptor");
        const desc = ["type", "data", "x", "y", "series"].map((k) => {
          const v = attr2(b, k);
          return v ? `${k}=${v}` : "";
        }).filter(Boolean).join(" ");
        return fence("geml-chart", [desc]);
      }
      return fence(fmt2, raw);
    }
    notes.add(`unknown block type \`${b.type}\` emitted as a fenced code block`);
    return fence(b.type, raw);
  }
  function block(b, notes) {
    switch (b.kind) {
      case "heading": {
        if (b.hidden) {
          notes.add("hidden heading dropped");
          return "";
        }
        if (b.id)
          notes.add("heading id/attributes dropped (Markdown has no attribute syntax)");
        return "#".repeat(b.level) + " " + seq(b.inlines);
      }
      case "paragraph":
        return seq(b.inlines);
      case "hidden":
        return "";
      // `%%` line: never rendered
      case "list":
        return listToMd(b, "", notes);
      case "block":
        return typedToMd(b, notes);
    }
  }
  function yamlValue(v) {
    if (typeof v === "boolean" || typeof v === "number")
      return String(v);
    return /^[\w .,/@-]+$/.test(v) && v.trim() === v && v !== "" ? v : JSON.stringify(v);
  }
  function frontmatter(metas) {
    const merged = {};
    for (const m of metas)
      Object.assign(merged, m);
    const keys = Object.keys(merged);
    if (!keys.length)
      return "";
    return ["---", ...keys.map((k) => `${k}: ${yamlValue(merged[k])}`), "---"].join("\n");
  }
  function gemlToMd(doc) {
    const notes = /* @__PURE__ */ new Set();
    const metas = [];
    const parts = [];
    for (const b of doc.children) {
      if (b.kind === "block" && b.type === "meta" && b.mode === "data") {
        metas.push(b.data ?? {});
        continue;
      }
      const md2 = block(b, notes);
      if (md2 !== "")
        parts.push(md2);
    }
    const fm = frontmatter(metas);
    const body = parts.join("\n\n");
    const md = (fm ? fm + "\n\n" : "") + body + "\n";
    return { md, notes: [...notes] };
  }

  // ../geml-parser/dist/geml.js
  var REGISTRY = {
    code: "raw",
    diagram: "raw",
    math: "raw",
    table: "raw",
    // structured table parsing lands in M3
    output: "raw",
    // captured result of a code block (stored, never executed)
    note: "flow",
    aside: "flow",
    meta: "data"
  };
  var DIAGRAM_RENDERERS = /* @__PURE__ */ new Set(["mermaid", "graphviz", "dot", "d2", "plantuml", "geml-chart"]);
  var FENCE_OPEN2 = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;
  var HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(\{[^}]*\})?[ \t]*$/;
  var LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;
  function isCloseFence(line, openLen) {
    const t = line.replace(/\s+$/, "");
    return /^=+$/.test(t) && t.length === openLen;
  }
  function slug(text) {
    return text.toLowerCase().replace(/`[^`]*`/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
  }
  function interpolate(text, line, ctx) {
    if (!text.includes("{{"))
      return text;
    return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g, (full, key) => {
      if (ctx.meta.has(key))
        return ctx.meta.get(key);
      ctx.diags.push({ severity: "error", message: `unknown metadata reference \`{{${key}}}\``, line });
      return full;
    });
  }
  function registerId(ctx, id, line) {
    if (ctx.ids.has(id)) {
      ctx.diags.push({ severity: "error", message: `duplicate id \`#${id}\` (first defined at line ${ctx.ids.get(id)})`, line });
    } else {
      ctx.ids.set(id, line);
    }
  }
  var MARKER = /^([ \t]*)(?:[-*]|(\d+)\.)[ \t]+(.*)$/;
  function matchMarker(line) {
    const m = MARKER.exec(line);
    if (!m)
      return null;
    const ordered = m[2] !== void 0;
    const mk = { indent: m[1].length, ordered, rest: m[3] };
    if (ordered)
      mk.start = parseInt(m[2], 10);
    return mk;
  }
  function makeListItem(mk, lineNo, ctx) {
    let text = interpolate(mk.rest, lineNo, ctx);
    const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(text);
    const item = { text, inlines: [] };
    if (task) {
      item.checked = task[1] !== " ";
      text = task[2] ?? "";
      item.text = text;
    }
    item.inlines = parseInline(text, lineNo, ctx);
    return item;
  }
  function parseList(lines, i, base, ctx) {
    const mkList = (m) => {
      const l = { kind: "list", ordered: m.ordered, items: [] };
      if (m.ordered && m.start !== void 0)
        l.start = m.start;
      return l;
    };
    const root = mkList(matchMarker(lines[i]));
    const stack = [{ list: root, indent: matchMarker(lines[i]).indent }];
    let prevBlank = false;
    while (i < lines.length) {
      if (lines[i].trim() === "") {
        prevBlank = true;
        i++;
        continue;
      }
      const mk = matchMarker(lines[i]);
      if (!mk)
        break;
      while (stack.length > 1 && mk.indent < stack[stack.length - 1].indent)
        stack.pop();
      const top = stack[stack.length - 1];
      let cur;
      if (mk.indent > top.indent) {
        const parent = top.list.items[top.list.items.length - 1];
        if (!parent)
          break;
        cur = mkList(mk);
        (parent.children ??= []).push(cur);
        stack.push({ list: cur, indent: mk.indent });
      } else {
        cur = top.list;
      }
      if (prevBlank && cur.items.length > 0)
        cur.loose = true;
      cur.items.push(makeListItem(mk, base + i + 1, ctx));
      prevBlank = false;
      i++;
    }
    return { block: root, next: i };
  }
  function scanBlocks(lines, base, ctx) {
    const blocks = [];
    const diags = ctx.diags;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i++;
        continue;
      }
      const hid = /^[ \t]*%%[ \t]?(.*)$/.exec(line);
      if (hid) {
        blocks.push({ kind: "hidden", text: hid[1] });
        i++;
        continue;
      }
      const fndef = /^\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(line);
      if (fndef) {
        const id = fndef[1].trim();
        const lineNo = base + i + 1;
        registerId(ctx, id, lineNo);
        const text2 = interpolate(fndef[2], lineNo, ctx);
        blocks.push({
          kind: "block",
          type: "note",
          mode: "flow",
          id,
          classes: ["footnote"],
          attrs: {},
          children: [{ kind: "paragraph", text: text2, inlines: parseInline(text2, lineNo, ctx) }]
        });
        i++;
        continue;
      }
      const open = FENCE_OPEN2.exec(line);
      if (open) {
        const openLen = open[1].length;
        const type = open[2];
        const attrs = open[3] ? parseAttrs(open[3]) : { classes: [], attrs: {} };
        const openLineNo = base + i + 1;
        const labeled = attrs.id !== void 0 ? new RegExp(`^={3,}[ \\t]+#${attrs.id}[ \\t]*$`) : null;
        const body = [];
        let j = i + 1;
        let closed = false;
        for (; j < lines.length; j++) {
          if (isCloseFence(lines[j], openLen) || labeled && labeled.test(lines[j])) {
            closed = true;
            break;
          }
          body.push(lines[j]);
        }
        if (!closed) {
          const how = attrs.id !== void 0 ? `${"=".repeat(openLen)} or \`=== #${attrs.id}\`` : "=".repeat(openLen);
          diags.push({ severity: "error", message: `unterminated \`${type}\` block (no matching ${how})`, line: openLineNo });
        }
        let mode = REGISTRY[type];
        if (mode === void 0) {
          diags.push({ severity: "warning", message: `unknown block type \`${type}\`; body kept as raw`, line: openLineNo });
          mode = "raw";
        }
        const block2 = {
          kind: "block",
          type,
          mode,
          classes: attrs.classes,
          attrs: attrs.attrs
        };
        if (attrs.id !== void 0) {
          block2.id = attrs.id;
          registerId(ctx, attrs.id, openLineNo);
        }
        if (attrs.attrs["hidden"] === true)
          block2.hidden = true;
        if (type === "output" && typeof attrs.attrs["of"] === "string") {
          const of = attrs.attrs["of"];
          if (of.startsWith("#"))
            ctx.refs.push({ kind: "internal", anchor: of.slice(1), line: openLineNo });
        }
        if (mode === "flow") {
          block2.children = scanBlocks(body, base + i + 1, ctx);
        } else if (mode === "data") {
          block2.data = parseData(body);
        } else {
          block2.raw = body;
          if (type === "table") {
            const { model, diagnostics } = parseTable(body, attrs.attrs, openLineNo, ctx);
            block2.table = model;
            for (const d of diagnostics)
              diags.push({ ...d, line: openLineNo });
            if (block2.id !== void 0 && !ctx.tables?.has(block2.id)) {
              (ctx.tables ??= /* @__PURE__ */ new Map()).set(block2.id, model);
            }
          } else if (type === "diagram") {
            const fmt2 = attrs.attrs["format"];
            if (fmt2 === "geml-chart") {
              if (body.length > 0 && body.some((l) => l.trim() !== "")) {
                diags.push({ severity: "warning", message: "geml-chart body is ignored; the chart spec lives in attributes", line: openLineNo });
              }
              (ctx.charts ??= []).push({ block: block2, line: openLineNo });
            } else if (typeof fmt2 === "string" && !DIAGRAM_RENDERERS.has(fmt2)) {
              diags.push({ severity: "warning", message: `no registered renderer for diagram format \`${fmt2}\`; body kept raw`, line: openLineNo });
            }
          }
        }
        blocks.push(block2);
        i = closed ? j + 1 : j;
        continue;
      }
      const h = HEADING.exec(line);
      if (h) {
        const lineNo = base + i + 1;
        const level = h[1].length;
        const a = h[3] ? parseAttrs(h[3]) : { classes: [], attrs: {} };
        const text2 = interpolate(h[2], lineNo, ctx);
        const id = a.id ?? slug(text2);
        registerId(ctx, id, lineNo);
        const block2 = {
          kind: "heading",
          level,
          text: text2,
          inlines: parseInline(text2, lineNo, ctx),
          id,
          classes: a.classes,
          attrs: a.attrs
        };
        if (a.attrs["hidden"] === true)
          block2.hidden = true;
        blocks.push(block2);
        i++;
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const { block: block2, next } = parseList(lines, i, base, ctx);
        blocks.push(block2);
        i = next;
        continue;
      }
      const paraStart = base + i + 1;
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^[ \t]*%%/.test(lines[i]) && !FENCE_OPEN2.test(lines[i]) && !HEADING.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      const text = interpolate(para.join("\n"), paraStart, ctx);
      blocks.push({ kind: "paragraph", text, inlines: parseInline(text, paraStart, ctx) });
    }
    return blocks;
  }
  function parseData(lines) {
    const out = {};
    for (const raw of lines) {
      if (raw.trim() === "")
        continue;
      const eq = raw.indexOf("=");
      if (eq <= 0)
        continue;
      out[raw.slice(0, eq).trim()] = coerce(raw.slice(eq + 1));
    }
    return out;
  }
  function gatherIds(source) {
    const ctx = { diags: [], ids: /* @__PURE__ */ new Map(), refs: [], meta: /* @__PURE__ */ new Map() };
    scanBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0, ctx);
    return new Set(ctx.ids.keys());
  }
  function collectMeta(lines) {
    const meta = /* @__PURE__ */ new Map();
    for (let i = 0; i < lines.length; i++) {
      const open = FENCE_OPEN2.exec(lines[i]);
      if (!open || open[2] !== "meta")
        continue;
      const len = open[1].length;
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !isCloseFence(lines[j], len); j++)
        body.push(lines[j]);
      for (const [k, v] of Object.entries(parseData(body)))
        meta.set(k, String(v));
      i = j;
    }
    return meta;
  }
  function validateRefs(ctx, opts) {
    const docIds = /* @__PURE__ */ new Map();
    for (const ref of ctx.refs) {
      if (ref.kind === "cross") {
        if (!ref.doc)
          continue;
        if (!opts.resolveDoc) {
          ctx.diags.push({ severity: "warning", message: `cross-document reference \`${ref.doc}${ref.anchor ? "#" + ref.anchor : ""}\` not checked (no document resolver)`, line: ref.line });
          continue;
        }
        let ids = docIds.get(ref.doc);
        if (ids === void 0) {
          const src = opts.resolveDoc(ref.doc);
          if (src === null) {
            ctx.diags.push({ severity: "error", message: `cannot resolve document \`${ref.doc}\``, line: ref.line });
            docIds.set(ref.doc, /* @__PURE__ */ new Set());
            continue;
          }
          ids = gatherIds(src);
          docIds.set(ref.doc, ids);
        }
        if (ref.anchor !== void 0 && !ids.has(ref.anchor)) {
          ctx.diags.push({ severity: "error", message: `unresolved reference \`${ref.doc}#${ref.anchor}\``, line: ref.line });
        }
        continue;
      }
      if (ref.anchor !== void 0 && !ctx.ids.has(ref.anchor)) {
        const what = ref.kind === "footnote" ? `footnote \`[^${ref.anchor}]\`` : `reference \`#${ref.anchor}\``;
        ctx.diags.push({ severity: "error", message: `unresolved ${what}`, line: ref.line });
      }
    }
  }
  function resolveCharts(ctx) {
    for (const { block: block2, line } of ctx.charts ?? []) {
      const ref = typeof block2.attrs["data"] === "string" ? block2.attrs["data"] : "";
      const id = ref.replace(/^#/, "");
      if (id === "") {
        ctx.diags.push({ severity: "error", message: "geml-chart: missing `data=#id`", line });
        continue;
      }
      const table = ctx.tables?.get(id);
      if (!table) {
        const what = ctx.ids.has(id) ? `data target \`#${id}\` is not a table` : `unresolved reference \`#${id}\``;
        ctx.diags.push({ severity: "error", message: `geml-chart: ${what}`, line });
        continue;
      }
      if (table.src !== void 0) {
        continue;
      }
      const { model, diagnostics } = buildChart(block2.attrs, table);
      if (model)
        block2.chart = model;
      for (const d of diagnostics)
        ctx.diags.push({ ...d, line });
    }
  }
  function parse(source, opts = {}) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const ctx = { diags: [], ids: /* @__PURE__ */ new Map(), refs: [], meta: collectMeta(lines) };
    const children = scanBlocks(lines, 0, ctx);
    resolveCharts(ctx);
    validateRefs(ctx, opts);
    return { kind: "document", children, ids: [...ctx.ids.keys()], diagnostics: ctx.diags };
  }
  function flag(args, name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : void 0;
  }
  function historyPathFor(geml) {
    return geml.replace(/\.geml$/, "") + ".gemlhistory";
  }
  function parseStamp(s) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m)
      throw new Error(`bad --at timestamp: ${s} (want YYYYMMDDTHHMMSSZ)`);
    const [, y, mo, d, h, mi, se] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  }
  var VERSION = "1.0";
  var PARSER_VERSION = "1.0.0";
  var USAGE = `geml \u2014 GEML reference CLI

Usage:
  geml <file.geml|->                         parse -> document-model JSON (stdout)
  geml check <file.geml|-> [--json]          validate only: diagnostics + exit code
  geml render <file.geml|-> [-o out.html]    render to one self-contained HTML file
  geml fmt <file.geml|-> [-o out.geml]       re-serialize to canonical GEML
  geml convert <file.md|-> [-o out.geml]     Markdown -> GEML
  geml export <file.geml|-> [-o out.md]      GEML -> Markdown (lossy)
  geml history <commit|verify|show|restore> <file.geml> [...]
  geml --help | --version [--json]

Use '-' as the file to read from stdin.
Exit codes: 0 ok \xB7 1 document/operation error \xB7 2 usage error.`;
  var SUBHELP = {
    check: "usage: geml check <file.geml|-> [--json]",
    render: "usage: geml render <file.geml|-> [-o out.html]",
    convert: "usage: geml convert <file.md|-> [-o out.geml]",
    export: "usage: geml export <file.geml|-> [-o out.md]",
    fmt: "usage: geml fmt <file.geml|-> [-o out.geml]",
    history: "usage: geml history <commit|verify|show|restore> <file.geml> [...]"
  };
  var jsonMode = false;
  function fail(msg) {
    if (jsonMode)
      console.error(JSON.stringify({ error: msg, code: 2 }));
    else
      console.error(`error: ${msg}`);
    process.exit(2);
  }
  function readInput(file) {
    try {
      return readFileSync(file === "-" ? 0 : file, "utf8");
    } catch {
      fail(file === "-" ? "cannot read stdin" : `cannot read ${file}`);
    }
  }
  function resolverFor(file) {
    const baseDir = file === "-" ? "." : dirname(file);
    return (d) => {
      try {
        return readFileSync(resolve(baseDir, d), "utf8");
      } catch {
        return null;
      }
    };
  }
  function runCheck(args) {
    const json = args.includes("--json");
    const file = args.find((a) => a === "-" || !a.startsWith("-"));
    if (!file)
      fail(SUBHELP.check);
    const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
    if (json) {
      console.log(JSON.stringify(doc.diagnostics, null, 2));
    } else {
      for (const d of doc.diagnostics)
        console.error(`${d.severity}: ${d.message} (line ${d.line})`);
      const errs = doc.diagnostics.filter((d) => d.severity === "error").length;
      const warns = doc.diagnostics.filter((d) => d.severity === "warning").length;
      console.error(errs || warns ? `${errs} error(s), ${warns} warning(s)` : "ok: no diagnostics");
    }
    if (doc.diagnostics.some((d) => d.severity === "error"))
      process.exit(1);
  }
  function historyError(e, file, historyPath) {
    const err = e;
    if (err?.code === "ENOENT") {
      const p = err.path ?? "";
      if (p.endsWith(basename(historyPath)))
        return `cannot read history ${historyPath}`;
      return `cannot read ${file}`;
    }
    return err?.message ?? String(e);
  }
  function runHistory(args) {
    const sub = args[0];
    const file = args[1];
    if (!sub || !file)
      fail(SUBHELP.history);
    const historyPath = flag(args, "--history") ?? historyPathFor(file);
    try {
      if (sub === "commit") {
        const at = flag(args, "--at");
        const r = commit({
          gemlPath: file,
          historyPath,
          summary: flag(args, "-m") ?? flag(args, "--message") ?? "",
          author: flag(args, "--author"),
          at: at ? parseStamp(at) : void 0
        });
        console.log(`committed ${r.id}`);
      } else if (sub === "verify") {
        const res = verify(historyPath, file);
        for (const e of res.errors)
          console.error(`error: ${e}`);
        for (const w of res.warnings)
          console.error(`warning: ${w}`);
        console.log(`verify: ${res.ok ? "OK" : "FAILED"} (${res.checked} revisions reconstructed & hashed)`);
        if (!res.ok)
          process.exit(1);
      } else if (sub === "show") {
        const rev = args[2];
        if (!rev)
          fail("usage: geml history show <file.geml> <revision>");
        process.stdout.write(restore({ historyPath, gemlPath: file, revision: rev }));
      } else if (sub === "restore") {
        const rev = args[2];
        if (!rev)
          fail("usage: geml history restore <file.geml> <revision> [--force]");
        restore({ historyPath, gemlPath: file, revision: rev, write: true, force: args.includes("--force") });
        console.log(`restored ${file} to ${rev}`);
      } else {
        fail(`unknown history subcommand: ${sub}. Run 'geml --help'.`);
      }
    } catch (e) {
      fail(historyError(e, file, historyPath));
    }
  }
  function runConvert(args) {
    const file = args.find((a) => a === "-" || !a.startsWith("-") && a !== flag(args, "-o"));
    if (!file)
      fail(SUBHELP.convert);
    const { geml, notes } = mdToGeml(readInput(file));
    for (const n of notes)
      console.error(`note: ${n}`);
    const outPath = flag(args, "-o") ?? flag(args, "--out");
    if (outPath) {
      writeFileSync(outPath, geml);
      console.error(`wrote ${outPath}`);
    } else {
      process.stdout.write(geml);
    }
  }
  function runExport(args) {
    const out = flag(args, "-o") ?? flag(args, "--out");
    const file = args.find((a) => a === "-" || !a.startsWith("-") && a !== out);
    if (!file)
      fail(SUBHELP.export);
    const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
    const { md, notes } = gemlToMd(doc);
    if (out) {
      writeFileSync(out, md);
      console.error(`wrote ${out}`);
    } else
      process.stdout.write(md);
    for (const n of notes)
      console.error(`note: ${n}`);
    for (const d of doc.diagnostics)
      console.error(`${d.severity}: ${d.message} (line ${d.line})`);
    if (doc.diagnostics.some((d) => d.severity === "error"))
      process.exit(1);
  }
  function runRender(args) {
    const out = flag(args, "-o") ?? flag(args, "--out");
    const file = args.find((a) => a === "-" || !a.startsWith("-") && a !== out);
    if (!file)
      fail(SUBHELP.render);
    const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
    const html = renderHtml(doc, { source: file === "-" ? "stdin" : basename(file) });
    if (out) {
      writeFileSync(out, html);
      console.error(`wrote ${out}`);
    } else
      process.stdout.write(html);
    for (const d of doc.diagnostics)
      console.error(`${d.severity}: ${d.message} (line ${d.line})`);
    if (doc.diagnostics.some((d) => d.severity === "error"))
      process.exit(1);
  }
  function runFmt(args) {
    const out = flag(args, "-o") ?? flag(args, "--out");
    const file = args.find((a) => a === "-" || !a.startsWith("-") && a !== out);
    if (!file)
      fail(SUBHELP.fmt);
    const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
    const text = serialize(doc);
    if (out) {
      writeFileSync(out, text);
      console.error(`wrote ${out}`);
    } else
      process.stdout.write(text);
    for (const d of doc.diagnostics)
      console.error(`${d.severity}: ${d.message} (line ${d.line})`);
    if (doc.diagnostics.some((d) => d.severity === "error"))
      process.exit(1);
  }
  var entry = define_process_argv_default[1] ?? "";
  if (entry.endsWith("geml.js") || entry.endsWith("geml.ts")) {
    const argv = define_process_argv_default.slice(2);
    const cmd = argv[0];
    jsonMode = argv.includes("--json");
    const rest = argv.slice(1);
    if (cmd === "--help" || cmd === "-h") {
      console.log(USAGE);
    } else if (cmd === "--version" || cmd === "-V") {
      if (jsonMode)
        console.log(JSON.stringify({ parser: PARSER_VERSION, spec: VERSION }));
      else
        console.log(`geml ${PARSER_VERSION} (GEML spec ${VERSION})`);
    } else if (cmd === void 0) {
      console.error(USAGE);
      process.exit(2);
    } else if (SUBHELP[cmd] && (rest.includes("--help") || rest.includes("-h"))) {
      console.log(SUBHELP[cmd]);
    } else if (cmd === "history") {
      runHistory(argv.slice(1));
    } else if (cmd === "convert") {
      runConvert(argv.slice(1));
    } else if (cmd === "export") {
      runExport(argv.slice(1));
    } else if (cmd === "render") {
      runRender(argv.slice(1));
    } else if (cmd === "fmt") {
      runFmt(argv.slice(1));
    } else if (cmd === "check") {
      runCheck(argv.slice(1));
    } else if (cmd !== "-" && !/[.\/\\]/.test(cmd)) {
      fail(`unknown command '${cmd}'. Run 'geml --help'.`);
    } else {
      const doc = parse(readInput(cmd), { resolveDoc: resolverFor(cmd) });
      console.log(JSON.stringify(doc, null, 2));
      if (doc.diagnostics.some((d) => d.severity === "error"))
        process.exit(1);
    }
  }

  // src/chart.js
  var NS = "http://www.w3.org/2000/svg";
  var PALETTE2 = ["#0969da", "#1a7f37", "#bf3989", "#9a6700", "#cf222e", "#8250df", "#0550ae"];
  var W = 640;
  var H = 360;
  var M = { top: 20, right: 20, bottom: 56, left: 56 };
  function renderChart(model, dom) {
    const frag = dom.createDocumentFragment();
    const svg = svgEl(dom, "svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
    const t = tabulate(model);
    try {
      if (model.type === "pie") drawPie(svg, dom, t);
      else if (model.type === "scatter") drawScatter(svg, dom, model, t);
      else if (model.type === "line" || model.type === "area") drawLines(svg, dom, t, model.type === "area");
      else drawBars(svg, dom, t);
    } catch {
      svg.appendChild(svgEl(dom, "text", { x: 20, y: 30, fill: "#cf222e" }, "chart could not be drawn"));
    }
    frag.appendChild(svg);
    if (model.type !== "pie" && t.series.length > 1) frag.appendChild(legend2(dom, t.series));
    else if (model.type === "pie") frag.appendChild(legend2(dom, t.cats));
    return frag;
  }
  function tabulate(model) {
    const ds = model.dataset;
    if (model.series && ds.seriesOf) {
      const y0 = model.y[0];
      const col = ds.numbers[y0] || [];
      const cats = uniq(ds.categories);
      const series2 = uniq(ds.seriesOf);
      const map = new Map(series2.map((s) => [s, new Array(cats.length).fill(null)]));
      ds.categories.forEach((cat, i) => {
        const row = map.get(ds.seriesOf[i]);
        const ci = cats.indexOf(cat);
        if (row && ci >= 0) row[ci] = col[i];
      });
      return { cats, series: series2, get: (s, ci) => map.get(s)[ci] };
    }
    const series = model.y;
    return { cats: ds.categories, series, get: (s, ci) => ds.numbers[s] ? ds.numbers[s][ci] : null };
  }
  function uniq(a) {
    const out = [];
    for (const x of a) if (!out.includes(x)) out.push(x);
    return out;
  }
  function extent(t) {
    let max = 0, min = 0;
    for (const s of t.series) for (let i = 0; i < t.cats.length; i++) {
      const v = t.get(s, i);
      if (typeof v === "number") {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    return { min, max: max === min ? max + 1 : max };
  }
  function svgEl(dom, tag, attrs, text) {
    const e = dom.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text != null) e.textContent = String(text);
    return e;
  }
  function yScale(ext) {
    const h = H - M.top - M.bottom;
    return (v) => M.top + h - (v - ext.min) / (ext.max - ext.min) * h;
  }
  function axes(svg, dom, ext, cats) {
    const y0 = yScale(ext)(ext.min < 0 ? 0 : ext.min);
    const ys = yScale(ext);
    for (let k = 0; k <= 4; k++) {
      const v = ext.min + (ext.max - ext.min) * k / 4;
      const y = ys(v);
      svg.appendChild(svgEl(dom, "line", { x1: M.left, y1: y, x2: W - M.right, y2: y, stroke: "#eaecef" }));
      svg.appendChild(svgEl(dom, "text", { x: M.left - 8, y: y + 4, "text-anchor": "end", "font-size": 11, fill: "#6e7781" }, fmt(v)));
    }
    const bw = (W - M.left - M.right) / cats.length;
    cats.forEach((c, i) => {
      svg.appendChild(svgEl(dom, "text", { x: M.left + bw * (i + 0.5), y: H - M.bottom + 18, "text-anchor": "middle", "font-size": 11, fill: "#6e7781" }, c));
    });
    svg.appendChild(svgEl(dom, "line", { x1: M.left, y1: y0, x2: W - M.right, y2: y0, stroke: "#afb8c1" }));
  }
  function fmt(v) {
    return Math.abs(v) >= 1e3 ? v.toFixed(0) : String(Math.round(v * 100) / 100);
  }
  function drawBars(svg, dom, t) {
    const ext = extent(t);
    axes(svg, dom, ext, t.cats);
    const ys = yScale(ext);
    const groupW = (W - M.left - M.right) / t.cats.length;
    const barW = groupW * 0.7 / t.series.length;
    const base = ys(ext.min < 0 ? 0 : ext.min);
    t.cats.forEach((c, ci) => {
      t.series.forEach((s, si) => {
        const v = t.get(s, ci);
        if (typeof v !== "number") return;
        const x = M.left + groupW * ci + groupW * 0.15 + barW * si;
        const y = ys(v);
        svg.appendChild(svgEl(dom, "rect", { x, y: Math.min(y, base), width: barW, height: Math.abs(base - y), fill: PALETTE2[si % PALETTE2.length], rx: 2 }));
      });
    });
  }
  function drawLines(svg, dom, t, fill) {
    const ext = extent(t);
    axes(svg, dom, ext, t.cats);
    const ys = yScale(ext);
    const groupW = (W - M.left - M.right) / t.cats.length;
    const xAt = (ci) => M.left + groupW * (ci + 0.5);
    const base = ys(ext.min < 0 ? 0 : ext.min);
    t.series.forEach((s, si) => {
      const pts = [];
      t.cats.forEach((c, ci) => {
        const v = t.get(s, ci);
        if (typeof v === "number") pts.push([xAt(ci), ys(v)]);
      });
      if (!pts.length) return;
      const color = PALETTE2[si % PALETTE2.length];
      if (fill) {
        const d = `M${pts[0][0]},${base} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length - 1][0]},${base} Z`;
        svg.appendChild(svgEl(dom, "path", { d, fill: color, "fill-opacity": 0.15 }));
      }
      svg.appendChild(svgEl(dom, "path", { d: "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L"), fill: "none", stroke: color, "stroke-width": 2 }));
      pts.forEach((p) => svg.appendChild(svgEl(dom, "circle", { cx: p[0], cy: p[1], r: 3, fill: color })));
    });
  }
  function drawScatter(svg, dom, model, t) {
    const xs = t.cats.map((c) => parseFloat(c));
    const xmin = Math.min(...xs), xmax = Math.max(...xs) || xmin + 1;
    const ext = extent(t);
    axes(svg, dom, ext, t.cats);
    const ys = yScale(ext);
    const w = W - M.left - M.right;
    const xAt = (v) => M.left + (v - xmin) / (xmax - xmin || 1) * w;
    const s = t.series[0];
    const sizes = model.size ? model.dataset.numbers[model.size] : null;
    const smax = sizes ? Math.max(...sizes.filter((n) => typeof n === "number")) || 1 : 1;
    t.cats.forEach((c, ci) => {
      const v = t.get(s, ci);
      if (typeof v !== "number" || !Number.isFinite(xs[ci])) return;
      const r = sizes ? 3 + sizes[ci] / smax * 12 : 4;
      svg.appendChild(svgEl(dom, "circle", { cx: xAt(xs[ci]), cy: ys(v), r, fill: PALETTE2[0], "fill-opacity": 0.6 }));
    });
  }
  function drawPie(svg, dom, t) {
    const s = t.series[0];
    const vals = t.cats.map((c, i) => Math.max(0, t.get(s, i) || 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 30;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + v / total * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
      svg.appendChild(svgEl(dom, "path", { d, fill: PALETTE2[i % PALETTE2.length] }));
      a0 = a1;
    });
  }
  function legend2(dom, names) {
    const div = dom.createElement("div");
    div.className = "geml-chart-legend";
    names.forEach((n, i) => {
      const span = dom.createElement("span");
      const sw = dom.createElement("i");
      sw.style.background = PALETTE2[i % PALETTE2.length];
      span.appendChild(sw);
      span.appendChild(dom.createTextNode(n));
      div.appendChild(span);
    });
    return div;
  }

  // src/render.js
  function renderDocument(model, dom) {
    const root = dom.createElement("div");
    const diag = renderDiagnostics(model.diagnostics || [], dom);
    if (diag) root.appendChild(diag);
    const docEl = dom.createElement("div");
    docEl.className = "geml-doc";
    const labels = collectLabels(model.children);
    for (const b of model.children) {
      const node = renderBlock(b, dom, labels);
      if (node) docEl.appendChild(node);
    }
    root.appendChild(docEl);
    return root;
  }
  function viewerDiagnostics(diags) {
    return (diags || []).filter(
      (d) => !(d.severity === "warning" && /no document resolver/.test(d.message))
    );
  }
  function collectLabels(children) {
    const labels = /* @__PURE__ */ new Map();
    for (const b of children || []) {
      if (b.kind === "heading" && b.id) labels.set(b.id, b.text);
      else if (b.kind === "block" && b.id) {
        const cap = b.attrs && typeof b.attrs.caption === "string" ? b.attrs.caption : b.id;
        labels.set(b.id, cap);
      }
    }
    return labels;
  }
  function el(dom, tag, props, children) {
    const e = dom.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === void 0 || v === null) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, String(v));
    }
    if (children) {
      for (const c of children) if (c != null) e.appendChild(c);
    }
    return e;
  }
  function renderInlines(inlines, dom, labels) {
    const frag = dom.createDocumentFragment();
    for (const n of inlines || []) frag.appendChild(renderInline(n, dom, labels));
    return frag;
  }
  function renderInline(n, dom, labels) {
    switch (n.type) {
      case "text":
        return dom.createTextNode(n.value);
      case "emph":
        return el(dom, "em", null, [renderInlines(n.children, dom, labels)]);
      case "strong":
        return el(dom, "strong", null, [renderInlines(n.children, dom, labels)]);
      case "strike":
        return el(dom, "del", null, [renderInlines(n.children, dom, labels)]);
      case "code":
        return el(dom, "code", { text: n.value });
      case "break":
        return dom.createElement("br");
      case "math": {
        return el(dom, "span", { class: "geml-math", "data-tex": n.value, text: n.value });
      }
      case "image":
        return renderMedia(n, dom);
      case "link": {
        const a = el(dom, "a", linkAttrs(n), [renderInlines(n.children, dom, labels)]);
        return a;
      }
      case "autoref": {
        const href = n.doc ? `${n.doc}${n.anchor ? "#" + n.anchor : ""}` : `#${n.anchor}`;
        const text = !n.doc && labels.has(n.anchor) ? labels.get(n.anchor) : n.anchor || n.doc || "";
        return el(dom, "a", { href, class: "geml-autoref" }, [dom.createTextNode(text)]);
      }
      case "footnote":
        return el(dom, "sup", null, [el(dom, "a", { href: `#fn-${n.ref}` }, [dom.createTextNode(`[${n.ref}]`)])]);
      default:
        return dom.createTextNode("");
    }
  }
  function linkAttrs(n) {
    const a = {};
    if (n.href) a.href = n.href;
    else if (n.anchor && !n.doc) a.href = `#${n.anchor}`;
    else if (n.doc) a.href = `${n.doc}${n.anchor ? "#" + n.anchor : ""}`;
    const at = n.attrs || {};
    if (at.target) a.target = at.target;
    if (at.rel) a.rel = at.rel;
    return a;
  }
  function renderMedia(n, dom) {
    const kind = n.as || inferKind(n.src);
    if (kind === "audio") return el(dom, "audio", { controls: "", src: n.src });
    if (kind === "video") return el(dom, "video", { controls: "", src: n.src, style: "max-width:100%" });
    return el(dom, "img", { src: n.src, alt: n.alt || "", style: "max-width:100%" });
  }
  function inferKind(src) {
    if (/\.(mp4|webm|mov|m4v|ogv|mkv)(?:[?#]|$)/i.test(src)) return "video";
    if (/\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)(?:[?#]|$)/i.test(src)) return "audio";
    return "image";
  }
  function renderBlock(b, dom, labels) {
    switch (b.kind) {
      case "heading": {
        const h = el(dom, `h${Math.min(6, b.level)}`, { id: b.id }, [renderInlines(b.inlines, dom, labels)]);
        return h;
      }
      case "paragraph":
        return el(dom, "p", null, [renderInlines(b.inlines, dom, labels)]);
      case "list": {
        const list = el(
          dom,
          b.ordered ? "ol" : "ul",
          null,
          (b.items || []).map((it) => el(dom, "li", null, [renderInlines(it.inlines, dom, labels)]))
        );
        return list;
      }
      case "block":
        return renderTyped(b, dom, labels);
      default:
        return null;
    }
  }
  function renderTyped(b, dom, labels) {
    const type = b.type;
    if (type === "meta") return null;
    if (type === "table" && b.table) return renderTable(b.table, dom, labels, b.id);
    if (type === "note" || type === "aside") {
      const q = el(dom, "blockquote", { class: "geml-note", id: b.id });
      for (const c of b.children || []) {
        const n = renderBlock(c, dom, labels);
        if (n) q.appendChild(n);
      }
      return q;
    }
    if (type === "math") {
      return el(dom, "div", { class: "geml-block", id: b.id }, [
        el(dom, "div", { class: "geml-math-display", "data-tex": (b.raw || []).join("\n"), text: (b.raw || []).join("\n") })
      ]);
    }
    if (type === "diagram") {
      const fmt2 = b.attrs && typeof b.attrs.format === "string" ? b.attrs.format : "";
      if (fmt2 === "geml-chart") {
        if (b.chart) return el(dom, "div", { class: "geml-chart", id: b.id }, [renderChart(b.chart, dom)]);
        return rawBlock(b, dom, "geml-chart (unresolved)");
      }
      if (fmt2 === "mermaid") {
        const wrap = el(dom, "div", { class: "geml-block geml-diagram", id: b.id });
        wrap.appendChild(el(dom, "div", { class: "geml-mermaid", text: (b.raw || []).join("\n") }));
        return wrap;
      }
      return rawBlock(b, dom, fmt2 || "diagram");
    }
    if (type === "code") {
      const lang = b.attrs && typeof b.attrs.lang === "string" ? b.attrs.lang : "";
      return rawBlock(b, dom, lang ? `code ${lang}` : "code");
    }
    return rawBlock(b, dom, type);
  }
  function rawBlock(b, dom, tag) {
    const wrap = el(dom, "div", { class: "geml-block", id: b.id });
    wrap.appendChild(el(dom, "span", { class: "geml-tag", text: tag }));
    wrap.appendChild(el(dom, "pre", null, [el(dom, "code", { text: (b.raw || []).join("\n") })]));
    return wrap;
  }
  function renderTable(model, dom, labels, id) {
    if (model.src !== void 0) {
      return el(dom, "div", { class: "geml-block", id }, [
        el(dom, "span", { class: "geml-tag", text: "table \xB7 src" }),
        el(dom, "p", { text: `Data not loaded from ${model.src}` })
      ]);
    }
    const table = el(dom, "table", { id });
    if (model.caption) table.appendChild(el(dom, "caption", { text: model.caption }));
    if (model.header) {
      const thead = el(dom, "thead");
      const tr = el(dom, "tr");
      for (const name of model.columns) tr.appendChild(el(dom, "th", null, [dom.createTextNode(name)]));
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    const tbody = el(dom, "tbody");
    const covered = /* @__PURE__ */ new Set();
    const rows = model.rows || [];
    rows.forEach((row, r) => tbody.appendChild(renderRow(row, r, model, dom, labels, covered, false)));
    if (model.summary) tbody.appendChild(renderRow(model.summary, rows.length, model, dom, labels, covered, true));
    table.appendChild(tbody);
    return table;
  }
  function renderRow(row, r, model, dom, labels, covered, isSummary) {
    const tr = el(dom, "tr", isSummary ? { class: "geml-summary" } : null);
    for (let c = 0; c < model.columns.length; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = row[c];
      const td = el(dom, "td");
      if (cell) {
        if (cell.inlines && cell.inlines.length) td.appendChild(renderInlines(cell.inlines, dom, labels));
        else td.textContent = cell.text || "";
        const align = cell.align || model.align[c];
        if (typeof cell.value === "number" || align === "right") td.className = "geml-num";
        else if (align === "center") td.style.textAlign = "center";
        if (cell.computed) td.className = (td.className ? td.className + " " : "") + "geml-computed";
        if (cell.span && (cell.span.rows > 1 || cell.span.cols > 1)) applySpan(td, cell.span, r, c, covered);
      }
      tr.appendChild(td);
    }
    return tr;
  }
  function applySpan(td, span, r, c, covered) {
    if (span.cols > 1) td.setAttribute("colspan", String(span.cols));
    if (span.rows > 1) td.setAttribute("rowspan", String(span.rows));
    for (let dr = 0; dr < span.rows; dr++)
      for (let dc = 0; dc < span.cols; dc++)
        if (dr || dc) covered.add(`${r + dr},${c + dc}`);
  }
  function renderDiagnostics(diags, dom) {
    const errs = diags.filter((d) => d.severity === "error");
    const warns = diags.filter((d) => d.severity === "warning");
    if (!errs.length && !warns.length) return null;
    const wrap = dom.createDocumentFragment();
    if (errs.length) wrap.appendChild(diagBox(errs, "error", dom));
    if (warns.length) wrap.appendChild(diagBox(warns, "warn", dom));
    return wrap;
  }
  function diagBox(items, kind, dom) {
    const box = el(dom, "div", { class: `geml-diag geml-diag-${kind}` });
    box.appendChild(el(dom, "strong", { text: `${items.length} ${kind === "error" ? "error" : "warning"}${items.length > 1 ? "s" : ""}` }));
    const ul = el(dom, "ul");
    for (const d of items) ul.appendChild(el(dom, "li", { text: d.line ? `line ${d.line}: ${d.message}` : d.message }));
    box.appendChild(ul);
    return box;
  }

  // src/geml.css
  var geml_default = '/* GEML Viewer \u2014 document styling. Scoped under .geml-doc so it never leaks. */\r\n\r\n.geml-body {\r\n  margin: 0;\r\n  background: #fbfbfa;\r\n  color: #1f2328;\r\n  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;\r\n}\r\n\r\n.geml-doc {\r\n  max-width: 860px;\r\n  margin: 0 auto;\r\n  padding: 48px 24px 96px;\r\n}\r\n\r\n.geml-doc h1, .geml-doc h2, .geml-doc h3,\r\n.geml-doc h4, .geml-doc h5, .geml-doc h6 {\r\n  line-height: 1.25;\r\n  margin: 1.8em 0 0.6em;\r\n  font-weight: 600;\r\n}\r\n.geml-doc h1 { font-size: 2em; margin-top: 0; }\r\n.geml-doc h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid #e6e6e3; }\r\n.geml-doc h3 { font-size: 1.25em; }\r\n.geml-doc h4 { font-size: 1.05em; }\r\n\r\n.geml-doc p { margin: 0 0 1em; }\r\n.geml-doc a { color: #0969da; text-decoration: none; }\r\n.geml-doc a:hover { text-decoration: underline; }\r\n.geml-doc a.geml-broken { color: #cf222e; text-decoration: underline wavy; }\r\n\r\n.geml-doc em { font-style: italic; }\r\n.geml-doc strong { font-weight: 600; }\r\n.geml-doc del { color: #6e7781; }\r\n\r\n.geml-doc code {\r\n  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;\r\n  font-size: 0.9em;\r\n  background: #eff1f3;\r\n  border-radius: 4px;\r\n  padding: 0.15em 0.4em;\r\n}\r\n\r\n.geml-doc pre {\r\n  background: #f6f8fa;\r\n  border: 1px solid #e6e6e3;\r\n  border-radius: 8px;\r\n  padding: 14px 16px;\r\n  overflow-x: auto;\r\n  line-height: 1.5;\r\n}\r\n.geml-doc pre code { background: none; padding: 0; font-size: 0.875em; }\r\n\r\n/* code/diagram block with a small type tag in the corner */\r\n.geml-block { position: relative; margin: 0 0 1.2em; }\r\n.geml-tag {\r\n  position: absolute; top: 8px; right: 10px;\r\n  font: 11px/1 ui-monospace, monospace;\r\n  color: #6e7781; background: #fff; border: 1px solid #e6e6e3;\r\n  border-radius: 4px; padding: 2px 6px; user-select: none;\r\n}\r\n\r\n.geml-doc ul, .geml-doc ol { margin: 0 0 1em; padding-left: 1.6em; }\r\n.geml-doc li { margin: 0.2em 0; }\r\n\r\n.geml-doc blockquote.geml-note {\r\n  margin: 0 0 1.2em; padding: 0.5em 1em;\r\n  border-left: 4px solid #0969da; background: #f3f7fd; border-radius: 0 6px 6px 0;\r\n}\r\n.geml-doc blockquote.geml-note > :last-child { margin-bottom: 0; }\r\n\r\n/* Tables */\r\n.geml-doc table { border-collapse: collapse; margin: 0 0 1.2em; font-size: 0.95em; width: auto; }\r\n.geml-doc caption { caption-side: top; text-align: left; color: #6e7781; padding-bottom: 6px; font-size: 0.9em; }\r\n.geml-doc th, .geml-doc td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }\r\n.geml-doc thead th { background: #f6f8fa; }\r\n.geml-doc td.geml-num { text-align: right; font-variant-numeric: tabular-nums; }\r\n.geml-doc td.geml-computed { background: #f3fbf4; }\r\n.geml-doc tr.geml-summary td { font-weight: 600; border-top: 2px solid #afb8c1; background: #fafbfc; }\r\n\r\n/* Charts (geml-chart) and diagrams */\r\n.geml-chart, .geml-diagram { margin: 0 0 1.4em; text-align: center; }\r\n.geml-chart svg { max-width: 100%; height: auto; }\r\n.geml-chart-legend { font-size: 0.85em; color: #57606a; margin-top: 6px; }\r\n.geml-chart-legend span { margin: 0 8px; }\r\n.geml-chart-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }\r\n\r\n/* Diagnostics banner */\r\n.geml-diag {\r\n  max-width: 860px; margin: 0 auto 12px; padding: 10px 14px;\r\n  border-radius: 8px; font-size: 0.9em;\r\n}\r\n.geml-diag-error { background: #fff0ef; border: 1px solid #ffcecb; color: #82071e; }\r\n.geml-diag-warn { background: #fff8c5; border: 1px solid #f0e3a1; color: #6b5e16; }\r\n.geml-diag ul { margin: 6px 0 0; padding-left: 1.4em; }\r\n.geml-diag code { background: rgba(0,0,0,0.05); }\r\n\r\n.katex-display { overflow-x: auto; overflow-y: hidden; }\r\n';

  // ../playground/entry.js
  globalThis.GEML = { parse, renderDocument, viewerDiagnostics, css: geml_default };
})();
