package org.geml.intellij

import com.intellij.icons.AllIcons
import com.intellij.ide.structureView.StructureViewBuilder
import com.intellij.ide.structureView.StructureViewModel
import com.intellij.ide.structureView.StructureViewModelBase
import com.intellij.ide.structureView.StructureViewTreeElement
import com.intellij.ide.structureView.TreeBasedStructureViewBuilder
import com.intellij.ide.util.treeView.smartTree.TreeElement
import com.intellij.lang.PsiStructureViewFactory
import com.intellij.navigation.ItemPresentation
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.psi.PsiFile
import org.geml.intellij.cli.GemlIndex
import org.geml.intellij.cli.GemlUnit
import javax.swing.Icon

/**
 * The block index as a tree.
 *
 * Every row is a block the CLI reported, and the grey half of its label is the
 * address you would hand to `geml get`. That is the point of this view: not
 * "here are the headings", but "here is how you address each piece of this
 * document".
 */
class GemlStructureViewFactory : PsiStructureViewFactory {
  override fun getStructureViewBuilder(psiFile: PsiFile): StructureViewBuilder =
    object : TreeBasedStructureViewBuilder() {
      override fun createStructureViewModel(editor: Editor?): StructureViewModel =
        GemlStructureViewModel(psiFile, editor)

      override fun isRootNodeShown(): Boolean = false
    }
}

class GemlStructureViewModel(file: PsiFile, editor: Editor?) :
  StructureViewModelBase(file, editor, GemlTreeElement(file, null) { nest(file) }),
  StructureViewModel.ElementInfoProvider {

  override fun isAlwaysShowsPlus(element: StructureViewTreeElement): Boolean = false
  override fun isAlwaysLeaf(element: StructureViewTreeElement): Boolean = false

  private companion object {
    /**
     * Headings nest by level; everything else hangs off the heading it sits
     * under. The CLI already gives a heading a span covering its whole section,
     * so this only decides who the parent is — never where anything begins.
     *
     * Recomputed whenever the tree asks, so an edit shows up without this class
     * holding a copy of the document that could go stale.
     */
    fun nest(file: PsiFile): List<GemlTreeElement> {
      val units = GemlIndex.units(file, file.viewProvider.document)
      val roots = ArrayList<GemlTreeElement>()
      val open = ArrayList<Pair<Int, MutableList<GemlTreeElement>>>()

      fun siblings(): MutableList<GemlTreeElement> = open.lastOrNull()?.second ?: roots

      for (unit in units) {
        if (unit.kind == "heading" && unit.level != null) {
          while (open.isNotEmpty() && open.last().first >= unit.level) open.removeAt(open.size - 1)
          val mine = ArrayList<GemlTreeElement>()
          siblings().add(GemlTreeElement(file, unit) { mine })
          open.add(unit.level to mine)
        } else {
          siblings().add(GemlTreeElement(file, unit) { emptyList() })
        }
      }
      return roots
    }
  }
}

class GemlTreeElement(
  private val file: PsiFile,
  private val unit: GemlUnit?,
  private val children: () -> List<GemlTreeElement>,
) : StructureViewTreeElement {

  override fun getValue(): Any = unit ?: file

  override fun getChildren(): Array<TreeElement> = children().toTypedArray()

  override fun getPresentation(): ItemPresentation = object : ItemPresentation {
    override fun getPresentableText(): String = unit?.label ?: file.name
    override fun getLocationString(): String? = unit?.let { if (it.text != null) it.address else it.kind }
    override fun getIcon(unused: Boolean): Icon = iconFor(unit)
  }

  override fun navigate(requestFocus: Boolean) {
    val virtualFile = file.virtualFile ?: return
    val line = ((unit?.startLine ?: 1) - 1).coerceAtLeast(0)
    OpenFileDescriptor(file.project, virtualFile, line, 0).navigate(requestFocus)
  }

  override fun canNavigate(): Boolean = file.virtualFile != null
  override fun canNavigateToSource(): Boolean = canNavigate()

  private fun iconFor(unit: GemlUnit?): Icon = when {
    unit == null -> GemlIcons.FILE
    unit.kind == "heading" -> AllIcons.Nodes.Folder
    unit.kind in RAW_KINDS -> AllIcons.FileTypes.Text
    else -> AllIcons.Nodes.Tag
  }

  private companion object {
    val RAW_KINDS = setOf("code", "math", "data", "csv", "jsonl")
  }
}
