// Build an installable tarball BEFORE the parser is on npm.
//
//   node scripts/pack-local.mjs   ->  geml-agent-runtime-<version>.tgz
//
// The blocker it exists for: this package depends on `@geml/geml` as
// `file:../../geml-parser`, and a `file:` dependency in a published tarball
// resolves to a path that does not exist on anyone else's machine — npm
// installs it and you get an empty directory. So the parser is BUNDLED here:
// npm's own `bundledDependencies`, which puts the dependency's files inside the
// tarball and makes the install self-contained.
//
// This is the local answer, not the release answer. Once the parser is
// published, the dependency becomes a version range and this script is no
// longer the way in — see docs/design/plans/…-release-handoff.md for the order
// that has to be followed then.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const parserDir = resolve(pkgDir, "../../geml-parser");
const outDir = process.argv[2] ? resolve(process.argv[2]) : pkgDir;
// `npm` is a .cmd on Windows, which Node will not spawn without a shell, so
// this goes through one. The command strings below are fixed literals - no
// interpolation reaches the shell.
const npm = (command, cwd) =>
  execSync(`npm ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

console.log("building the parser");
npm("run build", parserDir);
console.log("building the runtime");
npm("run build", pkgDir);

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const parser = JSON.parse(readFileSync(join(parserDir, "package.json"), "utf8"));

const staging = join(pkgDir, ".pack");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// Everything this package publishes, plus the two files npm always wants.
for (const entry of [...pkg.files, "package.json", "README.md", "README.zh.md"]) {
  const from = join(pkgDir, entry);
  if (existsSync(from)) cpSync(from, join(staging, entry), { recursive: true });
}

// The parser, as its own `files` field defines it, in the place npm looks for a
// bundled dependency.
const vendored = join(staging, "node_modules/@geml/geml");
mkdirSync(vendored, { recursive: true });
for (const entry of [...parser.files, "package.json"]) {
  const from = join(parserDir, entry);
  if (existsSync(from)) cpSync(from, join(vendored, entry), { recursive: true });
}

// A real version instead of the `file:` link, and the instruction to ship it.
const staged = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
staged.dependencies = { ...staged.dependencies, "@geml/geml": parser.version };
staged.bundledDependencies = ["@geml/geml"];
writeFileSync(join(staging, "package.json"), `${JSON.stringify(staged, null, 2)}\n`, "utf8");

console.log(`packing ${staged.name}@${staged.version} with @geml/geml@${parser.version} inside`);
npm("pack --silent", staging);

const tarball = readdirSync(staging).find((n) => n.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack produced no tarball");
const finalPath = join(outDir, tarball);
cpSync(join(staging, tarball), finalPath);
rmSync(staging, { recursive: true, force: true });

console.log(`\n${finalPath}\n`);
console.log("install it with any of:");
console.log(`  npm install -g ${tarball}                 # the geml-agent CLI`);
console.log(`  pi install ${finalPath}                   # pi agent: supervisor + skills`);
console.log(`  dsh plugin --profile web add ${finalPath} # DeepSeek Harness: the bundle`);
