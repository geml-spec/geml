package org.geml.intellij.cli

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Application-level, not project-level, and on purpose: both fields name
 * programs on this machine. A project-scoped "which binary to run" setting is a
 * setting a shared repository can carry, and then opening someone else's
 * project runs their choice of executable.
 */
@State(name = "GemlSettings", storages = [Storage("geml.xml")])
class GemlSettings : PersistentStateComponent<GemlSettings.State> {

  class State {
    /** How to start Node. Empty means `node`, found on PATH. */
    @JvmField var nodePath: String = ""

    /**
     * A complete command to run INSTEAD of the bundled parser, split on spaces —
     * for example `geml`, or `npx @geml/geml`. Empty means use the copy that
     * shipped with the plugin, which is the case this plugin is built around:
     * one install, one version, nothing to keep in step.
     */
    @JvmField var cliOverride: String = ""

    /** Whether to run `geml check` as you type and report what it finds. */
    @JvmField var checkEnabled: Boolean = true
  }

  private var state = State()
  override fun getState(): State = state
  override fun loadState(from: State) = XmlSerializerUtil.copyBean(from, state)

  companion object {
    fun getInstance(): GemlSettings = ApplicationManager.getApplication().getService(GemlSettings::class.java)
  }
}
