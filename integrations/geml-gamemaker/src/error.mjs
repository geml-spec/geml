/** What stops a build: said in the report, never a stack trace. */
export class BuildError extends Error {}

export function fail(message) {
  throw new BuildError(message);
}
