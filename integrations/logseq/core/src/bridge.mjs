// The contract between the two halves of Sync Vault with GEML. The in-app plugin
// writes SIGNAL_FILE through logseq.FileStorage; the watcher reacts to it and
// writes STATUS_FILE back beside it. Both land in the plugin's storage
// directory (<dotdir>/storages/<plugin-id>/) — the one disk location both
// sides can reach. These names ARE the protocol: change them only together.

export const SIGNAL_FILE = "geml-sync-dirty.json";
export const STATUS_FILE = "geml-sync-status.json";
