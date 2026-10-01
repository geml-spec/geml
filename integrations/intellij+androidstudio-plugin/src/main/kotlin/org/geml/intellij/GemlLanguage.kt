package org.geml.intellij

import com.intellij.lang.Language

object GemlLanguage : Language("GEML") {
  private fun readResolve(): Any = GemlLanguage
  override fun getDisplayName(): String = "GEML"
  override fun isCaseSensitive(): Boolean = true
}
