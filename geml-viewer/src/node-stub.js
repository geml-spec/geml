// Stubs for the Node built-ins that geml-parser imports for its CLI/history
// code paths. Those paths never run in the browser (the CLI block is gated out
// by `process.argv` → [] at build time, and history functions are never
// called from parse()). These stubs exist only so the static `import`s resolve
// when the bundle loads; calling them would be a bug, so they no-op loudly enough
// to be harmless.

export const readFileSync = () => "";
export const writeFileSync = () => {};
export const existsSync = () => false;
export const basename = (p) => p;
export const dirname = (p) => p;
export const resolve = (...p) => p.join("/");
export const createHash = () => ({
  update() { return this; },
  digest() { return ""; },
});

export default {};
