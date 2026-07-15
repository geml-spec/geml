// foldings.geml — the visible, human-owned config for codemap ceremony folding.
// GEML (dogfooded; the viewer renders it): a meta header, three bullet-list
// sections (fold-prefixes / source-roots / test-roots) and an options section.
// Read via the bundled parser; group-id shared-prefix stripping stays
// algorithmic (only its on/off toggle lives here).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../dist/geml.js";
import { deriveFoldLayers, DEFAULT_SOURCE_ROOTS, DEFAULT_TEST_ROOTS, LANG_FOLD_PREFIXES } from "./normalize.mjs";

const SECTIONS = { "fold-prefixes": "foldPrefixes", "source-roots": "sourceRoots", "test-roots": "testRoots" };
// Plain text of a bullet-list item. GEML list items carry `.text`; fall back to
// joining inline `.value`s if a build ever changes that shape.
const itemText = (it) => (typeof it.text === "string" ? it.text : (it.inlines ?? []).map((n) => n.value ?? "").join("")).trim();

export function parseFoldings(text) {
  const doc = parse(text);
  // A malformed hand-edit must fail LOUDLY, not silently drop every rule: the
  // caller (loadOrSeedFoldings) catches this and falls back to the defaults.
  // An intentionally empty file carries NO error diagnostics and yields empty
  // sections — the "fold nothing" off-switch, a deliberately different outcome.
  const errs = doc.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) throw new Error(`invalid GEML in foldings config: ${errs[0].message} (line ${errs[0].line})`);
  const cfg = { foldPrefixes: [], sourceRoots: [], testRoots: [], stripSharedPrefix: true };
  let section = null;
  for (const b of doc.children) {
    if (b.kind === "heading") { section = b.text.trim().toLowerCase(); continue; }
    if (b.kind !== "list") continue;
    const items = b.items.map(itemText).filter(Boolean);
    if (Object.hasOwn(SECTIONS, section)) cfg[SECTIONS[section]] = items;
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

// Seeded config for a first build: structural fold-layers (above-root
// ceremony dirs, derived from the discovered module roots) unioned with
// known per-language ceremony (Cargo's `crates/`). Source/test roots always
// start from the same global defaults — the human edits foldings.geml from
// there; the build never rewrites it once it exists.
export function defaultFoldings({ moduleRoots, languages }) {
  const langPrefixes = (languages ?? []).flatMap((l) => LANG_FOLD_PREFIXES[l] ?? []);
  const foldPrefixes = [...new Set([...deriveFoldLayers(moduleRoots ?? []), ...langPrefixes])].sort();
  return { foldPrefixes, sourceRoots: [...DEFAULT_SOURCE_ROOTS], testRoots: [...DEFAULT_TEST_ROOTS], stripSharedPrefix: true };
}

// Read <outDir>/_index/foldings.geml, or seed it on first build. Write-once:
// an existing file is the human's — we read it and never rewrite it (the
// refresh.json contract). A missing or unreadable file never crashes the
// build: seed/fall back to defaults and say so. Returns { config, seeded }.
export function loadOrSeedFoldings({ outDir, moduleRoots, languages }) {
  const path = join(outDir, "_index", "foldings.geml");
  if (existsSync(path)) {
    try { return { config: parseFoldings(readFileSync(path, "utf8")), seeded: false }; }
    catch (e) {
      console.error(`warning: ignoring ${path} (${e.message}) — using default foldings; fix the file to re-enable your edits.`);
      return { config: defaultFoldings({ moduleRoots, languages }), seeded: false };
    }
  }
  const config = defaultFoldings({ moduleRoots, languages });
  try {
    mkdirSync(join(outDir, "_index"), { recursive: true });
    writeFileSync(path, serializeFoldings(config));
  } catch (e) { console.error(`warning: could not seed ${path} (${e.message}).`); }
  return { config, seeded: true };
}
