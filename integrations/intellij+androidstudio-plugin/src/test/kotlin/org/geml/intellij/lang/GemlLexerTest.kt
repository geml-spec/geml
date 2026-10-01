package org.geml.intellij.lang

import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The lexer is the only part of this plugin that reads GEML without asking the
 * CLI, so it is the only part that can be wrong on its own.
 *
 * The first test is the one that matters most, and it is not about colours: the
 * platform ASSERTS that a lexer's tokens tile its range with no gap and no
 * overlap. Break that and every `.geml` file throws on open. It is also exactly
 * the kind of thing an off-by-one in the CRLF or end-of-file handling breaks
 * without changing anything visible, which is why it is checked over a document
 * carrying every construct at once rather than over a happy path.
 */
class GemlLexerTest {

  private fun lex(text: String): List<Triple<IElementType, Int, Int>> {
    val lexer = GemlLexer()
    lexer.start(text, 0, text.length, 0)
    val out = ArrayList<Triple<IElementType, Int, Int>>()
    while (true) {
      val type = lexer.tokenType ?: break
      out.add(Triple(type, lexer.tokenStart, lexer.tokenEnd))
      lexer.advance()
    }
    return out
  }

  /** Every token type covering a given substring, for readable assertions. */
  private fun typesOf(text: String, needle: String): List<IElementType> {
    val at = text.indexOf(needle)
    require(at >= 0) { "no $needle in the sample" }
    return lex(text).filter { it.second < at + needle.length && it.third > at }.map { it.first }
  }

  private fun assertTiles(text: String) {
    val tokens = lex(text)
    var expected = 0
    for ((type, start, end) in tokens) {
      assertEquals("token $type does not start where the previous one ended", expected, start)
      assertTrue("token $type is empty or inverted", end > start)
      expected = end
    }
    assertEquals("the tokens do not reach the end of the buffer", text.length, expected)
  }

  private val everything = """
    %% a comment
    === meta
    title = "t"
    count = -12.5
    ok = true
    ===

    # A heading {#sec .wide}

    Prose with **bold**, *italic*, ~~struck~~, `code`, ${'$'}x^2${'$'},
    a [[#sec]] ref, a [[other.geml#sec]] one, a [label](#sec) and a [^note].

    === code {lang=sh}
    echo "**not bold** and *not italic*"
    ===

    === embed {src=#sec}
    ===
  """.trimIndent()

  @Test
  fun `tokens tile the whole buffer`() {
    assertTiles(everything)
  }

  @Test
  fun `tokens tile a buffer with CRLF line endings`() {
    assertTiles(everything.replace("\n", "\r\n"))
  }

  @Test
  fun `tokens tile a buffer with no trailing newline`() {
    assertTiles("# Just a heading {#x}")
    assertTiles("=== code\nunterminated")
    assertTiles("")
    assertTiles("\n")
    assertTiles("\r\n")
  }

  @Test
  fun `a code fence body is raw, not prose`() {
    // The point of RAW_BODY_TYPES: a `*` inside a code block is a character.
    val types = typesOf(everything, "**not bold**")
    assertEquals(listOf<IElementType>(GemlTokens.RAW), types.distinct())
  }

  @Test
  fun `prose emphasis is still emphasis`() {
    assertTrue(GemlTokens.BOLD in typesOf(everything, "**bold**"))
    assertTrue(GemlTokens.STRIKE in typesOf(everything, "~~struck~~"))
    assertTrue(GemlTokens.CODE_SPAN in typesOf(everything, "`code`"))
  }

  @Test
  fun `a heading carries its mark, text and attributes apart`() {
    val types = lex("# A heading {#sec .wide}").map { it.first }
    assertEquals(
      listOf(
        GemlTokens.HEADING_MARK, TokenType.WHITE_SPACE, GemlTokens.HEADING_TEXT, TokenType.WHITE_SPACE,
        GemlTokens.BRACE, GemlTokens.ATTR_ID, TokenType.WHITE_SPACE, GemlTokens.ATTR_CLASS, GemlTokens.BRACE,
      ),
      types,
    )
  }

  @Test
  fun `a fence head names its block type`() {
    assertTrue(GemlTokens.BLOCK_TYPE in typesOf(everything, "meta"))
    val attrs = lex("=== code {lang=sh}").map { it.first }
    assertTrue(GemlTokens.ATTR_NAME in attrs)
    assertTrue(GemlTokens.OPERATOR in attrs)
  }

  @Test
  fun `attribute values keep their types`() {
    val meta = lex("=== data {n=-12.5 ok=true s=\"x\"}").map { it.first }
    assertTrue(GemlTokens.NUMBER in meta)
    assertTrue(GemlTokens.BOOLEAN in meta)
    assertTrue(GemlTokens.STRING in meta)
  }

  @Test
  fun `a percent-percent line is a comment`() {
    assertEquals(GemlTokens.COMMENT, lex("%% hello").first().first)
  }

  @Test
  fun `references and links are their own tokens`() {
    assertTrue(GemlTokens.REFERENCE in typesOf(everything, "[[#sec]]"))
    assertTrue(GemlTokens.LINK in typesOf(everything, "[label](#sec)"))
    assertTrue(GemlTokens.FOOTNOTE in typesOf(everything, "[^note]"))
  }

  @Test
  fun `an unclosed inline delimiter does not swallow the line`() {
    // A lone `*` is prose, not the start of an emphasis run that never ends.
    assertTiles("a * b ` c ${'$'} d [[ e")
    assertTrue(GemlTokens.TEXT in lex("a * b").map { it.first })
  }

  @Test
  fun `a longer closing fence still closes a raw body`() {
    val text = "==== code\nbody\n====\n# after\n"
    assertTiles(text)
    assertTrue(GemlTokens.HEADING_MARK in typesOf(text, "# after"))
  }

  @Test
  fun `lexing a sub-range clips to it`() {
    val text = "# one\n# two\n"
    val lexer = GemlLexer()
    val from = text.indexOf("# two")
    lexer.start(text, from, text.length, 0)
    var expected = from
    while (lexer.tokenType != null) {
      assertEquals(expected, lexer.tokenStart)
      expected = lexer.tokenEnd
      lexer.advance()
    }
    assertEquals(text.length, expected)
  }
}
