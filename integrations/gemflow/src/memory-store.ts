/**
 * The project's Claude Code memory, as the board shows and edits it: the
 * index (MEMORY.md, one line per memory, `- [Title](file.md) — hook`) and the
 * files it points at. Kept the way Claude Code keeps it: an edit rewrites the
 * one index line, a delete moves the file into gemflow's trash and drops its
 * line, and either keeps a copy of the index in the trash first. Nothing is
 * copied into gemflow's own record.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** One memory: its file in the folder, the title and the hook its index line gives, its type, when it was last written. */
export interface MemoryEntry { file: string; title: string; hook: string; type: string; at: string }
/** A project's memory: the folder it is in, and its entries, the newest first. */
export interface MemoryList { dir: string; entries: MemoryEntry[] }

const INDEX = "MEMORY.md";
/** An index line: `- [Title](file.md) — hook`, the dash an em dash, an en dash or a hyphen. */
const LINE = /^- \[([^\]]*)\]\(([^)\s]+)\)\s*(?:—|–|-)\s*(.*)$/;

/** The folder Claude Code keeps a project's memory in: its projects folder, then the project's path with every other character a dash, then memory. */
export function memoryDir(projects: string, project: string): string {
  return join(projects, project.replace(/[^A-Za-z0-9]/g, "-"), "memory");
}

/** A memory file's type, from its front matter (`type:` at the top level or under metadata). */
function typeOf(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return /^\s*type:\s*([A-Za-z]+)/m.exec(front)?.[1] ?? "";
}

/** The memory the index lists, the newest first; none when the folder or its index is not there. */
export function readMemory(dir: string): MemoryList {
  const index = join(dir, INDEX);
  if (!existsSync(index)) return { dir, entries: [] };
  const entries: MemoryEntry[] = [];
  for (const line of readFileSync(index, "utf8").split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (m === null) continue;
    const [, title = "", file = "", hook = ""] = m;
    let type = "";
    let at = "";
    try { at = statSync(join(dir, file)).mtime.toISOString(); type = typeOf(readFileSync(join(dir, file), "utf8")); } catch { /* listed, its file gone */ }
    entries.push({ file, title, hook, type, at });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { dir, entries };
}

/** A memory named by its own file in the folder: nothing that climbs out of it, never the index itself. */
function isMemoryFile(file: string): boolean {
  return file !== INDEX && file.endsWith(".md") && basename(file) === file && !file.includes("\\") && !file.startsWith(".");
}

/** The index read with its line ending, so a rewrite keeps it. */
function readIndex(dir: string): { lines: string[]; nl: string } {
  const text = readFileSync(join(dir, INDEX), "utf8");
  return { lines: text.split(/\r?\n/), nl: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** The index copied into the trash folder before it is changed. */
function keepIndex(dir: string, trash: string): void {
  mkdirSync(trash, { recursive: true });
  copyFileSync(join(dir, INDEX), join(trash, INDEX));
}

/** Rewrites one memory's index line with a new hook, its title and file kept; false when the file is not listed or the hook is empty or spans lines. */
export function setMemoryHook(dir: string, file: string, hook: string, trash: string): boolean {
  const said = hook.trim();
  if (!isMemoryFile(file) || said === "" || /[\r\n]/.test(said) || !existsSync(join(dir, INDEX))) return false;
  const { lines, nl } = readIndex(dir);
  const at = lines.findIndex((l) => LINE.exec(l.trim())?.[2] === file);
  if (at < 0) return false;
  const title = LINE.exec((lines[at] as string).trim())?.[1] ?? "";
  keepIndex(dir, trash);
  lines[at] = `- [${title}](${file}) — ${said}`;
  writeFileSync(join(dir, INDEX), lines.join(nl));
  return true;
}

/** Takes one memory out: its file moved into the trash folder, its index line dropped; false when the file is not listed. */
export function deleteMemory(dir: string, file: string, trash: string): boolean {
  if (!isMemoryFile(file) || !existsSync(join(dir, INDEX))) return false;
  const { lines, nl } = readIndex(dir);
  const kept = lines.filter((l) => LINE.exec(l.trim())?.[2] !== file);
  if (kept.length === lines.length) return false;
  keepIndex(dir, trash);
  const path = join(dir, file);
  if (existsSync(path)) {
    try { renameSync(path, join(trash, file)); } catch { copyFileSync(path, join(trash, file)); unlinkSync(path); }
  }
  writeFileSync(join(dir, INDEX), kept.join(nl));
  return true;
}
