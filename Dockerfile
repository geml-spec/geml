# The geml MCP server, for directories that run a server to inspect it — Glama
# (glama.ai) builds this image, starts it, and reads the tools over stdio.
#
#   docker build -t geml-mcp .
#   docker run -i --rm -v "$PWD:/workspace" geml-mcp
#
# Built from this checkout, so the image is the parser on this commit. The
# parser has no runtime dependencies: TypeScript is needed to build, then pruned.
# The server reads and writes documents under /workspace only (--root).
FROM node:22-slim

WORKDIR /opt/geml
COPY geml-parser/package.json geml-parser/package-lock.json ./
RUN npm ci --ignore-scripts
COPY geml-parser/ ./
RUN npm run build && npm prune --omit=dev

WORKDIR /workspace
ENTRYPOINT ["node", "/opt/geml/dist/geml.js", "mcp", "--root", "/workspace"]
