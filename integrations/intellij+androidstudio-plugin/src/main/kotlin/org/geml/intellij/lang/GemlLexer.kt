package org.geml.intellij.lang

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

/**
 * The one thing in this plugin that looks at GEML without asking the CLI.
 *
 * It is a HIGHLIGHTER, not a parser: it decides what colour a run of characters
 * gets and nothing else. Every structural question — where a block starts, what
 * its address is, whether a reference resolves — goes to `geml` (see cli/), so
 * the editor can never disagree with what `geml check` says in CI. Keeping this
 * file honest about that boundary is what stops it from growing into a second
 * implementation of the format.
 *
 * Line-oriented, and it lexes the WHOLE buffer on every start() rather than
 * resuming from a mid-file offset. A line's meaning depends on what opened above
 * it — a raw-body fence swallows everything until it closes — and a lexer that
 * guessed that from a partial range would mis-colour a file the moment an edit
 * landed inside a code block. Documents are documents: the cost is a scan of a
 * few tens of kilobytes, paid on a background thread.
 */
class GemlLexer : LexerBase() {

  private class Tok(@JvmField val type: IElementType, @JvmField val start: Int, @JvmField val end: Int)

  private var buffer: CharSequence = ""
  private var bufferEnd = 0
  private var tokens: List<Tok> = emptyList()
  private var index = 0

