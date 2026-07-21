// Node module-customization hook (registered via module.register in
// security.test.mjs). content.js imports its stylesheets as modules
// (`import css from "./geml.css"`, `import katexCss from "katex/dist/katex.css"`)
// — esbuild turns those into text at build time, but plain Node can't load a
// .css file as a module. This stubs every `*.css` import as an empty-string
// default export so the REAL content.js can be imported and driven directly in
// the test harness (used only to reach the M1/L3 guards that live in main()).
export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", source: 'export default "";', shortCircuit: true };
  }
  return nextLoad(url, context);
}
