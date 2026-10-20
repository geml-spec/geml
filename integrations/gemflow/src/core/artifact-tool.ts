// The words about artifacts the hooks need without the parser: the tool the
// model records a artifact with, and the link a publish tool's result names.
// Pure, and free of @geml/geml: the hooks module imports it.

/** A link a publish tool's result names: `Published … at <url> (Version N …)`, the Artifact tool's words. */
export function publishedLink(result: string): { url: string; version?: string } | undefined {
  const m = /\bPublished\b[^\n]*?\bat (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)(?:\s*\(Version (\d+))?/.exec(result);
  if (m === null) return undefined;
  return { url: m[1] as string, ...(m[2] !== undefined ? { version: m[2] } : {}) };
}

/** The tool the model records a artifact with that gemflow does not see made: a link it shared, a picture it generated. */
export const ARTIFACT_TOOL = {
  name: "artifact",
  description: "Record something this work item made that gemflow cannot see by itself, so the board lists it under the work item's artifacts: a link (an online document, a published page, a design) or a generated picture or file. Files written with the write tools, commits, and pages published with the Artifact tool are recorded already; do not record those.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["link", "image", "file"], description: "link: an address; image or file: a file on this machine." },
      name: { type: "string", description: "What it is, in a few words (a link's title)." },
      where: { type: "string", description: "The link's address, or the file's path." },
      version: { type: "string", description: "The version its publisher gave it, when it gave one." },
    },
    required: ["kind", "where"],
    additionalProperties: false,
  },
} as const;
