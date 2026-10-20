// What each work item made (the home's .geml/artifacts.geml `#artifacts`): the
// links it published, the documents it changed in git, and the files git does
// not keep, each with where it is and which version. A file git does not keep
// is copied into .geml/artifacts/ under its content's hash, one copy a version;
// a GEML document's later versions go into its copy's .gemlhistory instead. A
// row is one version: a artifact's versions are its rows, oldest first. Pure:
// rows in, text out; artifacts-store.ts reads the files and git and writes.
import { parse, unitSpans, type Block } from "@geml/geml";

export const ARTIFACTS_TABLE = "artifacts";
export const ARTIFACT_COLUMNS = ["item", "kind", "name", "where", "version", "size", "at", "sha256"] as const;

/** What a artifact is: a link (a published page, a canvas), a document in git, a file git does not keep, a picture. */
export type ArtifactKind = "link" | "doc" | "file" | "image";
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["link", "doc", "file", "image"];

/**
 * One version of a artifact. `name`: the link's title, or the file's project
 * path. `where`: the link's address; `git` for a document git keeps; the copy
 * under the home (`artifacts/<sha256>.<ext>`), or the file's own path when it
 * is too big to copy. `version`: a link's version number as its publisher
 * said it (empty when it said none), a git document's last commit, a copied
 * file's version count. `size` in bytes, null when not read.
 */
export interface ArtifactRow { item: string; kind: ArtifactKind; name: string; where: string; version: string; size: number | null; at: string; sha256: string }

/** The biggest file copied; a bigger one is kept by where it is and its hash. */
export const COPY_LIMIT = 20 * 1024 * 1024;

/** The extensions a picture has. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)$/i;
/** The extensions a document has, of those git keeps: listed apart from the code. */
const DOC = /\.(md|markdown|mdx|geml)$/i;

export const isImagePath = (path: string): boolean => IMAGE.test(path);
export const isDocPath = (path: string): boolean => DOC.test(path);
export const isGemlPath = (path: string): boolean => /\.geml$/i.test(path);

/** A copy's name in the artifacts directory: the content's hash, then the original's extension. */
export function copyName(sha256: string, path: string): string {
  const ext = /(\.[A-Za-z0-9]{1,10})$/.exec(path.split("/").at(-1) ?? "")?.[1] ?? "";
  return `${sha256}${ext.toLowerCase()}`;
}

type Typed = Extract<Block, { kind: "block" }>;

/** The rows of a document's `#artifacts` table; none when it has none, or one without its columns. */
export function readArtifacts(source: string): ArtifactRow[] {
  const tb = parse(source).children.find((b): b is Typed => b.kind === "block" && b.type === "table" && b.id === ARTIFACTS_TABLE);
  const table = tb?.table;
  if (table === undefined || !table.header) return [];
  const cols = table.columns.map((c) => c.trim().toLowerCase());
  if (!cols.includes("item") || !cols.includes("kind") || !cols.includes("name")) return [];
  const cell = (row: (typeof table.rows)[number], name: string): string => {
    const c = row[cols.indexOf(name)];
    if (!c) return "";
    const only = c.inlines.length === 1 ? c.inlines[0] : undefined;
    return (only?.type === "code" ? only.value : c.text).trim();
  };
  return table.rows.flatMap((row): ArtifactRow[] => {
    const item = cell(row, "item");
    const kind = cell(row, "kind") as ArtifactKind;
    const name = cell(row, "name");
    if (item === "" || name === "" || !ARTIFACT_KINDS.includes(kind)) return [];
    const size = cell(row, "size");
    return [{ item, kind, name, where: cell(row, "where"), version: cell(row, "version"), size: /^\d+$/.test(size) ? Number(size) : null, at: cell(row, "at"), sha256: cell(row, "sha256") }];
  });
}

/** A cell's text: a value that holds the table's own `|`, or would read as markup, goes in code. */
const cellText = (s: string): string => (/[|`*_[\]\\<{]/.test(s) || /^https?:/.test(s) ? `\`${s.replace(/`/g, "'")}\`` : s);

/** The `#artifacts` table block, the rows in the order given. */
export function renderArtifacts(rows: readonly ArtifactRow[]): string {
  const lines = rows.map((r) => [r.item, r.kind, r.name, r.where, r.version, r.size === null ? "" : String(r.size), r.at, r.sha256].map(cellText));
  const widths = ARTIFACT_COLUMNS.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: readonly string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [`=== table {#${ARTIFACTS_TABLE}}`, fmt(ARTIFACT_COLUMNS), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...lines.map(fmt), "==="].join("\n");
}

/** `source` with its `#artifacts` table replaced by `rows`; only that block is rewritten. None at all becomes a document of its own. */
export function withArtifacts(source: string | null, rows: readonly ArtifactRow[]): string {
  const table = renderArtifacts(rows);
  if (source === null) return ["=== meta", 'title = "Gemflow artifacts"', "===", "", table, ""].join("\n");
  const src = source.replace(/\r\n?/g, "\n");
  const unit = unitSpans(src).find((u) => u.kind === "block" && u.id === ARTIFACTS_TABLE);
  if (unit === undefined) return `${src.replace(/\n*$/, "\n\n")}${table}\n`;
  const lines = src.split("\n");
  return [...lines.slice(0, unit.span.start), ...table.split("\n"), ...lines.slice(unit.span.end)].join("\n");
}

/** A artifact: its kind and name, its versions oldest first (its rows). */
export interface Artifact { kind: ArtifactKind; name: string; versions: ArtifactRow[] }

/** A work item's artifacts from the table's rows, by kind and name; the newest version last within each; the most recently changed first. */
export function artifactsOfItem(rows: readonly ArtifactRow[], item: string): Artifact[] {
  const by = new Map<string, Artifact>();
  for (const r of rows) {
    if (r.item !== item) continue;
    const key = `${r.kind}\0${r.name}`;
    const p = by.get(key) ?? { kind: r.kind, name: r.name, versions: [] };
    p.versions.push(r);
    by.set(key, p);
  }
  const last = (p: Artifact): string => p.versions.at(-1)?.at ?? "";
  return [...by.values()].sort((a, b) => last(b).localeCompare(last(a)) || a.name.localeCompare(b.name));
}

/** A page's `<title>`, from its first 8 KB. */
export function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html.slice(0, 8192));
  const t = m?.[1]?.replace(/\s+/g, " ").trim();
  return t === undefined || t === "" ? undefined : t;
}
