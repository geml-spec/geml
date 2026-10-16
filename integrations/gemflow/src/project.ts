// The workflows a project holds and which one is the default: copying a
// bundled workflow into .geml/workflows/ and naming the default in
// .geml/gemflow.geml — the workflow a new work item starts under; an item with
// a journal keeps the one its journal names. Shared by the CLI's init and use
// and the Claude Code bridge's add and use.
import { constants, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadStatechart } from "./core/statechart.js";
import { fileURLToPath } from "node:url";
import { exists, readText, writeAtomic, writeNew } from "./host-fs.js";
import { CONFIG_DOC, FLOW_FILE, GEML_DIR, WORKFLOWS_DIR } from "./core/layout.js";

/** The package's own workflows, beside dist/ — the same path from dist/project.js and from the bundle. */
const BUNDLED = fileURLToPath(new URL("../workflows/", import.meta.url));

/** What a project keeps out of git: the journals, the generated stage document and the lock files. */
export const GITIGNORE = "journals/\ncontext.geml\n*.lock\n";

/** The workflows this package ships: the directories under its `workflows/`. */
export function bundledWorkflows(): string[] {
  return readdirSync(BUNDLED, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Which bundled workflow fits a project that has none yet, and what in the project says so. */
export interface Suggestion { workflow: string; by: "media" | "deploy" | "code" | "default"; file?: string }

// What a project's top level says about it: an episodes/ directory or a
// geml-media document is a media project (video); a deploy configuration is
// a service that ships (dev: build → review → deploy → release); a build
// manifest is code (coding: explore → plan → implement → verify → review).
// Nothing recognisable, or a root that cannot be read: dev, the default.
const DEPLOY_FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc", "fly.toml", "vercel.json", "netlify.toml", "render.yaml", "app.yaml", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml"];
const CODE_FILES = ["package.json", "Cargo.toml", "pyproject.toml", "setup.py", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "mix.exs", "CMakeLists.txt", "Makefile"];

export function suggestWorkflow(root: string): Suggestion {
  let names: string[];
  try { names = readdirSync(root); } catch { return { workflow: "dev", by: "default" }; }
  const has = (n: string): boolean => names.includes(n);
  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
  if (has("episodes") && isDir(join(root, "episodes"))) return { workflow: "video", by: "media", file: "episodes/" };
  for (const n of names) {
    if (!n.endsWith(".geml")) continue;
    let head = "";
    try { head = readText(join(root, n)).slice(0, 2000); } catch { continue; }
    if (/^profile\s*=\s*"geml-media\/v1"/m.test(head)) return { workflow: "video", by: "media", file: n };
  }
  const deploy = DEPLOY_FILES.find(has);
  if (deploy !== undefined) return { workflow: "dev", by: "deploy", file: deploy };
  const code = CODE_FILES.find(has) ?? names.find((n) => n.endsWith(".sln") || n.endsWith(".csproj"));
  if (code !== undefined) return { workflow: "coding", by: "code", file: code };
  return { workflow: "dev", by: "default" };
}

/** The workflows a project has: the directories of `.geml/workflows/` that hold a flow file. */
export function projectWorkflows(root: string): string[] {
  const dir = join(root, WORKFLOWS_DIR);
  if (!exists(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && exists(join(dir, e.name, FLOW_FILE))).map((e) => e.name).sort();
}

/** Copy a workflow's directory tree; a file that exists is an error. Text is written with LF line ends whatever the checkout used. `.gemlhistory` and lock files stay behind. */
function copyTree(from: string, to: string): void {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === ".gemlhistory" || e.name.endsWith(".lock")) continue;
    const src = join(from, e.name);
    const dest = join(to, e.name);
    if (e.isDirectory()) copyTree(src, dest);
    else if (/\.(geml|md)$/i.test(e.name)) writeNew(dest, readText(src).replace(/\r\n/g, "\n"));
    else { mkdirSync(to, { recursive: true }); copyFileSync(src, dest, constants.COPYFILE_EXCL); }
  }
}

/** The project's config document naming `name` as the active workflow. */
export function configText(name: string): string {
  return ["=== meta", 'title         = "Gemflow"', `flow-workflow = ${JSON.stringify(name)}`, "===", ""].join("\n");
}

