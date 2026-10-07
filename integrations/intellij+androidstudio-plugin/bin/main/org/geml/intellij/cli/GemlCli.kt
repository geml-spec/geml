package org.geml.intellij.cli

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.execution.process.ProcessOutput
import com.intellij.ide.impl.isTrusted
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The one place this plugin talks to the GEML CLI.
 *
 * Nothing here parses GEML. The CLI is the reference implementation and it
 * already answers every question an editor needs to ask — `check --json` for
 * diagnostics, `list --json` for the block index — so the editor's answers can
 * never disagree with what `geml check` says in CI.
 *
 * The CLI it runs is the copy that SHIPPED WITH THIS PLUGIN. The parser's dist/
 * has no runtime dependencies, so carrying it costs a few hundred kilobytes and
 * buys the whole installation story: one zip, no `npm i -g`, no PATH to set,
 * and no way for the plugin and the parser answering it to be different
 * versions. Node is the only thing the user still has to have. A user who would
 * rather run their own build says so in Settings | Tools | GEML.
 *
 * Unlike the VS Code extension this is ported from, there is no shell here:
 * GeneralCommandLine hands argv to the OS directly on every platform, so the
 * Windows quoting hazards that file has to defend against (`&`, `^`, `%VAR%`
 * surviving quotes) simply do not arise. Ids are still whitelisted before they
 * reach argv, because an id comes from the document and a whitelist of what ids
 * legitimately look like is a tighter statement than a blacklist.
 */
object GemlCli {

  private val LOG = logger<GemlCli>()
  private const val PLUGIN_ID = "org.geml.intellij"
  private const val TIMEOUT_MS = 15_000

  /** Reported once per session: a wall of identical popups helps nobody. */
  private val warned = AtomicBoolean(false)

  /** What a run produced. `code` is null when the process had to be killed. */
  class Result(val code: Int?, val stdout: String, val stderr: String) {
    val ok: Boolean get() = code != null
  }

  /**
   * Exactly what §4's normative heading-derivation can produce — Unicode
   * letters, digits, `-`, `_` — plus `.` and `:`, which explicit ids use for
   * namespacing. An id carrying anything else is legal GEML that this editor
   * declines to pass on the command line; the CLI itself still handles it.
   */
  private val SAFE_ID = Regex("^[\\p{L}\\p{N}_\\-.:]+$")

  fun isSafeId(id: String): Boolean = id.isNotEmpty() && id.length <= 200 && SAFE_ID.matches(id)

  /** Where the bundled parser lives, once the plugin is installed. */
  private val bundledCli: Path? by lazy {
    val root = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath
    val cli = root?.resolve("geml")?.resolve("cli.js")
    if (cli != null && Files.isRegularFile(cli)) cli else null
  }

  /** The command prefix every verb is appended to, its program an absolute path. */
  private fun invocation(): List<String>? {
    val settings = GemlSettings.getInstance().state

    val override = settings.cliOverride.trim()
    if (override.isNotEmpty()) {
      val parts = override.split(Regex("\\s+"))
      return locate(parts[0])?.let { listOf(it) + parts.drop(1) }
    }

    val cli = bundledCli
    if (cli == null) {
      // Only reachable if the distribution was assembled without the bundled
      // runtime — a build problem, not something a user can fix by installing
      // Node, so say which knob exists rather than guessing.
      complain(
        "The GEML plugin is missing its bundled parser. Set a command in " +
          "Settings | Tools | GEML (for example the absolute path of an installed `geml`)."
      )
      return null
    }
    val node = locate(settings.nodePath.trim().ifEmpty { "node" }) ?: return null
    return listOf(node, cli.toString())
  }