  override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
    this.buffer = buffer
    this.bufferEnd = endOffset
    // Lexed from 0 for the fence state, then clipped: what is handed back must
    // tile [startOffset, endOffset) exactly, or the platform asserts.
    this.tokens = lexAll(buffer).mapNotNull { t ->
      when {
        t.end <= startOffset || t.start >= endOffset -> null
        t.start >= startOffset && t.end <= endOffset -> t
        else -> Tok(t.type, maxOf(t.start, startOffset), minOf(t.end, endOffset))
      }
    }
    this.index = 0
  }

  override fun getState(): Int = 0
  override fun getTokenType(): IElementType? = if (index < tokens.size) tokens[index].type else null
  override fun getTokenStart(): Int = tokens[index].start
  override fun getTokenEnd(): Int = tokens[index].end
  override fun advance() { if (index < tokens.size) index++ }
  override fun getBufferSequence(): CharSequence = buffer
  override fun getBufferEnd(): Int = bufferEnd

  private companion object {
    val FENCE_OPEN = Regex("^(={3,})([ \\t]+)([A-Za-z][A-Za-z0-9_-]*)([ \\t]*)(\\{[^}]*})?([ \\t]*)$")
    val FENCE_CLOSE = Regex("^(={3,})([ \\t]*)$")
    val HEADING = Regex("^(#{1,6})([ \\t]+)(.*?)([ \\t]*)(\\{[^}]*})?([ \\t]*)$")

    /**
     * Blocks whose body is not prose, so a `*` in it is a character and not
     * emphasis. A highlighting nicety, not a claim about the format: a type
     * missing from this set parses exactly the same, its body just gets coloured
     * as prose. Add one when it looks wrong; nothing else depends on the list.
     */
    val RAW_BODY_TYPES = setOf("code", "math", "data", "csv", "jsonl")

    fun isIdChar(c: Char) = c.isLetterOrDigit() || c == '_' || c == '-'
  }

  // -------------------------------------------------------------------------

  private fun lexAll(text: CharSequence): List<Tok> {
    val out = ArrayList<Tok>(256)
    val n = text.length
    var pos = 0
    var rawFence = 0   // length of the `=` run that opened a raw body, 0 when outside one

    while (pos < n) {
      var lineEnd = pos
      while (lineEnd < n && text[lineEnd] != '\n') lineEnd++
      var contentEnd = lineEnd
      if (contentEnd > pos && text[contentEnd - 1] == '\r') contentEnd--

      rawFence = lexLine(text, pos, contentEnd, rawFence, out)

      // The line terminator, a CR with it, as one whitespace token.
      val next = if (lineEnd < n) lineEnd + 1 else lineEnd
      emit(out, TokenType.WHITE_SPACE, contentEnd, next)
      pos = if (next > pos) next else pos + 1
    }
    return out
  }

  /** Lex one line's content (no terminator). Returns the raw-fence state after it. */
  private fun lexLine(text: CharSequence, start: Int, end: Int, rawFence: Int, out: MutableList<Tok>): Int {
    val line = text.subSequence(start, end).toString()

    if (rawFence > 0) {
      val close = FENCE_CLOSE.matchEntire(line)
      if (close != null && close.groupValues[1].length >= rawFence) {
        group(out, close, 1, start, GemlTokens.FENCE)
        group(out, close, 2, start, TokenType.WHITE_SPACE)
        return 0
      }
      emit(out, GemlTokens.RAW, start, end)
      return rawFence
    }

    if (line.startsWith("%%")) {
      emit(out, GemlTokens.COMMENT, start, end)
      return 0
    }

    val open = FENCE_OPEN.matchEntire(line)
    if (open != null) {
      group(out, open, 1, start, GemlTokens.FENCE)
      group(out, open, 2, start, TokenType.WHITE_SPACE)
      group(out, open, 3, start, GemlTokens.BLOCK_TYPE)
      group(out, open, 4, start, TokenType.WHITE_SPACE)
      open.groups[5]?.let { attributes(out, text, start + it.range.first, start + it.range.last + 1) }
      group(out, open, 6, start, TokenType.WHITE_SPACE)
      return if (open.groupValues[3].lowercase() in RAW_BODY_TYPES) open.groupValues[1].length else 0
    }

    val closed = FENCE_CLOSE.matchEntire(line)
    if (closed != null) {
      group(out, closed, 1, start, GemlTokens.FENCE)
      group(out, closed, 2, start, TokenType.WHITE_SPACE)
      return 0
    }

    val heading = HEADING.matchEntire(line)
    if (heading != null) {
      group(out, heading, 1, start, GemlTokens.HEADING_MARK)
      group(out, heading, 2, start, TokenType.WHITE_SPACE)
      group(out, heading, 3, start, GemlTokens.HEADING_TEXT)
      group(out, heading, 4, start, TokenType.WHITE_SPACE)
      heading.groups[5]?.let { attributes(out, text, start + it.range.first, start + it.range.last + 1) }
      group(out, heading, 6, start, TokenType.WHITE_SPACE)
      return 0
    }

    inline(out, text, start, end)
    return 0
  }

  /** The brace-delimited attribute list: `{#id .cls name=value}`. */
  private fun attributes(out: MutableList<Tok>, text: CharSequence, start: Int, end: Int) {
    emit(out, GemlTokens.BRACE, start, start + 1)
    var p = start + 1
    val last = end - 1   // offset of the closing brace
    while (p < last) {
      val c = text[p]
      when {
        c == ' ' || c == '\t' -> {
          val s = p
          while (p < last && (text[p] == ' ' || text[p] == '\t')) p++
          emit(out, TokenType.WHITE_SPACE, s, p)
        }
        c == '#' || c == '.' -> {
          val s = p
          p++
          while (p < last && isIdChar(text[p])) p++
          emit(out, if (c == '#') GemlTokens.ATTR_ID else GemlTokens.ATTR_CLASS, s, p)
        }
        c == '"' -> {
          val s = p
          p++
          while (p < last && text[p] != '"') {
            if (text[p] == '\\' && p + 1 < last) p++
            p++
          }
          if (p < last) p++
          emit(out, GemlTokens.STRING, s, p)
        }
        c == '=' -> {
          emit(out, GemlTokens.OPERATOR, p, p + 1)
          p++
        }
        c.isDigit() || (c == '-' && p + 1 < last && text[p + 1].isDigit()) -> {
          val s = p
          p++
          while (p < last && (text[p].isDigit() || text[p] == '.')) p++
          emit(out, GemlTokens.NUMBER, s, p)
        }
        c.isLetter() || c == '_' -> {
          val s = p
          while (p < last && isIdChar(text[p])) p++
          val word = text.subSequence(s, p).toString()
          // `name=` is an attribute name; a bare word is a value, and the two
          // values the format gives meaning to are the booleans.
          val type = when {
            p < last && text[p] == '=' -> GemlTokens.ATTR_NAME
            word == "true" || word == "false" -> GemlTokens.BOOLEAN
            else -> GemlTokens.TEXT
          }
          emit(out, type, s, p)
        }
        else -> {
          emit(out, GemlTokens.TEXT, p, p + 1)
          p++
        }
      }
    }
    emit(out, GemlTokens.BRACE, last, end)
  }

  /** Emphasis, code spans, math, references and links inside a prose line. */
  private fun inline(out: MutableList<Tok>, text: CharSequence, start: Int, end: Int) {
    var p = start
    var plain = start   // start of the run of ordinary text not yet emitted

    while (p < end) {
      val type = typeAt(text, p, end)
      val stop = if (type == null) -1 else when (type) {
        GemlTokens.CODE_SPAN -> delimited(text, p, end, "`", "`")
        GemlTokens.MATH -> delimited(text, p, end, "$", "$")
        GemlTokens.BOLD -> delimited(text, p, end, "**", "**")
        GemlTokens.STRIKE -> delimited(text, p, end, "~~", "~~")
        GemlTokens.REFERENCE -> delimited(text, p, end, "[[", "]]")
        GemlTokens.FOOTNOTE -> delimited(text, p, end, "[^", "]")
        GemlTokens.LINK -> link(text, p, end)
        else -> delimited(text, p, end, "*", "*")
      }
      if (type == null || stop < 0) { p++; continue }

      if (p > plain) emit(out, GemlTokens.TEXT, plain, p)
      emit(out, type, p, stop)
      p = stop
      plain = p
    }
    if (end > plain) emit(out, GemlTokens.TEXT, plain, end)
  }

  /** Which inline construct, if any, could begin at p. */
  private fun typeAt(text: CharSequence, p: Int, end: Int): IElementType? = when {
    text[p] == '`' -> GemlTokens.CODE_SPAN
    text[p] == '$' -> GemlTokens.MATH
    starts(text, p, end, "**") -> GemlTokens.BOLD
    starts(text, p, end, "~~") -> GemlTokens.STRIKE
    starts(text, p, end, "[[") -> GemlTokens.REFERENCE
    starts(text, p, end, "[^") -> GemlTokens.FOOTNOTE
    text[p] == '[' -> GemlTokens.LINK
    text[p] == '*' -> GemlTokens.ITALIC
    else -> null
  }

  private fun starts(text: CharSequence, p: Int, end: Int, s: String): Boolean {
    if (p + s.length > end) return false
    for (i in s.indices) if (text[p + i] != s[i]) return false
    return true
  }

  /** End offset of `open …content… close` starting at p, or -1 when it does not close on this line. */
  private fun delimited(text: CharSequence, p: Int, end: Int, open: String, close: String): Int {
    val from = p + open.length
    var q = from
    while (q < end) {
      if (starts(text, q, end, close)) return if (q == from) -1 else q + close.length
      q++
    }
    return -1
  }

  /** End offset of `[text](target)` starting at p, or -1. */
  private fun link(text: CharSequence, p: Int, end: Int): Int {
    var q = p + 1
    while (q < end && text[q] != ']') q++
    if (q + 1 >= end || text[q + 1] != '(') return -1
    q += 2
    while (q < end && text[q] != ')') q++
    return if (q < end) q + 1 else -1
  }

  private fun emit(out: MutableList<Tok>, type: IElementType, start: Int, end: Int) {
    if (end > start) out.add(Tok(type, start, end))
  }

  private fun group(out: MutableList<Tok>, m: MatchResult, i: Int, base: Int, type: IElementType) {
    val g = m.groups[i] ?: return
    if (!g.range.isEmpty()) emit(out, type, base + g.range.first, base + g.range.last + 1)
  }
}
