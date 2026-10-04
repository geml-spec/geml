// Shared TRUST GATE for codemap recipes (security fix C2 — RCE).
//
// A codemap's _index/refresh.json is COMMITTED DATA whose `steps[]` are run
// through a shell by `geml codemap refresh` (spawnSync(step,{shell:true})).
// Cloning a hostile repo and running `geml codemap refresh` — which the
// geml-code-graph skill, `serve --watch`, and a PostToolUse hook all trigger —
// would otherwise execute arbitrary commands. The old "up-to-date" guard is
// bypassable and does not gate execution.
//
// The fix content-addresses each recipe (a stable fingerprint of its steps)
// and records which recipes the user has EXPLICITLY approved, and for which
// codemap directory, in a store kept OUTSIDE any repo (so a repo can never
// pre-approve itself). refresh refuses to execute a recipe that is not
// approved for its own directory; build auto-trusts the recipe it just
// authored, for the directory it built (the user ran it there).
//
// Trust gates WHO may run a recipe. Security fix R2-1 additionally changed HOW
// steps are stored: a step is now a STRUCTURED object { cwd?, env?, argv:[...] }
// so attacker-controllable paths are never interpolated into a shell string at
// rest, and refresh executes them without an attacker-influenced command line.
// The fingerprint below canonicalizes that structured form.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";

export const RECIPE_VERSION = 1;   // on-disk step schema; bump ONLY on a real format change
// The trust store's shape: approvals filed under the REAL path of a codemap
// directory, then by recipe fingerprint. A store in any other shape trusts
// nothing.
export const TRUST_STORE_VERSION = 2;

// Canonicalize ONE recipe step for fingerprinting. Since security fix R2-1 a
// step is a STRUCTURED object { cwd?, env?, argv:[...] } (no shell string is
// ever stored). We emit a FIXED key order (cwd, env, argv), env keys SORTED so
// the fingerprint is independent of how the env map was built, and every value
// coerced to a string. Anything that is NOT a structured step (a legacy
// pre-R2-1 shell string, or a malformed entry) coerces to its String() form, so
// pre-existing string recipes keep the EXACT fingerprint they had before this
// change (backward compatible), while structured recipes get a stable identity.
function canonicalStep(step) {
  if (step && typeof step === "object" && Array.isArray(step.argv)) {
    const out = {};
    if (step.cwd != null) out.cwd = String(step.cwd);
    if (step.env && typeof step.env === "object") {
      const env = {};
      for (const k of Object.keys(step.env).sort()) env[k] = String(step.env[k]);
      out.env = env;
    }
    out.argv = step.argv.map((a) => String(a));
    return out;
  }
  return String(step);
}

// Fingerprint = sha256 over a canonical JSON of {root, steps}. build (when it
// records refresh.json) and refresh (when it is about to run it) both call
// this on the same parsed recipe object, so they agree exactly. `root` is
// included because it is the base dir every step runs under — the same steps
// under a different root are a different execution and deserve a different
// identity. Deterministic: fixed key order, canonicalized steps, no timestamps.
export function recipeFingerprint(recipe) {
  const steps = Array.isArray(recipe?.steps) ? recipe.steps.map(canonicalStep) : [];
  const root = recipe?.root == null ? "" : String(recipe.root);
  const canonical = JSON.stringify({ root, steps });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// Where the trust store lives — NEVER inside a repo. GEML_TRUST_STORE is an
// explicit override (test isolation / unusual homes). Otherwise it sits under
// the XDG config dir, falling back to ~/.config/geml, which is a sane
// cross-platform home (on Windows homedir() is C:\Users\<name>).
export function trustStorePath() {
  if (process.env.GEML_TRUST_STORE) return process.env.GEML_TRUST_STORE;
  const cfgHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(cfgHome, "geml", "trusted-recipes.json");
}

// Read the store DEFENSIVELY: a missing, unreadable, malformed or
// other-version store means "nothing is trusted". A broken store must never
// silently trust a recipe.
export function readTrustStore() {
  try {
    const obj = JSON.parse(readFileSync(trustStorePath(), "utf8"));
    if (isMap(obj) && obj.version === TRUST_STORE_VERSION && isMap(obj.recipes)) {
      return { version: TRUST_STORE_VERSION, recipes: obj.recipes };
    }
  } catch { /* missing / unreadable / malformed: treat as empty */ }
  return { version: TRUST_STORE_VERSION, recipes: {} };
}

const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// True only when this exact recipe has been approved for this exact codemap
// directory. The fingerprint alone is not enough: a recipe made of relative
// paths is byte-identical in every project indexed the same way, so an
// approval given in one checkout would run, unchanged, in a hostile clone. The
// directory is compared by its real path, so a symlink or a `..` spelling of
// it finds its approval and no other directory does; one that cannot be
// resolved is trusted with nothing.
export function isRecipeTrusted(fingerprint, graphDir) {
  let dir;
  try { dir = realpathSync(graphDir); } catch { return false; }
  const { recipes } = readTrustStore();
  return own(recipes, dir) && isMap(recipes[dir]) && own(recipes[dir], fingerprint);
}

// Record a recipe as trusted for one codemap directory, MERGING into any
// existing store (never clobbering other approvals). Creates parent dirs.
// Returns the store path. THROWS when the directory cannot be resolved or the
// store cannot be written: a caller that meant to trust must learn it did NOT,
// rather than proceed on the false belief that the recipe is now safe.
export function trustRecipe(fingerprint, graphDir) {
  const dir = realpathSync(graphDir);
  const store = readTrustStore();
  const approved = own(store.recipes, dir) && isMap(store.recipes[dir]) ? store.recipes[dir] : {};
  approved[fingerprint] = { addedAt: Date.now() };
  store.recipes[dir] = approved;
  const p = trustStorePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
  return p;
}
