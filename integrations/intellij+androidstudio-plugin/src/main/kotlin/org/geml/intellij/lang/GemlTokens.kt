package org.geml.intellij.lang

import com.intellij.psi.tree.IElementType
import org.geml.intellij.GemlLanguage

class GemlTokenType(debugName: String) : IElementType(debugName, GemlLanguage) {
  override fun toString(): String = "GEML:" + super.toString()
}

/**
 * What the highlighter can tell apart. Deliberately the same set the VS Code
 * TextMate grammar names (integrations/vscode/syntaxes/geml.tmLanguage.json), so
 * a document does not change shape when an author moves between the two editors.
 */
object GemlTokens {
  val COMMENT = GemlTokenType("COMMENT")

  val FENCE = GemlTokenType("FENCE")
  val BLOCK_TYPE = GemlTokenType("BLOCK_TYPE")

  val HEADING_MARK = GemlTokenType("HEADING_MARK")
  val HEADING_TEXT = GemlTokenType("HEADING_TEXT")

  val BRACE = GemlTokenType("BRACE")
  val ATTR_ID = GemlTokenType("ATTR_ID")
  val ATTR_CLASS = GemlTokenType("ATTR_CLASS")
  val ATTR_NAME = GemlTokenType("ATTR_NAME")
  val OPERATOR = GemlTokenType("OPERATOR")
  val STRING = GemlTokenType("STRING")
  val NUMBER = GemlTokenType("NUMBER")
  val BOOLEAN = GemlTokenType("BOOLEAN")

  val CODE_SPAN = GemlTokenType("CODE_SPAN")
  val MATH = GemlTokenType("MATH")
  val BOLD = GemlTokenType("BOLD")
  val ITALIC = GemlTokenType("ITALIC")
  val STRIKE = GemlTokenType("STRIKE")
  val REFERENCE = GemlTokenType("REFERENCE")
  val FOOTNOTE = GemlTokenType("FOOTNOTE")
  val LINK = GemlTokenType("LINK")

  val TEXT = GemlTokenType("TEXT")

  /** The body of a block whose content is not prose — see RAW_BODY_TYPES. */
  val RAW = GemlTokenType("RAW")
}
