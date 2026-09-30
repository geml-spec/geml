package org.geml.intellij

import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

object GemlFileType : LanguageFileType(GemlLanguage) {
  override fun getName(): String = "GEML"
  override fun getDescription(): String = "GEML document"
  override fun getDefaultExtension(): String = "geml"
  override fun getIcon(): Icon = GemlIcons.FILE
}
