package org.geml.intellij.cli

import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * Which program a command names, decided without the working directory.
 *
 * Every CLI run happens in the document's folder, so nothing in that folder may
 * help choose what runs. A bare name is looked up in PATH's absolute entries
 * only — never `.` or an empty entry, which mean the current directory — and a
 * relative path is refused. So are package runners: they resolve the package
 * itself from the working directory's node_modules, and under `npx @geml/geml`
 * opening a cloned project's document would run that project's own copy.
 *
 * Plain JDK, so it is tested without an IDE.
 */
object GemlProgram {

  private val PACKAGE_RUNNERS = setOf("npx", "npm", "pnpm", "pnpx", "yarn", "bunx", "bun")

  /** Why `program` may not be run, or null when it may. */
  fun refusal(program: String): String? {
    val name = program.substringAfterLast('/').substringAfterLast('\\').lowercase()
      .replace(Regex("\\.(cmd|bat|exe|ps1)$"), "")
    if (name !in PACKAGE_RUNNERS) return null
    return "`$name` would run whatever @geml/geml the opened project's node_modules holds. Leave the " +
      "command empty to use the parser bundled with this plugin, or give an installed CLI's absolute path."
  }

  /**
   * The absolute path `name` stands for: itself when it is absolute, else the
   * first match in PATH's absolute entries — trying PATHEXT's extensions on
   * Windows, as cmd.exe would. Null when there is none, or `name` is relative.
   */
  fun resolve(name: String, path: String?, pathExt: String?, windows: Boolean): Path? {
    val given = runCatching { Path.of(name) }.getOrNull() ?: return null
    if (given.isAbsolute) return given.takeIf { isProgram(it, windows) }
    if (name.isEmpty() || name.contains('/') || name.contains('\\')) return null
    val exts = if (!windows) {
      listOf("")
    } else {
      val all = (pathExt ?: ".COM;.EXE;.BAT;.CMD").split(';').filter { it.isNotEmpty() }
      if (all.any { name.endsWith(it, ignoreCase = true) }) listOf("") else all
    }
    for (dir in searchPath(path)) {
      for (ext in exts) {
        val candidate = dir.resolve(name + ext)
        if (isProgram(candidate, windows)) return candidate
      }
    }
    return null
  }

  /** PATH's absolute entries. */
  fun searchPath(path: String?): List<Path> =
    (path ?: "").split(File.pathSeparatorChar)
      .filter { it.isNotEmpty() }
      .mapNotNull { runCatching { Path.of(it) }.getOrNull() }
      .filter { it.isAbsolute }

  private fun isProgram(p: Path, windows: Boolean): Boolean =
    Files.isRegularFile(p) && (windows || Files.isExecutable(p))
}
