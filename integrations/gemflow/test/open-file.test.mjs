// Opening a local file from the board: which command the machine opens it with, read as strings only (nothing is run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, openersFor, OPEN_PATH_VAR } from "../dist/hosts/claude-code/open-file.js";

test("Windows opens through Start-Process in a normal window, the path in a variable in backslashes: explorer.exe started by the engine builds its window hidden", () => {
  const [open] = openersFor("win32", "C:/r/.geml/exports/s b.geml");
  assert.equal(open.argv[0], "powershell.exe");
  assert.equal(open.argv.at(-1), `Start-Process -FilePath $env:${OPEN_PATH_VAR} -WindowStyle Normal`);
  assert.deepEqual(open.env, { [OPEN_PATH_VAR]: "C:\\r\\.geml\\exports\\s b.geml" });
  const [reveal] = openersFor("win32", "C:/r/x.md", true);
  assert.equal(reveal.argv.at(-1), `Start-Process -FilePath explorer.exe -ArgumentList ('/select,' + [char]34 + $env:${OPEN_PATH_VAR} + [char]34) -WindowStyle Normal`, "the folder shown with the file selected");
  for (const o of [open, reveal]) assert.ok(o.argv.every((a) => !a.includes('"')), "no double quote crosses the command line");
});

test("macOS opens with open and shows it in Finder with open -R; Linux opens with xdg-open and shows its folder; unknown, a drive letter says Windows, else xdg-open before open", () => {
  assert.deepEqual(openersFor("darwin", "/Users/me/r/x.md"), [{ argv: ["open", "/Users/me/r/x.md"] }]);
  assert.deepEqual(openersFor("darwin", "/Users/me/r/x.md", true), [{ argv: ["open", "-R", "/Users/me/r/x.md"] }]);
  assert.deepEqual(openersFor("linux", "/home/me/r/x.md"), [{ argv: ["xdg-open", "/home/me/r/x.md"] }]);
  assert.deepEqual(openersFor("linux", "/home/me/r/x.md", true), [{ argv: ["xdg-open", "/home/me/r"] }]);
  assert.equal(openersFor(undefined, "D:\\out\\s.geml")[0].argv[0], "powershell.exe", "a drive letter says Windows");
  assert.deepEqual(openersFor(undefined, "/r/x.md").map((o) => o.argv[0]), ["xdg-open", "open"], "xdg-open first: Debian's own open is openvt");
});

test("a toast names the file by its last segment, a folder's too", () => {
  assert.equal(baseName("C:\\a b\\c.txt"), "c.txt");
  assert.equal(baseName("/h/.geml/artifacts/"), "artifacts");
  assert.equal(baseName("x"), "x");
});
