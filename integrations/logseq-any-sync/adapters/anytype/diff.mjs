// The Anytype API v2 PATCH operations that take an object's blocks from what
// Anytype holds (`from`) to what the vault holds (`to`).
//
// Blocks are AnyBlock's flat pre-order array with `indent`. A block in `to`
// whose id is in `from` is that block; any other block is new and is sent
// without an id (Anytype mints ids — a payload id it cannot resolve is
// refused). A new block has no id to be named by within the same request, so
// an operation that would need one as its anchor or parent waits for the next
// round, after the engine has read the minted ids back (`pending`).

const STRUCTURAL = new Set(["id", "gid", "indent"]);
// Blocks whose content is a subtree of its own: replaced whole rather than
// patched field by field.
const SUBTREE = new Set(["table", "dataview", "row", "column"]);

/** Each block's parent index (−1 at the top), from the indents. */
function parents(list) {
  const out = [];
  const stack = [];
  list.forEach((b, i) => {
    const d = b.indent ?? 0;
    while (stack.length && (list[stack[stack.length - 1]].indent ?? 0) >= d) stack.pop();
    out.push(stack.length ? stack[stack.length - 1] : -1);
    stack.push(i);
  });
  return out;
}

function lis(seq) {
  const tails = [];
  const prev = new Array(seq.length).fill(-1);
  for (let x = 0; x < seq.length; x++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[x]) lo = mid + 1; else hi = mid; }
    prev[x] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = x;
  }
  const out = new Set();
  for (let cur = tails.length ? tails[tails.length - 1] : -1; cur >= 0; cur = prev[cur]) out.add(cur);
  return out;
}

const payload = (b, baseIndent) => {
  const out = {};
  for (const [k, v] of Object.entries(b)) if (!STRUCTURAL.has(k)) out[k] = v;
  const rel = (b.indent ?? 0) - baseIndent;
  return rel ? { indent: rel, ...out } : out;
};

/** The fields of `to` that differ from `from`, absent ones as null. */
function changedFields(from, to) {
  const set = {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const k of keys) {
    if (STRUCTURAL.has(k)) continue;
    const a = JSON.stringify(from[k]), b = JSON.stringify(to[k]);
    if (a !== b) set[k] = k in to ? to[k] : null;
  }
  return set;
}

/**
 * @param {object[]} from the blocks Anytype holds
 * @param {object[]} to the blocks the vault holds
 * @returns {{ ops: object[], inserted: { op: number, gids: (string|undefined)[] }[], pending: boolean }}
 *   `inserted`: for each insert, its index in `ops` and the GEML ids of the
 *   blocks it creates, in order — to pair with the ids Anytype reports minting
 *   (`created_blocks["ops[i].blocks[j]"]`).
 */
export function patchOps(from, to) {
  const fromIdx = new Map(from.map((b, i) => [b.id, i]));
  const existing = (b) => b.id !== undefined && fromIdx.has(b.id);
  const fp = parents(from), tp = parents(to);
  const sameParent = (i) => {
    const p = tp[i];
    const want = p < 0 ? undefined : to[p].id;
    const had = fp[fromIdx.get(to[i].id)];
    return (had < 0 ? undefined : from[had].id) === want && (p < 0 || existing(to[p]));
  };

  // Existing blocks that keep their place: a longest run in Anytype's order,
  // among those that keep their parent too.
  const candidates = [];
  to.forEach((b, i) => { if (existing(b) && sameParent(i)) candidates.push(i); });
  const keep = new Set([...lis(candidates.map((i) => fromIdx.get(to[i].id)))].map((k) => candidates[k]));

  const ops = [];
  const inserted = [];
  let pending = false;

  // 1. Content.
  to.forEach((b) => {
    if (!existing(b)) return;
    const old = from[fromIdx.get(b.id)];
    if (SUBTREE.has(b.type) || SUBTREE.has(old.type)) {
      if (JSON.stringify(payload(old, old.indent ?? 0)) !== JSON.stringify(payload(b, b.indent ?? 0))) {
        ops.push({ op: "replace_subtree", id: b.id, blocks: [payload(b, b.indent ?? 0)] });
      }
      return;
    }
    const set = changedFields(old, b);
    if (Object.keys(set).length) ops.push({ op: "update_block", id: b.id, set });
  });

  // 2. Structure, walking the vault's order.
  const placed = new Set(); // indexes in `to` that exist in Anytype by the time an op runs
  const anchorFor = (i) => {
    // The previous sibling under the same parent, else the parent itself.
    for (let j = i - 1; j >= 0 && j > tp[i]; j--) {
      if (tp[j] === tp[i]) return placed.has(j) ? { after: to[j].id } : null;
    }
    if (tp[i] < 0) return { position: "first" };
    return placed.has(tp[i]) ? { inside: to[tp[i]].id, position: "first" } : null;
  };
  for (let i = 0; i < to.length; i++) {
    const b = to[i];
    if (existing(b)) {
      if (keep.has(i)) { placed.add(i); continue; }
      const anchor = anchorFor(i);
      if (!anchor) { pending = true; continue; }
      ops.push({ op: "move_block", id: b.id, ...anchor });
      placed.add(i);
      continue;
    }
    // A run of new blocks: this one and every following new block nested in
    // it or continuing it at its own level, sent as one insert.
    const anchor = anchorFor(i);
    let j = i + 1;
    const base = b.indent ?? 0;
    while (j < to.length && !existing(to[j]) && (to[j].indent ?? 0) >= base) j++;
    if (!anchor) { pending = true; i = j - 1; continue; }
    const run = to.slice(i, j);
    ops.push({ op: "insert_blocks", ...anchor, blocks: run.map((x) => payload(x, base)) });
    inserted.push({ op: ops.length - 1, gids: run.map((x) => x.gid) });
    i = j - 1;
  }

  // 3. Deletions last, so a block moved out from under a deleted parent is out
  //    of it by then. Deleting the topmost deleted block takes its subtree.
  //    A deletion that would take a block still waiting to be moved out waits too.
  const kept = new Set(to.filter(existing).map((b) => b.id));
  const placedIds = new Set([...placed].map((i) => to[i].id));
  const waitingUnder = (i) => {
    for (let k = i + 1; k < from.length && (from[k].indent ?? 0) > (from[i].indent ?? 0); k++) {
      if (kept.has(from[k].id) && !placedIds.has(from[k].id)) return true;
    }
    return false;
  };
  from.forEach((b, i) => {
    if (kept.has(b.id)) return;
    if (fp[i] >= 0 && !kept.has(from[fp[i]].id)) return; // its deleted parent takes it
    if (waitingUnder(i)) { pending = true; return; }
    ops.push({ op: "delete_block", id: b.id, recursive: true });
  });

  return { ops, inserted, pending };
}
