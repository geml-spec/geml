import { test } from "node:test";
import assert from "node:assert/strict";
import { changesDirectory, commandDirs, isDirectoryChange, isSearchOnlyCommand, pathWords, switchesWorkItemOnly, withoutDataHereDocs } from "../dist/core/command-line.js";
import { fencedRefusal } from "../dist/core/dictionary.js";
import { dict } from "./helpers/flow.mjs";

const DEPLOY = ["wrangler", "deploy"].join(" ");

test("a here-document written as text is no code: fed to cat or tee its body goes; fed to a shell, an interpreter, ssh or a pipe it stays", () => {
  const data = `cat >> t.test.mjs <<'EOF'\nassert.match(x, /npx ${DEPLOY}/)\nEOF\nnpm run build && node --test t.test.mjs`;
  const out = withoutDataHereDocs(data);
  assert.ok(!out.includes(DEPLOY) && out.includes("npm run build && node --test t.test.mjs"), out);
  assert.ok(!withoutDataHereDocs(`tee notes.md <<'EOF' >/dev/null\n${DEPLOY}\nEOF`).includes(DEPLOY), "tee");
  assert.ok(!withoutDataHereDocs(`git commit -q -m "$(cat <<'EOF'\nfix: ${DEPLOY} docs\nEOF\n)"`).includes(DEPLOY), "a commit message in $(…)");
  for (const runs of [
    `bash <<'EOF'\n${DEPLOY}\nEOF`, `sh -s <<'EOF'\n${DEPLOY}\nEOF`, `cat <<'EOF' | sh\n${DEPLOY}\nEOF`, `ssh prod <<'EOF'\n${DEPLOY}\nEOF`,
    `python3 <<'EOF'\nimport os; os.system("${DEPLOY}")\nEOF`, `npx -y tsx <<'EOF'\n${DEPLOY}\nEOF`,
  ]) assert.ok(withoutDataHereDocs(runs).includes(DEPLOY), runs);
  assert.ok(withoutDataHereDocs(`cat > notes.md <<EOF\n$(${DEPLOY})\nEOF`).includes(DEPLOY), "an unquoted body expands its substitutions: it stays");
  assert.equal(withoutDataHereDocs(`echo "unclosed`), null, "a quote that does not close: read whole");
  assert.equal(withoutDataHereDocs(`echo $((1 << 2))\n${DEPLOY}`), null, "<< after arithmetic is a shift: read whole");
  assert.equal(withoutDataHereDocs("npm test"), "npm test", "no here-document: the line as it is");
});

