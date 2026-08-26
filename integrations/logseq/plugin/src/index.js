// GEML Sync — Logseq 2.0 plugin entry.
// A change signal and a status light; the sync itself lives in the external
// `geml-sync --watch --signal` watcher (see ../../bin/geml-sync.mjs).
import "@logseq/libs";
import { createSyncSignaler, formatStatus, STATUS_FILE } from "./core.mjs";

const SETTINGS = [
  {
    key: "debounceSeconds",
    type: "number",
    default: 5,
    title: "Debounce (seconds)",
    description:
      "Quiet period after the last graph change before the watcher is signalled.",
  },
];

function debounceMsFrom(settings) {
  const n = Number(settings && settings.debounceSeconds);
  return Math.max(1, Number.isFinite(n) && n > 0 ? n : 5) * 1000;
}

async function main() {
  logseq.useSettingsSchema(SETTINGS);

  const signaler = createSyncSignaler({
    logseq,
    debounceMs: debounceMsFrom(logseq.settings),
  });
  signaler.start();

  logseq.onSettingsChanged((updated) => {
    signaler.setDebounce(debounceMsFrom(updated));
  });

  async function showStatus() {
    let raw = null;
    try {
      raw = await logseq.FileStorage.getItem(STATUS_FILE);
    } catch {}
    logseq.UI.showMsg(formatStatus(raw), "info", { timeout: 8000 });
  }

  logseq.provideModel({ gemlSyncStatus: showStatus });

  logseq.App.registerCommandPalette(
    { key: "geml-sync-status", label: "GEML Sync: show last sync status" },
    showStatus
  );

  // A text glyph, not an image: the toolbar template is HTML injected into the
  // host, and system glyphs need no asset loading (same lesson as the viewer's
  // CSP: no resources a host might refuse).
  logseq.App.registerUIItem("toolbar", {
    key: "geml-sync-status",
    template: `<a data-on-click="gemlSyncStatus" class="button" title="GEML Sync status" style="font-size:16px">⇄</a>`,
  });

  logseq.beforeunload(async () => {
    signaler.stop();
  });
}

logseq.ready(main).catch(console.error);
