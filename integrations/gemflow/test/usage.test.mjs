import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHeads, dayKey, groupOf, guessUse, keyWords, mergeBooks, noteUse, pruneBook, usageKeys, usesSince } from "../dist/hosts/claude-code/usage.js";

test("a command line's commands, as the dictionary keys them: a program and its subcommand, a package runner's script, gh's two levels", () => {
  assert.deepEqual(commandHeads("node --test test/usage.test.mjs"), ["node --test"]);
  assert.deepEqual(commandHeads("npm run build && npm test"), ["npm run build", "npm test"]);
  assert.deepEqual(commandHeads("rtk git add src && rtk git commit -q -F msg.txt && rtk git push"), ["git add", "git commit", "git push"], "a wrapper runs the next word");
  assert.deepEqual(commandHeads("cd app && FOO=1 sudo env BAR=2 cargo test -- --nocapture"), ["cargo test"], "cd counts for nothing; assignments and wrappers are skipped");
  assert.deepEqual(commandHeads("gh pr create --fill"), ["gh pr create"]);
  assert.deepEqual(commandHeads("npm test 2>&1 | tail -5"), ["npm test"], "a redirection is no command, and a pipe's reader no tool of its own");
  assert.deepEqual(commandHeads("for f in *.ts; do grep -c x $f; done"), ["grep"], "the shell's own words are no commands");
  assert.deepEqual(commandHeads("git -c user.name=me -C /repo commit -m x"), ["git commit"], "an option's value is no subcommand");
  assert.deepEqual(commandHeads("git $CMD"), ["git"]);
  assert.deepEqual(commandHeads("timeout 30 /usr/bin/git.exe status"), ["git status"]);
  assert.deepEqual(commandHeads("git commit -F - <<'EOF'\nfeat: the band\n\nThe body says gemflow mark.\nEOF\necho done"), ["git commit"], "a here-document's body is data");
  assert.deepEqual(commandHeads('git commit -m "first line\nsecond line; rm -rf x"'), ["git commit"], "a quoted string is data");
  assert.deepEqual(commandHeads("tsc"), ["tsc"]);
  assert.deepEqual(commandHeads(""), []);
});

test("a call's keys: a shell's commands, an MCP server, a skill by name, else the tool; each in its group, shown by its name", () => {
  assert.deepEqual(usageKeys("Bash", { command: "npm test && git push" }), ["Bash(npm test)", "Bash(git push)"]);
  assert.deepEqual(usageKeys("PowerShell", { command: "npm run build" }), ["PowerShell(npm run build)"]);
  assert.deepEqual(usageKeys("mcp__visualize__show_widget", {}), ["mcp__visualize__*"]);
  assert.deepEqual(usageKeys("mcp__ccd_session__mark_chapter", {}), ["mcp__ccd_session__*"]);
  assert.deepEqual(usageKeys("Skill", { skill: "geml" }), ["Skill(geml)"]);
  assert.deepEqual(usageKeys("Edit", { file_path: "x" }), ["Edit"]);
  assert.deepEqual(["Bash(npm test)", "Edit", "Grep", "mcp__x__*", "Skill(geml)", "WebFetch", "Agent", "TodoWrite"].map(groupOf), ["cli", "file", "file", "mcp", "skill", "web", "model", "other"]);
  assert.deepEqual(["Bash(npm test)", "PowerShell(npm test)", "mcp__visualize__*", "Skill(geml)", "Edit"].map(keyWords), ["npm test", "npm test · PowerShell", "visualize", "geml", "Edit"]);
});

test("the book: each call under its local day; books merge by adding; a week is kept; two days are counted", () => {
  const day = (y, m, d) => new Date(y, m - 1, d, 12).toISOString();
  assert.equal(dayKey(day(2026, 10, 5)), "2026-10-05");
  let book = noteUse({}, "2026-10-15", ["Bash(npm test)", "Edit"]);
  book = noteUse(book, "2026-10-15", ["Edit"]);
  book = noteUse(book, "2026-10-14", ["Bash(npm test)"]);
  book = noteUse(book, "2026-10-01", ["Read"]);
  assert.deepEqual(book["2026-10-15"], { "Bash(npm test)": 1, Edit: 2 });
  assert.equal(noteUse(book, "2026-10-15", []), book, "a call with no key changes nothing");
  assert.deepEqual(usesSince(book, day(2026, 10, 15), 2), { "Bash(npm test)": 2, Edit: 2 });
  assert.deepEqual(mergeBooks({ "2026-10-15": { Edit: 1 } }, { "2026-10-15": { Edit: 2, Read: 1 }, "2026-10-16": { Grep: 1 } }), { "2026-10-15": { Edit: 3, Read: 1 }, "2026-10-16": { Grep: 1 } });
  assert.deepEqual(Object.keys(pruneBook(book, 2)), ["2026-10-14", "2026-10-15"]);
});

test("an unclassified test runner looks like the flow's test use, else its check use; anything else like nothing", () => {
  for (const key of ["Bash(node --test)", "Bash(npx vitest)", "Bash(pytest)", "Bash(go test)", "Bash(npm run test)", "Bash(pnpm run test:unit)"]) assert.equal(guessUse(key, ["edit", "test"]), "test", key);
  assert.equal(guessUse("Bash(node --test)", ["note", "check"]), "check");
  assert.equal(guessUse("Bash(node --test)", ["edit"]), undefined, "a flow with no such use guesses nothing");
  assert.equal(guessUse("Bash(git commit)", ["test"]), undefined);
});
