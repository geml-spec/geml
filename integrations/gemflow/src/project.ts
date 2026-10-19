// The workflows a project holds and which one is the default: a workflow is
// one file in the project's home, `.geml/workflows/<name>.geml` — a bundled or
// imported workflow's statechart and stage texts taken into one — its tools
// joining the project's one dictionary, `.geml/tools.geml`; `.geml/project.geml`
// names the default, the workflow a new work item starts under (an item with a
// journal keeps the one its journal names). Shared by the CLI's init and use
// and the Claude Code bridge's add, import and use.
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadStatechart, type Statechart } from "./core/statechart.js";
import { fileURLToPath } from "node:url";
import { exists, readText, writeAtomic } from "./host-fs.js";
import { FLOW_FILE, GEML_DIR, PROJECT_DOC, WORKFLOWS_DIR } from "./core/layout.js";
import { TOOLS_FILE } from "./core/dictionary.js";
import { withItemState } from "./core/item-state.js";
import { dictionaryPathOf, ensureGitignore, GITIGNORE, homeOf, installedWorkflows, mergedWorkflow, mergeTools, projectDocOf, readIn, writeWorkflow } from "./project-home.js";

export { GITIGNORE };

/** The package's own workflows, beside dist/ — the same path from dist/project.js and from the bundle. */
const BUNDLED = fileURLToPath(new URL("../workflows/", import.meta.url));

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

/** The workflows a project has, by name: its home's files, and the earlier layout's directories. */
export function projectWorkflows(root: string): string[] {
  return installedWorkflows(root).map((w) => w.name);
}

/** The project's config document naming `name` as the active workflow. */
export function configText(name: string): string {
  return ["=== meta", 'title         = "Gemflow"', `flow-workflow = ${JSON.stringify(name)}`, "===", ""].join("\n");
}

/** Make `name` the default in the home's project document: only its `flow-workflow` changes; the earlier document's text is where a new one starts. */
function setDefault(root: string, home: string, name: string): void {
  const doc = projectDocOf(root, home);
  const text = doc === undefined ? undefined : withItemState(readText(doc), "flow-workflow", name);
  writeAtomic(join(home, PROJECT_DOC), text ?? configText(name));
}

/** The uses a workflow's states declare. */
const usesOf = (sc: Statechart): Set<string> => new Set([...sc.states.values()].flatMap((s) => s.uses));

/** A workflow written (`target` is its file), or why not: 2 for a name the package does not ship, 1 for a workflow of that name the project has. */
export type Added =
  | { ok: true; name: string; target: string; activated: boolean }
  | { ok: false; code: 1; reason: string; target: string }
  | { ok: false; code: 2; reason: string };

/** Write the bundled workflow `name` into the project's home as one file, add its tools to the project's dictionary, and make it active when asked. */
export function addWorkflow(root: string, name: string, o: { activate: boolean }): Added {
  const names = bundledWorkflows();
  if (!names.includes(name)) return { ok: false, code: 2, reason: `unknown template "${name}"; expected ${names.join(" or ")}` };
  const home = homeOf(root);
  const target = join(home, WORKFLOWS_DIR, `${name}.geml`);
  if (installedWorkflows(root, home).some((w) => w.name === name)) return { ok: false, code: 1, reason: `${WORKFLOWS_DIR}/${name}.geml already exists; not overwriting`, target };
  const dir = join(BUNDLED, name);
  writeWorkflow(home, name, mergedWorkflow(name, readText(join(dir, FLOW_FILE)), (f) => readIn(dir, f)));
  const tools = readIn(dir, TOOLS_FILE);
  if (tools !== undefined) mergeTools(home, tools);
  if (o.activate) setDefault(root, home, name);
  ensureGitignore(join(home, GEML_DIR));
  return { ok: true, name, target, activated: o.activate };
}

export type Imported = { ok: true; name: string; target: string; activated: boolean } | { ok: false; reason: string };

/**
 * Write a workflow from a path into the project's home (spec §8.7): a
 * directory holding a `flow.geml` (its guide taken in, its dictionary's rows
 * added to the project's), a `flow.geml` (its directory), or any other
 * `.geml` file (its dictionary's rows bound to the workflow's uses added).
 * The flow must load without errors; a name the project has a workflow of is
 * refused. The first workflow of a project becomes its default.
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
  if (!/^[\p{L}\p{N}._-]+$/u.test(name) || name.startsWith(".")) return { ok: false, reason: `"${name}" cannot name a workflow` };
  const loaded = loadStatechart(readText(flow), flow);
  const errors = loaded.diagnostics.filter((d) => d.severity === "error");
  if (loaded.statechart === undefined || errors.length > 0) return { ok: false, reason: `${path} does not load: ${errors.map((d) => d.message).join("; ") || "no statechart"}` };
  const home = homeOf(root);
  const installed = installedWorkflows(root, home);
  const target = join(home, WORKFLOWS_DIR, `${name}.geml`);
  if (installed.some((w) => w.name === name)) return { ok: false, reason: `${WORKFLOWS_DIR}/${name}.geml already exists; not overwriting` };
  const activate = installed.length === 0 && projectDocOf(root, home) === undefined;
  writeWorkflow(home, name, mergedWorkflow(name, readText(flow), (f) => readIn(dir, f)));
  // A directory's dictionary is the workflow's own; any other is a project's, of which only the rows this workflow uses come along.
  const dict = dictionaryPathOf(flow);
  if (exists(dict)) mergeTools(home, readText(dict), basename(flow).toLowerCase() === FLOW_FILE ? undefined : usesOf(loaded.statechart));
  if (activate) setDefault(root, home, name);
  ensureGitignore(join(home, GEML_DIR));
  return { ok: true, name, target, activated: activate };
}

/** Make an installed workflow the default for new work items. Only a workflow the project has is one: a name is not a path out of .geml/workflows. */
export function useWorkflow(root: string, name: string): { ok: true } | { ok: false; reason: string } {
  const have = projectWorkflows(root);
  if (!have.includes(name)) return { ok: false, reason: `no workflow "${name}" in ${WORKFLOWS_DIR} (have: ${have.join(", ") || "none"})` };
  setDefault(root, homeOf(root), name);
  return { ok: true };
}
