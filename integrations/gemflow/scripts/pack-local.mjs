// Build an installable tarball BEFORE the parser is on npm.
//
//   node scripts/pack-local.mjs   ->  gemflow-<version>.tgz
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
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const parserDir = resolve(pkgDir, "../../geml-parser");
const outDir = process.argv[2] ? resolve(process.argv[2]) : pkgDir;
// `npm` is a .cmd on Windows, which Node will not spawn without a shell, so
// there it goes through one. The arguments travel as argv rather than as one
// command string, and every one of them below is a fixed literal, so on neither
// platform does this script interpolate anything into a command line.
const npm = (args, cwd) => {
  const r = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
  if (r.error) throw r.error;
  // spawnSync reports a failed command in its result; execSync threw. Keep the
  // throw, or a broken build would be packed as if it had worked.
  if (r.status !== 0) throw new Error("npm " + args.join(" ") + " failed in " + cwd + ", exit " + r.status);
};

console.log("building the parser");
npm(["run", "build"], parserDir);
console.log("building the runtime");
npm(["run", "build"], pkgDir);

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
npm(["pack", "--silent"], staging);

const tarball = readdirSync(staging).find((n) => n.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack produced no tarball");
const finalPath = join(outDir, tarball);
cpSync(join(staging, tarball), finalPath);

// Two artifacts, because the two installers want different things: `npm
// install -g` takes the tarball, and `pi install` takes a package DIRECTORY —
// hand it a .tgz and it records the path in settings.json and then fails to
// load it on every later start, which is a confusing way to find that out.
//
// The directory is the staging tree itself rather than an extraction of the
// tarball: it holds exactly the same files, and copying it is portable, where
// shelling out to `tar` is not (Git Bash and cmd.exe do not agree about
// --strip-components on Windows).
const unpacked = join(outDir, "gemflow-pkg");
rmSync(unpacked, { recursive: true, force: true });
cpSync(staging, unpacked, { recursive: true });
rmSync(join(unpacked, tarball), { force: true });
rmSync(staging, { recursive: true, force: true });

console.log(`\n  tarball    ${finalPath}`);
console.log(`  unpacked   ${unpacked}\n`);
console.log("install it:");
console.log(`  npm install -g "${finalPath}"        # the gemflow CLI (takes the tarball)`);
console.log(`  pi install "${unpacked}"             # pi agent: the supervisor and the skills`);
console.log(`\n  pi remove "${unpacked}"             # if you want it out again`);
