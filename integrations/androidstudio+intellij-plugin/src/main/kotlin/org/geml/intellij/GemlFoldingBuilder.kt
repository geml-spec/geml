package org.geml.intellij

import com.intellij.lang.ASTNode
import com.intellij.lang.folding.FoldingBuilderEx
import com.intellij.lang.folding.FoldingDescriptor
import com.intellij.openapi.editor.Document
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import org.geml.intellij.cli.GemlIndex

/**
 * Fold a block, or a whole heading section, using the spans `geml list` reports.
 *
 * No structure is inferred here: a heading's span already covers its section
 * because that is what the CLI says it covers, which is also what `geml get`
 * would hand back for the same address. Folding and addressing therefore agree
 * by construction.
 */
class GemlFoldingBuilder : FoldingBuilderEx(), DumbAware {

  override fun buildFoldRegions(root: PsiElement, document: Document, quick: Boolean): Array<FoldingDescriptor> {
    // `quick` is the pass that must not do real work — it runs before the file
    // is even shown, and the CLI is real work.
    if (quick) return emptyArray()

    val file = root.containingFile ?: return emptyArray()
    val node = file.node ?: return emptyArray()
    val lastLine = document.lineCount - 1
    if (lastLine < 0) return emptyArray()

    val descriptors = ArrayList<FoldingDescriptor>()
    val seen = HashSet<TextRange>()

    for (unit in GemlIndex.units(file, document)) {
      val first = (unit.startLine - 1).coerceIn(0, lastLine)
      val last = (unit.endLine - 1).coerceIn(first, lastLine)
      if (last <= first) continue   // a one-line block has nothing to hide

      // From the end of the block's first line: the heading or the `=== type`
      // stays readable, which is the only thing a folded region can be
      // recognised by.
      val range = TextRange(document.getLineEndOffset(first), document.getLineEndOffset(last))
      if (range.isEmpty || !seen.add(range)) continue

      descriptors.add(FoldingDescriptor(node, range, null, placeholder(unit.kind)))
    }
    return descriptors.toTypedArray()
  }

  private fun placeholder(kind: String): String = when (kind) {
    "heading" -> " …"
    else -> " … ($kind)"
  }

  override fun getPlaceholderText(node: ASTNode): String = " …"

  override fun isCollapsedByDefault(node: ASTNode): Boolean = false
}
