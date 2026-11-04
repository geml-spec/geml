// Godot, as the build uses it: where it is on this machine, importing a
// project, running a probe, exporting a preset, starting the exported game,
// the license texts the engine ships with, and which of a project's files an
// export carries. Every engine under engines/ offers these same names;
// src/build.mjs knows nothing of Godot beyond them.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../../src/error.mjs";
import reader from "./reader.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const name = "godot";
export const label = "Godot";
/** Where this machine's Godot is said: the build's `--godot`, else this variable, else PATH. */
export const variable = "GODOT_BIN";
/** The format reader geml checks this engine's files with. */
export const readerPath = join(here, "reader.mjs");

/** The executables an engine folder offers, the console build first. */
export function candidates(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) return [path];
  const files = readdirSync(path).filter((n) => statSync(join(path, n)).isFile());
  const pick = (test) => files.filter(test).sort().map((n) => join(path, n));
  const app = join(path, "Godot.app", "Contents", "MacOS", "Godot");
  return [
    ...pick((n) => /^godot.*_console\.exe$/i.test(n)),
    ...pick((n) => /^godot.*\.exe$/i.test(n) && !/_console\.exe$/i.test(n)),
    ...pick((n) => /^godot[\w.-]*$/i.test(n) && !/\.(exe|zip|tpz|txt|md|pck)$/i.test(n)),
    ...(existsSync(app) ? [app] : []),
  ];
}

/** Godot as this machine has it: `given` (--godot), else GODOT_BIN, else `godot` on PATH. */
export function locate(given, env = process.env) {
  const looked = [];
  for (const [where, value] of [["--godot", given], [variable, env[variable]], ["PATH", "godot"]]) {
    if (!value) continue;
    for (const exe of candidates(value)) {
      const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 60_000, env, windowsHide: true });
      const version = /\d+\.\d+(?:\.\d+)?\.[a-z][\w.]*/i.exec(r.stdout ?? "")?.[0];
      if (r.status === 0 && version) return { exe, version, where };
    }
    looked.push(`${where} (${value})`);
  }
  return fail(`Godot was not found (looked at ${looked.join(", ")}). `
    + "Unzip a Godot release from https://godotengine.org/download/archive/ and pass --godot <that folder>, "
    + `set ${variable} to it, or put \`godot\` on PATH.`);
}

/** Keep a folder out of any project it sits in: Godot imports what it finds. */
export function keepOut(dir) {
  writeFileSync(join(dir, ".gdignore"), "");
}

const ANSI = /\x1b\[[0-9;]*m/g;
const tail = (out, n = 3) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" / ");
const scriptErrors = (out) => out.split(/\r?\n/).filter((l) => /^\s*SCRIPT ERROR/.test(l)).map((l) => l.trim());

function run(exe, args, timeout) {
  const r = spawnSync(exe, args, { encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) fail(`${basename(exe)} did not run: ${r.error.message}`);
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(ANSI, "") };
}

export function importProject(engine, project) {
  const r = run(engine.exe, ["--headless", "--path", project, "--import"], 600_000);
  const errors = scriptErrors(r.out);
  if (r.code !== 0 || errors.length) fail(`Godot 退出码 ${r.code}：${errors[0] ?? tail(r.out)}`);
  return "引擎无界面导入";
}

/** What a probe printed: run headless in the project at a fixed 60 frames a second. */
export function runProbe(engine, project, script) {
  const r = run(engine.exe, ["--headless", "--path", project, "--fixed-fps", "60", "--script", script], 300_000);
  return { code: r.code, out: r.out, why: scriptErrors(r.out)[0] ?? tail(r.out) };
}

const PLATFORMS = { "Windows Desktop": "win32", Linux: "linux", "Linux/X11": "linux", macOS: "darwin" };

/** The export preset named `presetName`: the file it writes, and the platform that runs it. */
export function preset(project, presetName) {
  const cfg = join(project, "export_presets.cfg");
  if (!existsSync(cfg)) fail("项目里没有 `export_presets.cfg`");
  const configReader = reader.readers.find((r) => r.format === "godot-config");
  const sections = configReader.read(readFileSync(cfg, "utf8")).value;
  const found = Object.values(sections).find((s) => s && typeof s === "object" && s.name === presetName);
  if (!found) fail(`\`export_presets.cfg\` 里没有叫「${presetName}」的预设`);
  return {
    file: basename(String(found.export_path ?? "").replaceAll("\\", "/")),
    platform: PLATFORMS[found.platform] ?? null,
  };
}

export function exportRelease(engine, project, presetName, target) {
  const r = run(engine.exe, ["--headless", "--path", project, "--export-release", presetName, target], 600_000);
  if (r.code !== 0 || !existsSync(target)) {
    const hint = /template/i.test(r.out) ? `（${engine.version} 的导出模板装了吗？）` : "";
    fail(`导出失败${hint}：${tail(r.out)}`);
  }
}

/** Start the exported game, unpacked, headless; it must quit cleanly. */
export function startExported(exe) {
  const r = spawnSync(exe, ["--headless", "--quit-after", "300"], { encoding: "utf8", timeout: 120_000, windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(ANSI, "");
  if (r.error || r.status !== 0 || scriptErrors(out).length) fail(`解出来的游戏退出码 ${r.status}：${scriptErrors(out)[0] ?? tail(out)}`);
  return "无界面启动后正常退出";
}

/** The engine's own license and third-party notices, written into `dir` by the engine. */
export function writeLicenses(engine, dir) {
  const r = run(engine.exe, ["--headless", "--script", join(here, "licenses.gd"), "--", dir], 120_000);
  if (r.code !== 0 || !existsSync(join(dir, "GODOT-LICENSE.txt"))) fail(`引擎许可证没导出来：${tail(r.out)}`);
}

/** What CREDITS.txt says of the engine. */
export function creditLines(version) {
  return [`  Godot Engine ${version}. MIT License: licenses/GODOT-LICENSE.txt`,
    "  Third-party components compiled into the engine: licenses/GODOT-THIRDPARTY.txt"];
}

const ASSETS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".bmp", ".tga", ".exr", ".hdr",
  ".ogg", ".wav", ".mp3", ".flac", ".ttf", ".otf", ".woff", ".woff2", ".fnt", ".glb", ".gltf", ".obj", ".fbx", ".blend"]);

/** The asset files an export carries, project-relative with `/`. A folder with
 *  a `.gdignore`, and `.godot/`, are not part of the export, so not listed. */
export function assets(project, skip = []) {
  const out = [];
  const walk = (dir) => {
    if (existsSync(join(dir, ".gdignore")) || skip.some((s) => resolve(s) === resolve(dir))) return;
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (!entry.startsWith(".")) walk(path);
      } else if (ASSETS.has(entry.slice(entry.lastIndexOf(".")).toLowerCase())) {
        out.push(relative(project, path).split(sep).join("/"));
      }
    }
  };
  walk(project);
  return out;
}
