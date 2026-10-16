// One file for the Claude Code plugin: dist/gemflow.mjs is the CLI with
// @geml/geml inlined, so an installed plugin starts it with no dependency
// install. Node's built-ins stay external.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The parser hands `node …/dist/geml.js` over to its CLI when that file is the
// script being run. Inlined, "that file" is the bundle itself, so the guard
// would fire and start dist/cli.js beside the bundle. The line goes; when it
// moves, the build fails here instead of in a person's session.
const HANDOFF = "if (isCliInvocation()) {";
const noParserHandoff = {
  name: "no-parser-cli-handoff",
  setup(b) {
    b.onLoad({ filter: /[\\/]dist[\\/]geml\.js$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      if (!src.includes(HANDOFF)) throw new Error(`${args.path}: the parser's CLI hand-off moved; update scripts/bundle.mjs`);
      return { contents: src.replace(HANDOFF, "if (false) {"), loader: "js" };
    });
  },
};

await build({
  entryPoints: [`${root}src/cli.ts`],
  outfile: `${root}dist/gemflow.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  plugins: [noParserHandoff],
});
