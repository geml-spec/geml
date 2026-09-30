package org.geml.intellij

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.model.Pointer
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.backend.documentation.DocumentationResult
import com.intellij.platform.backend.documentation.DocumentationTarget
import com.intellij.platform.backend.documentation.DocumentationTargetProvider
import com.intellij.platform.backend.presentation.TargetPresentation
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import org.geml.intellij.cli.GemlIndex
import org.geml.intellij.cli.GemlUnit
import org.geml.intellij.lang.GemlFile
import org.geml.intellij.lang.GemlRef
import org.geml.intellij.lang.GemlRefs

/**
 * What a reference points at.
 *
 * A reference is the one thing in a GEML document you cannot read: `[[#budget]]`
 * says a block exists somewhere and nothing about what is in it. This resolves
 * it the way `geml check` does — relative to the referring document's own
 * directory — so the editor and CI agree about what resolves.
 */
object GemlTargets {

  class Target(val file: VirtualFile, val psiFile: PsiFile?, val unit: GemlUnit?, val missingPath: String?)

  fun resolve(from: PsiFile, ref: GemlRef): Target? {
    val here = from.virtualFile ?: return null

    var file = here
    if (ref.path != null) {
      val parent = here.parent ?: return null
      val found = VfsUtilCore.findRelativeFile(ref.path, parent)
        ?: return Target(here, from, null, ref.path)
      file = found
    }

    val psiFile = if (file == here) from else PsiManager.getInstance(from.project).findFile(file)
    if (ref.id == null) return Target(file, psiFile, null, null)
    if (psiFile == null) return Target(file, null, null, null)

    val document = PsiDocumentManager.getInstance(from.project).getDocument(psiFile)
    val unit = GemlIndex.units(psiFile, document).firstOrNull { it.id == ref.id }
    return Target(file, psiFile, unit, null)
  }

  fun documentOf(psiFile: PsiFile): Document? =
    PsiDocumentManager.getInstance(psiFile.project).getDocument(psiFile)
}

/**
 * Ctrl+click and F12 on a reference.
 *
 * A reference to a document with no fragment lands at its top; one that names a
 * block lands on the block's HEAD line, not its whole span — jumping to a
 * heading should put the caret on the heading, not select its entire section.
 */
class GemlGotoDeclarationHandler : GotoDeclarationHandler {

  override fun getGotoDeclarationTargets(sourceElement: PsiElement?, offset: Int, editor: Editor): Array<PsiElement>? {
    val from = sourceElement?.containingFile as? GemlFile ?: return null
    val ref = GemlRefs.at(editor.document, offset) ?: return null
    val target = GemlTargets.resolve(from, ref) ?: return null
    if (target.missingPath != null) return null

    val psiFile = target.psiFile ?: return null
    // Named a block that is not there. The diagnostics pass already says so in
    // the editor; silently jumping to the top of the file would be a lie.
    if (ref.id != null && target.unit == null) return null

    val document = GemlTargets.documentOf(psiFile) ?: return null
    val line = ((target.unit?.startLine ?: 1) - 1).coerceIn(0, (document.lineCount - 1).coerceAtLeast(0))
    val element = psiFile.findElementAt(document.getLineStartOffset(line)) ?: psiFile
    return arrayOf(element)
  }
}

/**
 * Hover.
 *
 * Offset-based rather than PSI-reference-based, which is what lets this work
 * over a flat tree: the platform hands the file and an offset, and the reference
 * lexer says what is there.
 *
 * Two things are worth showing. Over a reference — what it points at, because
 * that is the text the reader cannot see. Over a block's own head line — how to
 * address it, because the address is the point of the format and the thing most
 * often worth copying.
 */
class GemlDocumentationTargetProvider : DocumentationTargetProvider {

  private companion object {
    /** Past this, an excerpt stops being a hint and becomes the document again. */
    const val MAX_LINES = 24
    const val MAX_CHARS = 2000
  }

  override fun documentationTargets(file: PsiFile, offset: Int): List<DocumentationTarget> {
    val from = file as? GemlFile ?: return emptyList()
    val document = GemlTargets.documentOf(from) ?: return emptyList()

    val ref = GemlRefs.at(document, offset)
    if (ref != null) return referenceDoc(from, ref)
    return blockDoc(from, document, offset)
  }

  private fun referenceDoc(from: GemlFile, ref: GemlRef): List<DocumentationTarget> {
    val target = GemlTargets.resolve(from, ref) ?: return emptyList()

    if (target.missingPath != null) {
      return one("${ref.path}", "Document <code>${escape(target.missingPath)}</code> not found, relative to this file.")
    }

    val where = if (target.file == from.virtualFile) "" else " in <code>${escape(target.file.name)}</code>"

    val unit = target.unit
    if (unit == null) {
      if (ref.id == null) return one(target.file.name, "Document <code>${escape(target.file.name)}</code>.")
      // The diagnostics pass already flagged this; saying it here too is what
      // the reader wants at the moment they look.
      return one("#${ref.id}", "No block <code>#${escape(ref.id)}</code>$where.")
    }

    val psiFile = target.psiFile ?: return emptyList()
    val document = GemlTargets.documentOf(psiFile) ?: return emptyList()
    val (text, truncated) = excerpt(document, unit)

    val body = StringBuilder()
      .append("<code>${escape(unit.address)}</code> — ${escape(unit.kind)}$where")
      .append("<pre>${escape(text)}</pre>")
    if (truncated) body.append("<i>…truncated; ${unit.endLine - unit.startLine + 1} lines in all.</i>")
    return one(unit.address, body.toString())
  }

  private fun blockDoc(from: GemlFile, document: Document, offset: Int): List<DocumentationTarget> {
    if (offset > document.textLength) return emptyList()
    val line = document.getLineNumber(offset)
    val unit = GemlIndex.unitAt(GemlIndex.units(from, document), line + 1) ?: return emptyList()
    // Only on the block's own head line. Anywhere else this would pop up over
    // ordinary prose every time the mouse paused.
    if (unit.startLine - 1 != line) return emptyList()

    val name = from.virtualFile?.name ?: from.name
    val body = "<b>${escape(unit.address)}</b> — ${escape(unit.kind)}, lines ${unit.startLine}–${unit.endLine}" +
      "<pre>geml get ${escape(name)} '${escape(unit.address)}'</pre>"
    return one(unit.address, body)
  }

  private fun excerpt(document: Document, unit: GemlUnit): Pair<String, Boolean> {
    val lastLine = (document.lineCount - 1).coerceAtLeast(0)
    val first = (unit.startLine - 1).coerceIn(0, lastLine)
    val last = (unit.endLine - 1).coerceIn(first, lastLine)
    var text = document.getText(TextRange(document.getLineStartOffset(first), document.getLineEndOffset(last)))
    var truncated = false

    val lines = text.split("\n")
    if (lines.size > MAX_LINES) {
      text = lines.take(MAX_LINES).joinToString("\n")
      truncated = true
    }
    if (text.length > MAX_CHARS) {
      text = text.take(MAX_CHARS)
      truncated = true
    }
    return text to truncated
  }

  private fun one(title: String, html: String): List<DocumentationTarget> = listOf(GemlDocTarget(title, html))

  private fun escape(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}

private class GemlDocTarget(private val title: String, private val html: String) : DocumentationTarget {
  override fun createPointer(): Pointer<out DocumentationTarget> = Pointer.hardPointer(this)
  override fun computePresentation(): TargetPresentation = TargetPresentation.builder(title).presentation()
  override fun computeDocumentation(): DocumentationResult = DocumentationResult.documentation(html)
}
