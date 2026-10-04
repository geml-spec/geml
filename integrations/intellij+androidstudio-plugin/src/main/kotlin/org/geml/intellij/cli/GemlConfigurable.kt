package org.geml.intellij.cli

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

/**
 * Settings | Tools | GEML.
 *
 * Three fields, and the plugin works with all three left alone: the parser ships
 * inside it and Node is looked up on PATH. They exist for the two machines that
 * need them — Node installed somewhere unusual, or a contributor who wants the
 * pane to answer from their own working copy of the CLI rather than the
 * released one.
 */
class GemlConfigurable : BoundConfigurable("GEML") {

  private val state = GemlSettings.getInstance().state
  private lateinit var command: JBTextField

  override fun createPanel(): DialogPanel = panel {
    row {
      checkBox("Check documents as you type")
        .bindSelected(state::checkEnabled)
        .comment("Runs `geml check` in the background and reports what it finds, the same way CI would.")
    }
    row("Node executable:") {
      textField()
        .bindText(state::nodePath)
        .columns(36)
        .comment("Leave empty to use `node` from PATH. Node is the only thing the plugin needs installed.")
    }
    row("GEML command:") {
      command = textField()
        .bindText(state::cliOverride)
        .columns(36)
        .comment(
          "Leave empty to use the parser bundled with this plugin — recommended, because then the " +
            "plugin and the parser answering it can never be different versions. Set it to run your " +
            "own instead: <code>geml</code> from PATH, or an absolute path. Package runners such as " +
            "<code>npx</code> are refused: they would run whatever @geml/geml the opened project's " +
            "node_modules holds."
        )
        .component
    }
  }

  // GemlCli refuses a package runner whenever it would run; refusing it here
  // too says so while the setting is being typed, not later in a balloon.
  override fun apply() {
    val program = command.text.trim().split(Regex("\\s+")).first()
    if (program.isNotEmpty()) GemlProgram.refusal(program)?.let { throw ConfigurationException(it) }
    super.apply()
  }
}
