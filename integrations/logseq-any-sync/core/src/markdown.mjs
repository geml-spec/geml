// The vault, one way, as Markdown: a folder a Markdown tool (Logseq's file
// version among them) can open. Lossy by design — data blocks and the fields
// GEML keeps on comment lines have no Markdown shape — and never read back:
// the `.geml` tree is the one that syncs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, gemlToMd } from "@geml/geml";
import { atomicWrite } from "./vault.mjs";

/** Write `<outDir>/<page>.md` for each vault-relative `.geml` path given. */
export function exportMarkdown(vault, outDir, files) {
  const written = [];
  for (const rel of files) {
    if (!rel.endsWith(".geml")) continue;
    const text = readFileSync(join(vault, rel), "utf8");
    // The `#object` envelope is the app's bookkeeping, not page content.
    const body = text.replace(/^=== data \{#object \.object format=json\}\n[\s\S]*?\n===\n\n?/, "");
    const { md } = gemlToMd(parse(body));
    const out = rel.replace(/^pages\//, "").replace(/\.geml$/, ".md");
    atomicWrite(join(outDir, out), md);
    written.push(out);
  }
  return written;
}