/** A workflow copied (`target` is its directory), or why not: 2 for a name the package does not ship, 1 for a directory that is already there. */
export type Added =
  | { ok: true; name: string; target: string; activated: boolean }
  | { ok: false; code: 1; reason: string; target: string }
  | { ok: false; code: 2; reason: string };

/** Copy the bundled workflow `name` into the project, add .geml/.gitignore when there is none, and make it active when asked. */
export function addWorkflow(root: string, name: string, o: { activate: boolean }): Added {
  const names = bundledWorkflows();
  if (!names.includes(name)) return { ok: false, code: 2, reason: `unknown template "${name}"; expected ${names.join(" or ")}` };
  const target = join(root, WORKFLOWS_DIR, name);
  const there = { ok: false as const, code: 1 as const, reason: `${WORKFLOWS_DIR}/${name} already exists; not overwriting`, target };
  if (exists(target)) return there;
  try {
    copyTree(join(BUNDLED, name), target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return there;
    throw e;
  }
  if (o.activate) writeAtomic(join(root, CONFIG_DOC), configText(name));
  const ignore = join(root, GEML_DIR, ".gitignore");
  if (!exists(ignore)) writeNew(ignore, GITIGNORE);
  return { ok: true, name, target, activated: o.activate };
}

export type Imported = { ok: true; name: string; target: string; activated: boolean } | { ok: false; reason: string };

/**
 * Copy a workflow from a path into the project (spec §8.7): a directory
 * holding a `flow.geml` (its dictionary and guides come along), a `flow.geml`
 * (its directory), or any other `.geml` file (it becomes `flow.geml` under a
 * directory named after it). The flow must load without errors; a name
 * already in `.geml/workflows/` is refused. The first workflow of a project
 * becomes its default.
 */
export function importWorkflow(root: string, path: string): Imported {
  const given = resolve(root, path);
  let dir: string, flow: string, name: string;
  if (exists(given) && statSync(given).isDirectory()) {
    dir = given; flow = join(dir, FLOW_FILE); name = basename(dir);
  } else if (/\.geml$/i.test(given)) {
    flow = given; dir = dirname(given);
    name = basename(given).toLowerCase() === FLOW_FILE ? basename(dir) : basename(given).replace(/\.geml$/i, "");
  } else return { ok: false, reason: `${path} is neither a workflow directory nor a .geml file` };
  if (!exists(flow)) return { ok: false, reason: `${path} has no ${FLOW_FILE}` };
  if (!/^[\p{L}\p{N}._-]+$/u.test(name) || name.startsWith(".")) return { ok: false, reason: `"${name}" cannot name a workflow directory` };
  const loaded = loadStatechart(readText(flow), flow);
  const errors = loaded.diagnostics.filter((d) => d.severity === "error");
  if (loaded.statechart === undefined || errors.length > 0) return { ok: false, reason: `${path} does not load: ${errors.map((d) => d.message).join("; ") || "no statechart"}` };
  const target = join(root, WORKFLOWS_DIR, name);
  if (exists(target)) return { ok: false, reason: `${WORKFLOWS_DIR}/${name} already exists; not overwriting` };
  const activate = projectWorkflows(root).length === 0 && !exists(join(root, CONFIG_DOC));
  if (basename(flow).toLowerCase() === FLOW_FILE) copyTree(dir, target);
  else writeNew(join(target, FLOW_FILE), readText(flow).replace(/\r\n/g, "\n"));
  if (activate) writeAtomic(join(root, CONFIG_DOC), configText(name));
  const ignore = join(root, GEML_DIR, ".gitignore");
  if (!exists(ignore)) writeNew(ignore, GITIGNORE);
  return { ok: true, name, target, activated: activate };
}

/** Make an installed workflow the default for new work items. Only a directory that is there is a workflow: a name is not a path out of .geml/workflows. */
export function useWorkflow(root: string, name: string): { ok: true } | { ok: false; reason: string } {
  const have = projectWorkflows(root);
  if (!have.includes(name)) return { ok: false, reason: `no workflow "${name}" in ${WORKFLOWS_DIR} (have: ${have.join(", ") || "none"})` };
  writeAtomic(join(root, CONFIG_DOC), configText(name));
  return { ok: true };
}
