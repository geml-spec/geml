// The tool dictionary on disk: `tools.geml` in the workflow's directory, read
// afresh for every decision and rewritten under its own lock when a person
// answers (spec §5.3). The workspace, the dsh plugin and the pi extension all
// read and learn through here.
import { join } from "node:path";
import { exists, readText, withLock, writeAtomic } from "./host-fs.js";
import { EMPTY_DICTIONARY, learn, TOOLS_FILE, type Dictionary, type Lesson } from "./core/dictionary.js";
import { readDictionary, withToolsTable } from "./core/dictionary-file.js";
import type { Statechart } from "./core/statechart.js";

/** Where a workflow's dictionary lives: beside its flow file. */
export const dictionaryPathOf = (workflowDir: string): string => join(workflowDir, TOOLS_FILE);

/** The dictionary as it stands; empty when there is no file yet, or it cannot be read. */
export function readDictionaryFile(workflowDir: string, sc?: Statechart): Dictionary {
  const path = dictionaryPathOf(workflowDir);
  if (!exists(path)) return EMPTY_DICTIONARY;
  try {
    return readDictionary(readText(path), sc);
  } catch {
    return EMPTY_DICTIONARY;
  }
}

/** Write `lessons` into the dictionary under the file's lock: only the `#tools` table is rewritten. */
export function learnInFile(workflowDir: string, lessons: readonly Lesson[], sc?: Statechart): void {
  const path = dictionaryPathOf(workflowDir);
  withLock(path, () => {
    const source = exists(path) ? readText(path) : null;
    let dict = source === null ? EMPTY_DICTIONARY : readDictionary(source, sc);
    for (const l of lessons) dict = learn(dict, l);
    writeAtomic(path, withToolsTable(source, dict.rows));
  });
}