test("a fenced use is not refused for a deploy the line only writes as text; one it runs is", () => {
  const d = dict([{ tool: `Bash(${DEPLOY})`, for: "deploy-prod", default: true }]);
  const scope = { state: "build", uses: [], declaring: () => ["release"], fenced: () => true };
  assert.equal(fencedRefusal(d, scope, `cat >> t.test.mjs <<'EOF'\nnpx ${DEPLOY}\nEOF`), undefined);
  assert.match(fencedRefusal(d, scope, `bash <<'EOF'\nnpx ${DEPLOY}\nEOF`), /is deploy-prod, which is used only in #release/);
  assert.match(fencedRefusal(d, scope, `bash -c "npx ${DEPLOY}"`), /is deploy-prod/, "a shell string is still searched");
});

test("search only: read-only search commands, alone, in a plain && chain, or piped into one another", () => {
  for (const line of [
    "rg -n foo src", "rg -n 'a|b' src", 'grep -rn "x && y" .', "egrep -r 'a;b' .", "fgrep -l x *.ts", "ls", "ls -la src", "find . -name '*.ts' -type f",
    "find src -newer a -print", "fd -e ts", "fd foo src --hidden", "tree -L 2", "wc -l a b", "head -n 20 a", "tail -n 5 log",
    "ls src && rg -n foo src", "grep -rn foo . | head -5", "rg -l foo | wc -l", "find . -name x | grep y | head",
    "rg foo 2>/dev/null", "rg foo 2> /dev/null", "rg foo 2>&1 | head", "wc -l < a", "rg 'end$' src", "rg -e foo -e bar", "  rg foo  ", '"rg" foo',
  ]) assert.equal(isSearchOnlyCommand(line), true, line);
});

test("search only: not when anything could write, run another program or end the line differently", () => {
  for (const line of [
    // not a search command, or one built by expansion or prefixed
    "cat a", "sort a", "echo rg", "npm test", "rg foo | sort", "$RG foo", "rg $PATTERN src", 'rg "$X" src', "rg ${X} src", "FOO=1 rg x", "command rg x", "sudo rg x", "/usr/bin/rg foo", "./rg foo", "env rg foo",
    // writing a file
    "rg foo > out.txt", "rg foo >> out.txt", "rg foo >out", "rg foo &> out", "rg foo >| out", "rg foo 2> err.log", "rg foo <> f", "rg foo &>/dev/null", "rg foo >>/dev/null", "tree -o out.txt .", "tree -L 2 -o out", "tree -ao out",
    // running something
    "find . -exec rm {} \\;", "find . -execdir sh -c x \\;", "find . -ok rm {} \\;", "find . -okdir rm {} \\;", "find . -delete", "find . -fprint out",
    "find . -fprint0 out", "find . -fprintf out %p", "find . -fls out", "fd -x rm", "fd -X rm", "fd --exec rm", "fd --exec-batch rm", "fd --exec=rm", "fd -Hx rm",
    "rg --pre ./x foo", "rg --pre=./x foo",
    // anything but && and | between commands, substitutions, a background &
    "rg foo; rm -rf x", "rg foo || rm x", "rg foo & rm x", "rg foo &", "rg foo\nrm x", "rg `rm x`", 'rg "$(rm -rf x)"', "rg $(rm x)", "rg <(rm x) foo",
    "(rg foo)", "{ rg foo; }", "rg foo |& head", "rg foo |", "| rg foo", "rg foo && ", "rg 'unclosed", "",
    "rg foo | xargs rm", "find . | xargs rm",
  ]) assert.equal(isSearchOnlyCommand(line), false, JSON.stringify(line));
});

test("switching the work item: git switch, switch -c, checkout -b, checkout of an existing local branch, worktree add, cd, chained with &&", () => {
  const branches = new Set(["feat/y"]);
  const isBranch = (name) => branches.has(name);
  for (const line of [
    "git switch feat/y", "git switch -c feat/new", "git switch -C feat/new main", "git switch --create feat/new", "git switch --force-create feat/new origin/main",
    "git checkout -b feat/new", "git checkout -B feat/new main", "git checkout feat/y",
    "git worktree add ../wt", "git worktree add ../wt feat/y", "git worktree add -b feat/w ../wt", "git worktree add -B feat/w ../wt main", "git worktree add --detach ../wt",
    "cd ../wt", "cd ../wt && git switch feat/y", "git worktree add -b feat/w ../wt && cd ../wt",
  ]) assert.equal(switchesWorkItemOnly(line, isBranch), true, line);
  for (const line of [
    "git checkout feat/nope", "git checkout -- a.ts", "git checkout feat/y a.ts", "git switch -f feat/y", "git switch --discard-changes feat/y", "git switch --merge feat/y",
    "git switch", "git switch -c", "git switch feat/y extra", "git -C x switch feat/y", "git switch $B", "git switch feat/y > log", "/usr/bin/git switch feat/y",
    "sudo git switch feat/y", "git stash && git switch feat/y", "git switch feat/y; rm -rf x", "git worktree add", "git worktree remove ../wt", "git worktree add -f ../wt",
    "cd", "cd -", "cd a b", "git fetch", "",
  ]) assert.equal(switchesWorkItemOnly(line, isBranch), false, JSON.stringify(line));
  assert.equal(switchesWorkItemOnly("git checkout feat/y"), false, "without git to ask, a bare checkout is not taken for a switch");
});

test("commandDirs: each simple command of an && chain runs where the cds before it took the shell", () => {
  const dirs = (line, start = "/p/r") => commandDirs(line, start);
  assert.deepEqual(dirs("npm test"), ["/p/r"]);
  assert.deepEqual(dirs("cd sub && npm test"), ["/p/r", "/p/r/sub"], "the cd itself runs where the shell stood");
  assert.deepEqual(dirs("cd ../wt && npm test"), ["/p/r", "/p/wt"]);
  assert.deepEqual(dirs("cd /abs/x && npm test && cd .. && ls"), ["/p/r", "/abs/x", "/abs/x", "/abs"]);
  assert.deepEqual(dirs("cd a && cd ./b/../c && make"), ["/p/r", "/p/r/a", "/p/r/a/c"]);
  assert.deepEqual(dirs('cd "my dir" && make'), ["/p/r", "/p/r/my dir"]);
  assert.deepEqual(dirs("cd ../../.. && pwd", "/a/b"), ["/a/b", "/"], "above the top is the top");
  assert.deepEqual(dirs("builtin cd x && make"), ["/p/r", "/p/r/x"]);
  assert.deepEqual(dirs("command cd x && make"), ["/p/r", "/p/r/x"]);
  assert.deepEqual(dirs("FOO=1 cd x && make"), ["/p/r", "/p/r/x"]);
  assert.deepEqual(dirs("cd x 2>/dev/null && make"), ["/p/r", "/p/r/x"], "a redirection is no argument");
  assert.deepEqual(dirs("chdir x && make"), ["/p/r", "/p/r/x"]);
  assert.deepEqual(dirs("pushd x && make && popd && ls"), ["/p/r", "/p/r/x", "/p/r/x", undefined], "popd goes back to a place the line does not say");
  assert.deepEqual(dirs("echo cd x && make"), ["/p/r", "/p/r"], "naming cd is not running it");
  assert.deepEqual(dirs("env cd x && make"), ["/p/r", "/p/r"], "env runs a cd of its own, which moves no shell");
  assert.deepEqual(dirs("npm test", "/p/r/"), ["/p/r"]);
  assert.deepEqual(dirs(""), []);
});

test("commandDirs: unknown from a cd whose target the line does not say, on", () => {
  const dirs = (line) => commandDirs(line, "/p/r");
  for (const cd of ["cd $HOME", 'cd "$X/y"', "cd ~", "cd ~/x", "cd -", "cd", "cd a b", "cd -P a", "cd sr*", "cd +1", "pushd", "pushd +2", 'cd "`pwd`/x"', "cd $'a'"]) {
    assert.deepEqual(dirs(`${cd} && npm test && ls`), ["/p/r", undefined, undefined], cd);
  }
  assert.deepEqual(dirs("cd x && cd $Y && cd z && make"), ["/p/r", "/p/r/x", undefined, undefined]);
});

test("commandDirs: a line that is no && chain is null; a relative start stands until the first cd", () => {
  for (const line of ["cd x; make", "(cd x && make)", "npm test | tee log", "cd x || make", "cd x & make", "cd `pwd` && make", "cd ${X} && make"]) assert.equal(commandDirs(line, "/p/r"), null, line);
  assert.deepEqual(commandDirs("cd sub && npm test", "relative/dir"), ["relative/dir", undefined]);
});

test("commandDirs: a Windows start is followed in drive form, the way Git Bash reads the line", () => {
  const dirs = (line, start = "C:\\work\\app") => commandDirs(line, start);
  assert.deepEqual(dirs("npm test"), ["C:/work/app"]);
  assert.deepEqual(dirs("cd sub && npm test"), ["C:/work/app", "C:/work/app/sub"]);
  assert.deepEqual(dirs("cd ../wt && npm test"), ["C:/work/app", "C:/work/wt"]);
  assert.deepEqual(dirs("cd .claude/worktrees/w && npm test"), ["C:/work/app", "C:/work/app/.claude/worktrees/w"]);
  assert.deepEqual(dirs('cd "C:\\other\\dir" && npm test'), ["C:/work/app", "C:/other/dir"], "quoted, a backslash stays a separator");
  assert.deepEqual(dirs("cd D:/x/../y && ls"), ["C:/work/app", "D:/y"]);
  assert.deepEqual(dirs("cd /c/x && npm test"), ["C:/work/app", "C:/x"], "Git Bash's drive form");
  assert.deepEqual(dirs("cd /tmp && ls"), ["C:/work/app", undefined], "a POSIX root the drive form cannot place");
  assert.deepEqual(dirs("cd C:x && ls"), ["C:/work/app", undefined], "drive-relative: that drive's own current directory decides");
  assert.deepEqual(dirs("cd .. && ls", "C:\\"), ["C:/", "C:/"], "above the top is the top");
  assert.deepEqual(dirs("cd sub && ls", "c:/work/app/"), ["C:/work/app", "C:/work/app/sub"]);
});

test("commandDirs: in double quotes a backslash escapes only what the shell escapes", () => {
  const dirs = (line) => commandDirs(line, "/p/r");
  assert.deepEqual(dirs('cd "x\\"y" && make'), ["/p/r", '/p/r/x"y']);
  assert.deepEqual(dirs('cd "x\\$y" && make'), ["/p/r", "/p/r/x$y"], "an escaped $ expands nothing");
  assert.deepEqual(dirs('cd "a\\ b" && make'), ["/p/r", undefined], "a backslash before a blank stays, and a POSIX path holding one is no path the line places");
});

test("changesDirectory: cd, pushd, popd or chdir at any command position", () => {
  for (const line of ["cd x", "cd x; make", "(cd x && make)", "make && cd x", "if cd x; then make; fi", "pushd x", "popd", "builtin cd x", "echo $(cd x && pwd)", "FOO=1 chdir x", "cd 'unclosed"]) {
    assert.equal(changesDirectory(line), true, line);
  }
  for (const line of ["echo cd x", "npm test", "git checkout cd", "ls cd", "cdx", "mkdir cd && ls cd", 'bash -c "cd x && make"', "env cd x", ""]) {
    assert.equal(changesDirectory(line), false, line);
  }
  assert.equal(isDirectoryChange("cd x"), true);
  assert.equal(isDirectoryChange("builtin popd"), true);
  assert.equal(isDirectoryChange("npm test"), false);
  assert.equal(isDirectoryChange("cdx y"), false);
});

test("pathWords: the arguments of one simple command that may name a file", () => {
  assert.deepEqual(pathWords("geml media todo episodes/ep02.geml --root . --check").map((w) => w.text), ["media", "todo", "episodes/ep02.geml", "."]);
  assert.deepEqual(pathWords("geml media build ep.geml --out=renders/x.mp4 -o y.mp4").map((w) => w.text), ["media", "build", "ep.geml", "renders/x.mp4", "y.mp4"]);
  assert.deepEqual(pathWords("FOO=1 geml check 'my ep.geml' > log.txt 2>&1"), [{ text: "check", glob: false }, { text: "my ep.geml", glob: false }]);
  assert.deepEqual(pathWords("geml media todo episodes/*.geml --check"), [{ text: "media", glob: false }, { text: "todo", glob: false }, { text: "episodes/*.geml", glob: true }]);
  assert.deepEqual(pathWords("geml check $EP `pwd`/x.geml").map((w) => w.text), ["check"], "a word built by expansion names nothing the line says");
  assert.deepEqual(pathWords(""), []);
});
