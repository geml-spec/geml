// Security regression tests for the GEML editor/CI integrations (branch
// sec/audit-fixes-r2). These are STATIC assertions over the checked-in
// integration manifests — no build, no process spawn — pinning two hardening
// fixes so they cannot silently regress:
//   R2-4  vscode extension: `geml.check.path` is machine-scoped and listed as a
//         restricted configuration, so an untrusted workspace can't point the
//         CLI invocation at an attacker-chosen binary.
//   R2-5  geml-check composite action: user inputs flow through `env:` (data),
//         never `${{ }}` interpolation into the shell body, and the `version`
//         input is validated — so a published action can't be shell-injected by
//         PR-derived data piped into its inputs.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// test/ -> geml-parser/ -> geml-spec/ ; the integrations live at the repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATIONS = join(HERE, "..", "..", "integrations");

// ---------------------------------------------------------------------------
// R2-4 — VS Code: geml.check.path must be machine-scoped + restricted
// ---------------------------------------------------------------------------
test("R2-4: vscode `geml.check.path` is machine-scoped and a restricted configuration", () => {
  const pkg = JSON.parse(readFileSync(join(INTEGRATIONS, "vscode", "package.json"), "utf8"));

  const prop = pkg?.contributes?.configuration?.properties?.["geml.check.path"];
  assert.ok(prop, "the geml.check.path configuration property is declared");
  assert.equal(prop.scope, "machine",
    "geml.check.path is machine-scoped (a workspace/folder cannot override the CLI invocation)");

  const restricted = pkg?.capabilities?.untrustedWorkspaces?.restrictedConfigurations;
  assert.ok(Array.isArray(restricted), "capabilities.untrustedWorkspaces.restrictedConfigurations is present");
  assert.ok(restricted.includes("geml.check.path"),
    "geml.check.path is listed as a restricted configuration for untrusted workspaces");
});

// ---------------------------------------------------------------------------
// R2-5 — geml-check composite action: inputs via env:, validated version
// ---------------------------------------------------------------------------
const ACTION = readFileSync(join(INTEGRATIONS, "geml-check-action", "action.yml"), "utf8");
// Isolate the composite step's shell body (everything after `run: |`).
const runIdx = ACTION.search(/\brun:\s*\|/);
const RUN_BODY = runIdx >= 0 ? ACTION.slice(runIdx) : "";

test("R2-5: action inputs are mapped through an env: block, not interpolated", () => {
  // An `env:` mapping carries the inputs as data (no shell metacharacter power).
  assert.match(ACTION, /\benv:/, "the composite step declares an env: block");
  assert.match(ACTION, /VERSION:\s*\$\{\{\s*inputs\.version\s*\}\}/, "VERSION env maps from inputs.version");
  assert.match(ACTION, /FILES:\s*\$\{\{\s*inputs\.files\s*\}\}/, "FILES env maps from inputs.files");
});

test("R2-5: the run body performs NO `${{ }}` interpolation (inputs stay in env)", () => {
  assert.ok(runIdx >= 0, "the composite step has a `run: |` shell body");
  assert.ok(!RUN_BODY.includes("${{"),
    "the shell body contains no `${{ }}` expansion — a PR-derived input cannot inject shell");
  // The body consumes the inputs via their environment variables instead.
  assert.match(RUN_BODY, /\$VERSION\b/, "the body reads $VERSION (the env-passed input)");
  assert.match(RUN_BODY, /\$FILES\b/, "the body reads $FILES (the env-passed input)");
});

test("R2-5: the version input is validated (semver/`latest` guard that rejects with ::error::)", () => {
  // A guard accepting only `latest` or a semver, and failing the step otherwise.
  assert.match(RUN_BODY, /=~/, "a regex match guards the version");
  assert.match(RUN_BODY, /\[0-9\]\+\\?\.\[0-9\]\+\\?\.\[0-9\]\+/, "the guard uses a semver (N.N.N) pattern");
  assert.match(RUN_BODY, /::error::/, "an invalid version emits a workflow ::error::");
  assert.match(RUN_BODY, /\bexit 1\b/, "an invalid version fails the step (exit 1)");
});

console.log(`\n${passed} test(s) passed.`);