  /**
   * A program's absolute path, found through the IDE's shell environment the
   * way GeneralCommandLine would — but never in the working directory (see
   * GemlProgram). Null, after saying why, when it cannot be run.
   */
  private fun locate(program: String): String? {
    GemlProgram.refusal(program)?.let {
      complain("Not running the command set in Settings | Tools | GEML: $it")
      return null
    }
    val found = GemlProgram.resolve(program, EnvironmentUtil.getValue("PATH"), EnvironmentUtil.getValue("PATHEXT"), SystemInfo.isWindows)
    if (found == null) {
      complain("Could not find `$program` on PATH. Install it, or set its absolute path in Settings | Tools | GEML.")
      return null
    }
    return found.toString()
  }

  /**
   * Run a verb. `workDir` carries the document's directory so relative
   * cross-document references resolve the way they do on the command line;
   * `stdin` is the buffer as it is NOW, which is what `-` in the args means.
   *
   * Returns null when the CLI could not be run at all, or may not run: nothing
   * runs for a project the user has not trusted. Every caller has a sensible
   * "then do nothing" behaviour: a missing Node must not turn into a wall of
   * red in the editor.
   */
  fun run(
    project: Project,
    args: List<String>,
    workDir: Path? = null,
    stdin: String? = null,
    /**
     * Passed by the live searches. Search Everywhere starts a run per keystroke
     * and abandons it on the next one; without this, an abandoned search would
     * keep walking the tree until the timeout, several deep at a time.
     */
    indicator: ProgressIndicator? = null,
  ): Result? {
    // Safe mode runs nothing: a project opened without trust decides what its
    // documents say, and must not get a say in what opening one starts. Every
    // process starts here, so this is the one gate.
    if (!project.isTrusted()) return null
    val prefix = invocation() ?: return null

    val command = GeneralCommandLine(prefix + args)
      .withCharset(StandardCharsets.UTF_8)
    if (workDir != null) command.withWorkingDirectory(workDir)
    // The program is an absolute path already; what it starts in turn is not.
    // A relative PATH entry would name the document's folder to a script's
    // `#!/usr/bin/env node`, and on Windows cmd.exe tries the current directory
    // before PATH for the `node` an npm .cmd shim calls unless told not to.
    EnvironmentUtil.getValue("PATH")?.let { command.withEnvironment("PATH", GemlProgram.searchPath(it).joinToString(File.pathSeparator)) }
    if (SystemInfo.isWindows) command.withEnvironment("NoDefaultCurrentDirectoryInExePath", "1")

    val output: ProcessOutput
    try {
      val handler = CapturingProcessHandler(command)
      if (stdin != null) {
        // On another thread: a document larger than the pipe buffer would
        // otherwise block this one before anybody starts draining stdout, and
        // the two would wait for each other until the timeout.
        ApplicationManager.getApplication().executeOnPooledThread {
          try {
            handler.processInput.use { it.write(stdin.toByteArray(StandardCharsets.UTF_8)) }
          } catch (e: Exception) {
            LOG.debug("geml: writing stdin failed", e)   // the process died first
          }
        }
      } else {
        runCatching { handler.processInput.close() }
      }
      output = if (indicator != null) handler.runProcessWithProgressIndicator(indicator, TIMEOUT_MS, true)
               else handler.runProcess(TIMEOUT_MS, true)
    } catch (e: Exception) {
      LOG.info("geml: could not start ${prefix.joinToString(" ")}", e)
      complain(
        "Could not start the GEML parser: ${e.message}. It needs Node on your PATH — " +
          "set the path in Settings | Tools | GEML if it is installed elsewhere."
      )
      return null
    }

    if (output.isTimeout) {
      LOG.info("geml: ${args.joinToString(" ")} timed out")
      return null
    }
    return Result(output.exitCode, output.stdout, output.stderr)
  }

  private fun complain(message: String) {
    if (!warned.compareAndSet(false, true)) return
    NotificationGroupManager.getInstance()
      .getNotificationGroup("GEML")
      .createNotification("GEML", message, NotificationType.WARNING)
      .notify(null)
  }
}
