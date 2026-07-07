// Stubs for the Node built-ins that geml-parser imports for its CLI/history
// code paths. Those paths never run in the browser (the CLI block is gated by
// `process.argv` — an empty shim there — and history functions are never
// called from parse()). These exist only so the static `import`s resolve when
// the modules load in a browser:
//   - `geml codemap serve` maps node:* here via an import map (/_dist/_node-stub.js)
//   - the viewer/playground esbuild bundles alias node:* to this same file
// Calling any of these would be a bug, so they no-op harmlessly.

export const readFileSync = () => "";
export const writeFileSync = () => {};
export const existsSync = () => false;
export const basename = (p) => p;
export const dirname = (p) => p;
export const resolve = (...p) => p.join("/");
export const join = (...p) => p.join("/");
export const fileURLToPath = (u) => String(u);
export const spawnSync = () => ({ status: 1 });
export const createHash = () => ({
  update() { return this; },
  digest() { return ""; },
});

export default {};
