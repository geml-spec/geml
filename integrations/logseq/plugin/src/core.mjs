// Plugin-side logic for Sync Vault with GEML, kept free of @logseq/libs so the tests can
// hand in a plain object where the `logseq` global would be. The plugin never
// touches the sync directory and never runs git — the 2.0 sandbox has no
// arbitrary-path fs and no exec API, and the design leans into that: all this
// side does is signal "the graph changed" and read back what the watcher did.
//
// The channel between the two sides is the plugin's own storage directory
// (<dotdir>/storages/<plugin-id>/), the one disk location both can reach:
// the plugin writes SIGNAL_FILE through logseq.FileStorage, the external
// `logseq-sync --watch --signal` process watches it and writes STATUS_FILE back.

export { SIGNAL_FILE, STATUS_FILE } from "../../core/src/bridge.mjs";
import { SIGNAL_FILE } from "../../core/src/bridge.mjs";

/**
 * Debounced change signaller.
 *
 * @param {object} opts
 * @param {object} opts.logseq The `logseq` plugin global (or a test double).
 * @param {number} [opts.debounceMs] Quiet period after the last DB change.
 * @param {function} [opts.schedule] setTimeout stand-in for tests.
 * @param {function} [opts.cancel] clearTimeout stand-in for tests.
 * @param {function} [opts.now] Clock, for tests.
 */
export function createSyncSignaler({
  logseq,
  debounceMs = 5000,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t),
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let disposed = false;
  let unsubscribe = null;
  const state = {
    changesSeen: 0,
    signalsWritten: 0,
    lastSignalAt: null,
    lastError: null,
  };

  async function flush() {
    timer = null;
    if (disposed) return;
    try {
      await logseq.FileStorage.setItem(
        SIGNAL_FILE,
        JSON.stringify({ at: now(), changesSeen: state.changesSeen })
      );
      state.signalsWritten++;
      state.lastSignalAt = now();
      state.lastError = null;
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
    }
  }

  function onChange() {
    if (disposed) return;
    state.changesSeen++;
    if (timer !== null) cancel(timer);
    timer = schedule(flush, debounceMs);
  }

  return {
    state,
    flush,
    setDebounce(ms) {
      debounceMs = ms;
    },
    start() {
      const off = logseq.DB.onChanged(onChange);
      unsubscribe = typeof off === "function" ? off : null;
    },
    stop() {
      disposed = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {}
      }
    },
  };
}

/**
 * Render the watcher's status file for logseq.UI.showMsg.
 * @param {string|null} raw Contents of STATUS_FILE, or null when absent.
 */
// The watcher records an ISO instant, which is the right thing to store and
// the wrong thing to show. Anything that will not parse is passed through
// untouched — better the raw value than "Invalid Date".
function clockTime(at) {
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? String(at) : t.toLocaleTimeString();
}

export function formatStatus(raw) {
  if (!raw) {
    return "Sync Vault with GEML: no watcher status yet — is `logseq-sync --watch --signal …` running?";
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return "Sync Vault with GEML: status file is not valid JSON.";
  }
  if (s.ok === false) {
    return `Sync Vault with GEML: last sync FAILED at ${clockTime(s.at)} — ${s.error}`;
  }
  const parts = [`${s.written ?? 0} written`, `${s.unchanged ?? 0} unchanged`];
  if (s.imported) parts.unshift(`${s.imported} imported`);
  if (s.orphaned) parts.push(`${s.orphaned} orphaned`);
  if (s.deleted) parts.push(`${s.deleted} deleted`);
  const conflicts =
    Array.isArray(s.conflicts) && s.conflicts.length > 0
      ? ` ⚠ ${s.conflicts.length} conflict(s) need a hand: ${s.conflicts.join(", ")}`
      : "";
  // Files the sync refused to overwrite because it never wrote them. The
  // watcher has always recorded these; nothing read them, so the only place a
  // held file was visible was a terminal — and the person who edited a page is
  // the one looking at this toolbar, not at that terminal.
  const held =
    Array.isArray(s.held) && s.held.length > 0
      ? ` ✋ ${s.held.length} file(s) left as you wrote them, not overwritten: ${s.held.join(", ")}`
      : "";
  // The other half of the same choice. The person who edited the page is
  // looking at this line, and "your edit is gone" is the one thing it must not
  // leave to a terminal.
  const overwritten =
    Array.isArray(s.overwritten) && s.overwritten.length > 0
      ? ` ⚠ ${s.overwritten.length} edit(s) REPLACED with the graph's version: ${s.overwritten.join(", ")}`
      : "";
  return `Sync Vault with GEML: last sync at ${clockTime(s.at)} — ${parts.join(", ")}.${conflicts}${held}${overwritten}`;
}
