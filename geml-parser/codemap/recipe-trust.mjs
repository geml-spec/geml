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
// and records which fingerprints the user has EXPLICITLY approved in a store
// kept OUTSIDE any repo (so a repo can never pre-approve itself). refresh
// refuses to execute a recipe whose fingerprint is not in the store; build
// auto-trusts the recipe it just authored (the user ran it locally).
//
// The recipe format is unchanged: recipes legitimately need shell composition
// (`cd X && cmd`, redirects, `call joern.bat`, …). We gate WHO may run them,
// not HOW they are written.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// Fingerprint = sha256 over a canonical JSON of {root, steps}. build (when it
// records refresh.json) and refresh (when it is about to run it) both call
// this on the same parsed recipe object, so they agree exactly. `root` is
// included because it is the cwd every step runs in — the same steps under a
// different root are a different execution and deserve a different identity.
// Deterministic: fixed key order, steps coerced to strings, no timestamps.
export function recipeFingerprint(recipe) {
  const steps = Array.isArray(recipe?.steps) ? recipe.steps.map((s) => String(s)) : [];
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

// Read the store DEFENSIVELY: a missing, unreadable, or malformed store means
// "nothing is trusted". A broken store must never silently trust a recipe.
export function readTrustStore() {
  try {
    const obj = JSON.parse(readFileSync(trustStorePath(), "utf8"));
    if (obj && typeof obj === "object" && obj.recipes && typeof obj.recipes === "object") {
      return { version: obj.version || 1, recipes: obj.recipes };
    }
  } catch { /* missing / unreadable / malformed: treat as empty */ }
  return { version: 1, recipes: {} };
}

// True only when this exact recipe fingerprint has been approved.
export function isRecipeTrusted(fingerprint) {
  const store = readTrustStore();
  return Object.prototype.hasOwnProperty.call(store.recipes, fingerprint);
}

// Record a fingerprint as trusted, MERGING into any existing store (never
// clobbering other approvals). Creates parent dirs. Returns the store path.
// THROWS on write failure: a caller that meant to trust must learn it did NOT,
// rather than proceed on the false belief that the recipe is now safe.
export function trustRecipe(fingerprint, graphDir) {
  const store = readTrustStore();
  store.recipes[fingerprint] = { graphDir: graphDir ? String(graphDir) : undefined, addedAt: Date.now() };
  const p = trustStorePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
  return p;
}
