// The `run` verb: find dsh, make sure this bundle is in the profile, hand the
// task over. It copies no harness logic — every decision below is about
// LOCATING and INVOKING dsh, and the exit code is passed straight through.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** How `dsh` will be invoked, and whether that route needs a shell. */
export interface Launcher {
  command: string;
  /** Arguments that precede dsh's own (the `npx` route carries two). */
  prefix: string[];
  /**
   * True only for a Windows `.cmd` / `.bat` shim, which Node refuses to spawn
   * without one. See `warnAboutPercent`.
   */
  shell: boolean;
  /** How the launcher was found, for the message when something goes wrong. */
  how: "PATH" | "npx";
}

/**
 * Find an executable on PATH, honouring PATHEXT on Windows.
 *
 * Node has no `which`, and guessing wrong here is the difference between a
 * clear message and a confusing ENOENT from deep inside a spawn.
 */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const paths = (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter((p) => p.length > 0);
  const exts = process.platform === "win32"
    ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.length > 0)
    : [""];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable. Keep looking.
      }
    }
  }
  return undefined;
}

/** Decide how to invoke dsh: the one on PATH, else `npx -y @deepseek-ai/dsh`. */
export function launcherFor(env: NodeJS.ProcessEnv = process.env): Launcher {
  const found = resolveOnPath("dsh", env);
  if (found !== undefined) {
    const shim = /\.(cmd|bat)$/i.test(found);
    return { command: found, prefix: [], shell: shim, how: "PATH" };
  }
  const npx = resolveOnPath("npx", env) ?? "npx";
  return {
    command: npx,
    prefix: ["-y", "@deepseek-ai/dsh"],
    shell: /\.(cmd|bat)$/i.test(npx),
    how: "npx",
  };
}

/**
 * Whether a task will survive the Windows shell unchanged.
 *
 * Only `%` is at issue: quoting protects `&`, `|` and friends, but `cmd.exe`
 * expands `%NAME%` even inside quotes, and there is no escape for it on a
 * command line. The model would then be handed text the user did not write, so
 * this is said out loud rather than silently tolerated.
 */
export function warnAboutPercent(task: string, shell: boolean): string | undefined {
  if (!shell || !task.includes("%")) return undefined;
  return "the task contains `%`, which the Windows shell may expand before dsh sees it; check the text dsh receives, or run the two commands below by hand";
}

export interface RunOptions {
  profile: string;
  task: string;
  /** Substituted by tests; defaults to a real spawn. */
  spawn?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
  note?: (line: string) => void;
}

/**
 * Add the bundle to the profile, then run the task under it.
 *
 * @returns dsh's own exit code, or 1 when dsh could not be reached at all.
 */
export function run(options: RunOptions): number {
  const spawn = options.spawn ?? spawnSync;
  const env = options.env ?? process.env;
  const note = options.note ?? ((line: string) => process.stderr.write(line + "\n"));
  const launcher = launcherFor(env);
  const dsh = [launcher.command, ...launcher.prefix].join(" ");

  const percent = warnAboutPercent(options.task, launcher.shell);
  if (percent) note(`geml-agent: ${percent}`);

  const add = spawn(
    launcher.command,
    [...launcher.prefix, "plugin", "--profile", options.profile, "add", "@geml/agent-runtime"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: launcher.shell, env },
  );
  if (add.error !== undefined || add.status !== 0) {
    note(`geml-agent: could not add the bundle to profile "${options.profile}" with ${dsh}`);
    if (add.stderr) note(String(add.stderr).trimEnd());
    note(`geml-agent: run these two by hand instead:`);
    note(`  ${dsh} plugin --profile ${options.profile} add @geml/agent-runtime`);
    note(`  ${dsh} --profile ${options.profile} "<your task>"`);
    return 1;
  }

  const ran = spawn(
    launcher.command,
    [...launcher.prefix, "--profile", options.profile, options.task],
    { stdio: "inherit", shell: launcher.shell, env },
  );
  if (ran.error !== undefined) {
    note(`geml-agent: ${dsh} could not be started: ${ran.error.message}`);
    return 1;
  }
  return ran.status ?? 1;
}
