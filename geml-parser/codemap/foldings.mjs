// foldings.geml — the visible, human-owned config for codemap ceremony folding.
// GEML (dogfooded; the viewer renders it): a meta header, three bullet-list
// sections (fold-prefixes / source-roots / test-roots) and an options section.
// Read via the bundled parser; group-id shared-prefix stripping stays
// algorithmic (only its on/off toggle lives here).
import { parse } from "../dist/geml.js";

const SECTIONS = { "fold-prefixes": "foldPrefixes", "source-roots": "sourceRoots", "test-roots": "testRoots" };
// Plain text of a bullet-list item. GEML list items carry `.text`; fall back to
// joining inline `.value`s if a build ever changes that shape.
const itemText = (it) => (typeof it.text === "string" ? it.text : (it.inlines ?? []).map((n) => n.value ?? "").join("")).trim();

export function parseFoldings(text) {
  const cfg = { foldPrefixes: [], sourceRoots: [], testRoots: [], stripSharedPrefix: true };
  const doc = parse(text);
  let section = null;
  for (const b of doc.children) {
    if (b.kind === "heading") { section = b.text.trim().toLowerCase(); continue; }
    if (b.kind !== "list") continue;
    const items = b.items.map(itemText).filter(Boolean);
    if (SECTIONS[section]) cfg[SECTIONS[section]] = items;
    else if (section === "options") {
      for (const it of items) {
        const m = it.match(/^strip-shared-prefix\s*:\s*(on|off|true|false)$/i);
        if (m) cfg.stripSharedPrefix = /^(on|true)$/i.test(m[1]);
      }
    }
  }
  return cfg;
}

export function serializeFoldings(cfg) {
  const list = (xs) => xs.map((x) => `- ${x}`).join("\n");
  return [
    "=== meta",
    'title = "codemap foldings"',
    "===",
    "",
    "Ceremony folded out of module display names. Seeded on first build; edit",
    "freely — build never rewrites this. The shared package prefix (group-ids",
    "like com/acme/app) is stripped automatically and needs no entry here; set",
    "strip-shared-prefix to off under Options to disable it.",
    "",
    "## fold-prefixes",
    "",
    list(cfg.foldPrefixes),
    "",
    "## source-roots",
    "",
    list(cfg.sourceRoots),
    "",
    "## test-roots",
    "",
    list(cfg.testRoots),
    "",
    "## options",
    "",
    `- strip-shared-prefix: ${cfg.stripSharedPrefix ? "on" : "off"}`,
    "",
  ].join("\n");
}
