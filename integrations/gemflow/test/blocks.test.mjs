import { test } from "node:test";
import assert from "node:assert/strict";
import { blockText } from "../dist/core/blocks.js";

const GUIDE = '=== meta\ntitle = "Guide"\n===\n\n# Build {#build}\n\nRun npm test before you push.\n\n=== note {#careful}\nNever force-push.\n===\n\n# Ship {#ship}\n\nDeploy.\n';

test("blockText reads a GEML heading's section and a typed block whole, as geml get prints them", () => {
  assert.equal(blockText(GUIDE, "build"), "# Build {#build}\n\nRun npm test before you push.\n\n=== note {#careful}\nNever force-push.\n===");
  assert.equal(blockText(GUIDE, "careful"), "=== note {#careful}\nNever force-push.\n===");
  assert.equal(blockText(GUIDE, "ship"), "# Ship {#ship}\n\nDeploy.");
  assert.equal(blockText(GUIDE, "nope"), undefined);
});

test("blockText reads a Markdown section by its heading's id, GitHub's suffix for a repeated heading included", () => {
  const md = "# Contributing\n\n## Testing\n\nRun npm test.\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond\n";
  assert.equal(blockText(md, "testing", { markdown: true }), "## Testing\n\nRun npm test.");
  assert.equal(blockText(md, "notes", { markdown: true }), "## Notes\n\nfirst");
  assert.equal(blockText(md, "notes-1", { markdown: true }), "## Notes\n\nsecond");
  assert.equal(blockText(md, "notes-1"), undefined, "read as GEML, a repeated heading gets no suffix");
});

test("blockText answers with LF line ends whatever the file was written with", () => {
  const crlf = GUIDE.replace(/\n/g, "\r\n");
  assert.equal(blockText(crlf, "ship"), "# Ship {#ship}\n\nDeploy.");
  assert.equal(blockText("## Testing\r\n\r\nRun npm test.\r\n", "testing", { markdown: true }), "## Testing\n\nRun npm test.");
});

test("blockText compares ids as the parser does: the same name in either Unicode normal form", () => {
  const src = "# Café {#café}\n\nCoffee.\n";
  assert.equal(blockText(src, "café"), "# Café {#café}\n\nCoffee.");
});
