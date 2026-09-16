package org.geml.intellij.lang

import com.intellij.openapi.editor.Document
import com.intellij.openapi.util.TextRange

/** A reference token, and what it points at. Offsets are absolute in the document. */
class GemlRef(
  /** The whole token, for a hover to highlight. */
  val range: TextRange,
  /** Just the id text, without `#` — what rename pre-fills and replaces. */
  val idRange: TextRange?,
  /** Document part of the target, verbatim as written, when the ref crosses documents. */
  val path: String?,
  /** Block id without `#`. Absent for a bare cross-document link with no fragment. */
  val id: String?,
)

/**
 * Finding the reference under the cursor.
 *
 * With GemlLexer, the second and last place this plugin reads GEML syntax
 * directly, and for the same reason: no CLI verb answers "what token is at line
 * 12, column 30", and an editor has to know that before it can offer to navigate
 * anywhere. It never decides what a document MEANS — what exists, what resolves,
 * what is broken — all of which still comes from `geml check`.
 *
 * §5.2 gives four reference forms, and §6 one more on a block head:
 *
 *   [[#id]]                  auto-ref, same document
 *   [[other.geml#id]]        auto-ref, cross-document
 *   [text](#id)              explicit text, same document
 *   [text](other.geml#id)    explicit text, cross-document
 *   ![[#id]]                 inline projection (same shape, leading `!`)
 *   === embed {src=#id}      block transclusion, an attribute not an inline
 *
 * All six are navigable, so all six are matched. Ported from the VS Code
 * extension's refs.ts, deliberately rule for rule.
 */
object GemlRefs {

  // `[[target]]` and `![[target]]`. The target runs to the first `]`, so a
  // nested link cannot confuse it — §5.3 forbids a ref inside a ref anyway.
  private val WIKI = Regex("!?\\[\\[([^\\]\\n]+)]]")

  // `](target)` — the tail of `[text](target)`. Only the target is captured; the
  // label may contain anything, and matching from `](` avoids having to.
  private val INLINE = Regex("]\\(([^)\\n\\s]+)\\)")

  // `src=#id` or `src="#id"` on a block head.
  private val SRC = Regex("\\bsrc\\s*=\\s*\"?(#[^\"\\s}]+)\"?")

  private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")

  private class Parts(val path: String?, val id: String?, val idOffset: Int)

  /** Split a reference target into its document and fragment parts. */
  private fun split(target: String): Parts? {
    // A URL is a link, not a block reference — its `#` is a page fragment and
    // there is nothing in this workspace to navigate to.
    if (SCHEME.containsMatchIn(target) || target.startsWith("mailto:")) return null

    val hash = target.indexOf('#')
    return when {
      hash == 0 -> Parts(null, target.substring(1), 1)
      hash > 0 -> Parts(target.substring(0, hash), target.substring(hash + 1), hash + 1)
      // No fragment. A bare `[[other.geml]]` is still navigable as a document; a
      // bare `[text](notes.md)` likewise. Anything without a dot is neither —
      // most likely ordinary prose in brackets.
      target.contains('.') -> Parts(target, null, -1)
      else -> null
    }
  }

  /**
   * Where the `[` that opens a label sits, given the index of its closing `]`.
   * Returns -1 when there is no label — `](x)` appearing on its own.
   */
  private fun labelStart(text: String, close: Int): Int {
    var depth = 0
    for (i in close - 1 downTo 0) {
      when (text[i]) {
        ']' -> depth++
        '[' -> if (depth == 0) return i else depth--
      }
    }
    return -1
  }

  /** Every reference token on one line. `lineStart` is that line's document offset. */
  fun onLine(line: String, lineStart: Int): List<GemlRef> {
    val out = ArrayList<GemlRef>()

    fun push(start: Int, end: Int, target: String, targetStart: Int) {
      val parts = split(target) ?: return
      val idRange = if (parts.id != null && parts.idOffset >= 0) {
        TextRange(
          lineStart + targetStart + parts.idOffset,
          lineStart + targetStart + parts.idOffset + parts.id.length,
        )
      } else {
        null
      }
      out.add(GemlRef(TextRange(lineStart + start, lineStart + end), idRange, parts.path, parts.id))
    }

    for (regex in listOf(WIKI, SRC)) {
      for (m in regex.findAll(line)) {
        val target = m.groupValues[1]
        push(m.range.first, m.range.last + 1, target, m.range.first + m.value.indexOf(target))
      }
    }

    // `[text](target)` is matched from its `](`, because a label may contain
    // anything at all. The token is then widened back over the label: that is
    // the part a reader's mouse lands on, and a hover that only answers over the
    // parenthesised half is a hover nobody finds.
    for (m in INLINE.findAll(line)) {
      val target = m.groupValues[1]
      val open = labelStart(line, m.range.first)
      // `![alt](picture.png)` is an image, not a reference to a document.
      if (open > 0 && line[open - 1] == '!') continue
      val start = if (open >= 0) open else m.range.first
      push(start, m.range.last + 1, target, m.range.first + m.value.indexOf(target))
    }

    return out
  }

  /** The reference token containing an offset, if the caret is on one. */
  fun at(document: Document, offset: Int): GemlRef? {
    if (offset < 0 || offset > document.textLength) return null
    val line = document.getLineNumber(offset)
    val start = document.getLineStartOffset(line)
    val text = document.getText(TextRange(start, document.getLineEndOffset(line)))
    return onLine(text, start).firstOrNull { it.range.containsOffset(offset) }
  }

  /**
   * Where an id is DECLARED on its own block head — `{#budget}`, or a heading's
   * trailing `{#sec}`. Rename starts here when the caret is on the definition
   * rather than on a reference. The id is already known (the CLI listed it);
   * this only finds where on the line it sits, so a wrong answer degrades to
   * "cannot rename here", never to a wrong edit.
   */
  fun idRangeOnLine(line: String, lineStart: Int, id: String): TextRange? {
    // `#id` followed by a character that cannot continue an id, so `#budget` is
    // not found inside `#budget-2`.
    val regex = Regex("#" + Regex.escape(id) + "(?![\\p{L}\\p{N}_\\-.:])")
    val m = regex.find(line) ?: return null
    val start = lineStart + m.range.first + 1   // past the '#'
    return TextRange(start, start + id.length)
  }
}
