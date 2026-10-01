package org.geml.intellij.lang

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as C
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.colors.TextAttributesKey.createTextAttributesKey
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.tree.IElementType
import java.awt.Font

/**
 * Colours, expressed as the platform's own semantic keys rather than literal
 * RGB. That is what makes a GEML file look like it belongs in whatever theme
 * the user has picked — Darcula, the Android Studio default, a high-contrast
 * scheme — without this plugin knowing any of them.
 */
object GemlSyntaxHighlighter : SyntaxHighlighterBase() {

  private fun key(name: String, fallback: TextAttributesKey) =
    createTextAttributesKey("GEML_$name", fallback)

  val COMMENT = key("COMMENT", C.LINE_COMMENT)
  val FENCE = key("FENCE", C.KEYWORD)
  val BLOCK_TYPE = key("BLOCK_TYPE", C.CLASS_NAME)
  val HEADING_MARK = key("HEADING_MARK", C.KEYWORD)
  val HEADING_TEXT = key("HEADING_TEXT", C.CONSTANT)
  val BRACE = key("BRACE", C.BRACES)
  val ATTR_ID = key("ATTR_ID", C.INSTANCE_FIELD)
  val ATTR_CLASS = key("ATTR_CLASS", C.STATIC_FIELD)
  val ATTR_NAME = key("ATTR_NAME", C.INSTANCE_FIELD)
  val OPERATOR = key("OPERATOR", C.OPERATION_SIGN)
  val STRING = key("STRING", C.STRING)
  val NUMBER = key("NUMBER", C.NUMBER)
  val BOOLEAN = key("BOOLEAN", C.KEYWORD)
  val CODE_SPAN = key("CODE_SPAN", C.STRING)
  val MATH = key("MATH", C.NUMBER)
  // Emphasis is the one place a fallback key will not do: the platform's
  // semantic colours carry no font style, and bold that is not bold is the
  // first thing an author notices. Colours stay null so the theme still owns
  // them, and only the style is stated here.
  val BOLD = createTextAttributesKey("GEML_BOLD", TextAttributes(null, null, null, null, Font.BOLD))
  val ITALIC = createTextAttributesKey("GEML_ITALIC", TextAttributes(null, null, null, null, Font.ITALIC))
  // Not STRIKEOUT: that effect draws in effectColor, and a null there means it
  // draws nothing. Greyed out like a comment reads as "struck" and inherits the
  // theme, which a hardcoded colour would not.
  val STRIKE = key("STRIKE", C.LINE_COMMENT)
  val REFERENCE = key("REFERENCE", C.HIGHLIGHTED_REFERENCE)
  val FOOTNOTE = key("FOOTNOTE", C.HIGHLIGHTED_REFERENCE)
  val LINK = key("LINK", C.HIGHLIGHTED_REFERENCE)
  val RAW = key("RAW", C.STRING)

  private val MAP: Map<IElementType, Array<TextAttributesKey>> = mapOf(
    GemlTokens.COMMENT to arrayOf(COMMENT),
    GemlTokens.FENCE to arrayOf(FENCE),
    GemlTokens.BLOCK_TYPE to arrayOf(BLOCK_TYPE),
    GemlTokens.HEADING_MARK to arrayOf(HEADING_MARK),
    GemlTokens.HEADING_TEXT to arrayOf(HEADING_TEXT),
    GemlTokens.BRACE to arrayOf(BRACE),
    GemlTokens.ATTR_ID to arrayOf(ATTR_ID),
    GemlTokens.ATTR_CLASS to arrayOf(ATTR_CLASS),
    GemlTokens.ATTR_NAME to arrayOf(ATTR_NAME),
    GemlTokens.OPERATOR to arrayOf(OPERATOR),
    GemlTokens.STRING to arrayOf(STRING),
    GemlTokens.NUMBER to arrayOf(NUMBER),
    GemlTokens.BOOLEAN to arrayOf(BOOLEAN),
    GemlTokens.CODE_SPAN to arrayOf(CODE_SPAN),
    GemlTokens.MATH to arrayOf(MATH),
    GemlTokens.BOLD to arrayOf(BOLD),
    GemlTokens.ITALIC to arrayOf(ITALIC),
    GemlTokens.STRIKE to arrayOf(STRIKE),
    GemlTokens.REFERENCE to arrayOf(REFERENCE),
    GemlTokens.FOOTNOTE to arrayOf(FOOTNOTE),
    GemlTokens.LINK to arrayOf(LINK),
    GemlTokens.RAW to arrayOf(RAW),
  )

  override fun getHighlightingLexer(): Lexer = GemlLexer()

  override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> =
    MAP[tokenType] ?: TextAttributesKey.EMPTY_ARRAY
}

class GemlSyntaxHighlighterFactory : SyntaxHighlighterFactory() {
  override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?): SyntaxHighlighter =
    GemlSyntaxHighlighter
}
