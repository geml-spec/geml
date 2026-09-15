# zig-app — tree-sitter fixture (Zig)

Three Zig files that exercise every name-resolution layer of the codemap
tree-sitter fallback (`codemap/treesitter/zig.mjs` → `treesitter-export.mjs` →
`adapters/treesitter.mjs`): a file import (`@import("net.zig")`), an alias
rooted in an import (`@import("net.zig").Client`), a re-export
(`pub const Reexported = @import("util.zig").Util`), a named container with
`@This()`, `self.` calls, a struct-namespace call, an external package (`std`),
an unbound receiver with a unique name (`c.connect()`) and an ambiguous one
(`c.send()` — `Client.send` vs `Util.send`), and a `test` block whose call must
not become an edge.

Nothing is pre-baked: `test/treesitter.test.mjs` parses these files with the
real grammar (web-tree-sitter + tree-sitter-wasms are devDependencies) and
pins the resulting tables and edges.

There is deliberately **no `build.zig`** here: a Zig manifest inside the geml
repo would make language auto-detection see the whole checkout as a Zig
project and spawn the npx-backed indexer on every self-codemap build. The
detection tests create their own `build.zig` in a temp dir.
