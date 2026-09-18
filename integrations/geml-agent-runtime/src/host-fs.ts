// The only module that touches the file system. Everything under core/ is pure.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** Create a file that must not exist yet (flag "wx"), making parent directories. */
export function writeNew(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
}

/** Blind append: one call, no read. */
export function appendText(path: string, text: string): void {
  appendFileSync(path, text, "utf8");
}

/**
 * Append one ledger block, writing the head first when the file is new.
 *
 * One `appendFileSync` either way: a ledger is written by blind append (the
 * writer never reads the file), so the only question is whether this is the
 * first block. `existsSync` answers it without opening anything.
 */
export function appendOrCreate(path: string, head: string, block: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, existsSync(path) ? block : head + block, "utf8");
}

/** Whether a path is there — the ledger asks before deciding to resume. */
export function exists(path: string): boolean {
  return existsSync(path);
}
