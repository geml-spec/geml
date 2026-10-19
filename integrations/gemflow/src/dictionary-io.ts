// The tool dictionary on disk: the project's `.geml/tools.geml` for a workflow
// of the project's own (beside the flow file for any other), read afresh for
// every decision and rewritten under its own lock when a person answers (spec
// §5.3). The workspace, the dsh plugin and the pi extension all read and learn
// through here.
import { exists, readText, withLock, writeAtomic } from "./host-fs.js";
import { EMPTY_DICTIONARY, learn, type Dictionary, type Lesson } from "./core/dictionary.js";
import { readDictionary, withToolsTable } from "./core/dictionary-file.js";
import type { Statechart } from "./core/statechart.js";
import { dictionaryPathOf } from "./project-home.js";

export { dictionaryPathOf };

/** The dictionary of the workflow at `workflowFile` as it stands; empty when there is no file yet, or it cannot be read. */
export function readDictionaryFile(workflowFile: string, sc?: Statechart): Dictionary {
  const path = dictionaryPathOf(workflowFile);
  if (!exists(path)) return EMPTY_DICTIONARY;
  try {
    return readDictionary(readText(path), sc);
  } catch {
    return EMPTY_DICTIONARY;
  }
}

/** Write `lessons` into the dictionary of the workflow at `workflowFile`, under the file's lock: only the `#tools` table is rewritten. */
export function learnInFile(workflowFile: string, lessons: readonly Lesson[], sc?: Statechart): void {
  const path = dictionaryPathOf(workflowFile);
  withLock(path, () => {
    const source = exists(path) ? readText(path) : null;
    let dict = source === null ? EMPTY_DICTIONARY : readDictionary(source, sc);
    for (const l of lessons) dict = learn(dict, l);
    writeAtomic(path, withToolsTable(source, dict.rows));
  });
}
