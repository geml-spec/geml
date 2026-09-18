// The ledger, as Pi's session tree tells it.
//
// Design 5.4: on Pi every ledger block is written twice - to the `.geml` file
// (the audit artifact, identical to what DSH writes) and to a custom session
// entry (the recovery source). The entry carries the block's RENDERED TEXT, not
// a parsed object, which buys three things:
//
//   * the concatenation of a branch's entries is byte-for-byte the ledger file,
//     so one `readLedger` serves both and there is no second reader to drift;
//   * the very first entry carries the ledger head, so a forked session
//     inherits the ORIGINAL `statechart-hash` and the "statechart changed"
//     check still works across a fork;
//   * an entry is opaque to Pi - `appendEntry` data is not sent to the model
//     (its own docs), so the chain costs no context.
//
// Nothing here touches the file system or Pi's API: it is text in, text out.
export const SNAPSHOT_ENTRY = "geml-agent/snapshot";

/** What one of our entries holds: exactly the bytes that went into the file. */
export interface SnapshotEntryData {
  block: string;
}

/**
 * As much of a session entry as this module needs. Structural on purpose - the
 * real type is Pi's `SessionEntry` union, and matching it by shape keeps this
 * file free of a host import.
 */
export interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

function blockOf(entry: BranchEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== SNAPSHOT_ENTRY) return undefined;
  const data = entry.data;
  if (typeof data !== "object" || data === null) return undefined;
  const block = (data as { block?: unknown }).block;
  return typeof block === "string" ? block : undefined;
}

/**
 * The ledger this branch describes, or null when the branch carries none.
 *
 * Order is the branch's order, oldest first, which is the order the blocks were
 * appended in. `resumeRun` sorts by revision anyway and `verifyLedger` is what
 * notices if the two ever disagree.
 */
export function ledgerFromEntries(entries: readonly BranchEntry[]): string | null {
  const blocks: string[] = [];
  for (const entry of entries) {
    const block = blockOf(entry);
    if (block !== undefined) blocks.push(block);
  }
  return blocks.length ? blocks.join("") : null;
}
