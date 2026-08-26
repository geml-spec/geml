// Sync Vault with GEML — Logseq 2.0 plugin entry.
// A change signal and a status light; the sync itself lives in the external
// `geml-sync --watch --signal` watcher (see ../../watcher/bin/geml-sync.mjs).
import "@logseq/libs";
import { createSyncSignaler, formatStatus, STATUS_FILE } from "./core.mjs";

const SETTINGS = [
  {
    // Read off disk by the watcher (<dotdir>/settings/<plugin-id>.json), so
    // `geml-sync` needs no arguments: the destination is configured here, in
    // the place the user is already looking.
    key: "vaultPath",
    type: "string",
    default: "",
    title: "Vault folder",
    description:
      "Any folder to keep the vault in, e.g. ~/logseq-vault — it is created if " +
      "missing, and restore reads it back from there. Left empty, geml-sync " +
      "has no default and asks you for one on the command line.",
  },
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
    { key: "sync-vault-with-geml-status", label: "Sync Vault with GEML: show last sync status" },
    showStatus
  );

  // A text glyph, not an image: the toolbar template is HTML injected into the
  // host, and system glyphs need no asset loading (same lesson as the viewer's
  // CSP: no resources a host might refuse).
  logseq.App.registerUIItem("toolbar", {
    key: "sync-vault-with-geml-status",
    template: `<a data-on-click="gemlSyncStatus" class="button" title="Sync Vault with GEML status" style="font-size:16px">⇄</a>`,
  });

  logseq.beforeunload(async () => {
    signaler.stop();
  });
}

logseq.ready(main).catch(console.error);
