package org.geml.intellij.lang

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reference scanner decides what Ctrl+click and Shift+F6 act on, so its
 * mistakes are not cosmetic: a wrong idRange is a rename that edits the wrong
 * characters. The cases below are the ones the VS Code implementation grew rules
 * for — each of them is a rule that exists because the naive version got it
 * wrong.
 */
class GemlRefsTest {

  private fun one(line: String) = GemlRefs.onLine(line, 0).single()

  @Test
  fun `a bare wiki ref is same-document`() {
    val ref = one("see [[#budget]] there")
    assertEquals("budget", ref.id)
    assertNull(ref.path)
    assertEquals("budget", line("see [[#budget]] there").substring(ref.idRange!!.startOffset, ref.idRange.endOffset))
  }

  private fun line(s: String) = s

  @Test
  fun `a cross-document ref keeps the path verbatim`() {
    val ref = one("[[../notes/plan.geml#budget]]")
    assertEquals("../notes/plan.geml", ref.path)
    assertEquals("budget", ref.id)
  }

  @Test
  fun `a projection is a reference too`() {
    assertEquals("budget", one("![[#budget]]").id)
  }

  @Test
  fun `an explicit link is widened back over its label`() {
    val text = "see [the budget](#budget) please"
    val ref = one(text)
    // The token has to start at `[`, not at `](` — the label is where the mouse
    // lands, and a hover that only answers over the parenthesised half is a
    // hover nobody finds.
    assertEquals(text.indexOf("[the"), ref.range.startOffset)
    assertEquals("budget", ref.id)
  }

  @Test
  fun `an image is not a reference`() {
    assertTrue(GemlRefs.onLine("![alt](picture.png)", 0).isEmpty())
  }

  @Test
  fun `a URL is a link, not a block reference`() {
    assertTrue(GemlRefs.onLine("[docs](https://example.com/page#frag)", 0).isEmpty())
    assertTrue(GemlRefs.onLine("[mail](mailto:a@b.c)", 0).isEmpty())
  }

  @Test
  fun `bracketed prose is not a reference`() {
    // No fragment and no dot: most likely someone writing [sic].
    assertTrue(GemlRefs.onLine("[sic](notafile)", 0).isEmpty())
  }

  @Test
  fun `a bare document link has no id`() {
    val ref = one("[the plan](plan.geml)")
    assertEquals("plan.geml", ref.path)
    assertNull(ref.id)
    assertNull(ref.idRange)
  }

  @Test
  fun `src on a block head is a reference`() {
    assertEquals("budget", one("=== embed {src=#budget}").id)
    assertEquals("budget", one("=== embed {src=\"#budget\"}").id)
  }

  @Test
  fun `offsets are absolute in the document`() {
    val ref = GemlRefs.onLine("x [[#a]]", 100).single()
    assertEquals(102, ref.range.startOffset)
    assertEquals(105, ref.idRange!!.startOffset)
  }

  @Test
  fun `an id range stops at an id boundary`() {
    // `#budget` must not be found inside `#budget-2`, or a rename would corrupt
    // the longer id.
    assertNull(GemlRefs.idRangeOnLine("# H {#budget-2}", 0, "budget"))
    val range = GemlRefs.idRangeOnLine("# H {#budget}", 0, "budget")!!
    assertEquals(6, range.startOffset)
    assertEquals(12, range.endOffset)
  }

  @Test
  fun `several references on one line are all found`() {
    val refs = GemlRefs.onLine("[[#a]] and [[#b]] and [c](#d)", 0)
    assertEquals(listOf("a", "b", "d"), refs.mapNotNull { it.id }.sorted())
  }
}
