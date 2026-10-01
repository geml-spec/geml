package org.geml.intellij

import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidatorEx
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.refactoring.rename.RenameHandler
import org.geml.intellij.cli.GemlCli
import org.geml.intellij.cli.GemlIndex
import org.geml.intellij.cli.GemlTasks
import org.geml.intellij.lang.GemlFile
import org.geml.intellij.lang.GemlRefs

/**
 * Shift+F6 on an id: rename it and every reference to it.
 *
 * `geml rename` already does this, and better than a text search could — it is
 * id-boundary safe (`#budget` is untouched inside `#budget-2`), it updates all
 * four §5.2 reference forms plus `src=` on a block head, and it REFUSES rather
 * than write a document that would stop parsing. So this computes no edits; it
 * asks the CLI for the renamed document and applies the result as one command.
 *
 * The buffer goes in on stdin, so renaming works with unsaved edits. Note what
 * the CLI's write guard means in an editor, because it is not obvious: for a
 * `.geml` result it permits NO errors, pre-existing ones included. A document
 * with one unresolvable cross-document reference therefore cannot have an
 * unrelated id renamed until that is fixed. Nothing is written and the CLI says
 * exactly why — which is why its sentence is shown verbatim rather than
 * summarised.
 */
class GemlRenameHandler : RenameHandler {

  private class Site(val id: String, val range: TextRange)

  override fun isAvailableOnDataContext(dataContext: DataContext): Boolean =
    CommonDataKeys.PSI_FILE.getData(dataContext) is GemlFile &&
      CommonDataKeys.EDITOR.getData(dataContext) != null

  override fun invoke(project: Project, elements: Array<out PsiElement>, dataContext: DataContext?) = Unit

  override fun invoke(project: Project, editor: Editor?, file: PsiFile?, dataContext: DataContext?) {
    if (editor == null || file !is GemlFile) return
    val document = editor.document
    val offset = editor.caretModel.offset

    val site = siteAt(project, file, editor) ?: return
    if (!GemlCli.isSafeId(site.id)) {
      return say(project, "`#${site.id}` contains characters this command cannot pass to the CLI safely. Rename it with `geml rename` directly.")
    }

    val wanted = Messages.showInputDialog(
      project,
      "New id for #${site.id}:",
      "Rename GEML Block",
      null,
      site.id,
      IdValidator,
    )?.trim()?.removePrefix("#") ?: return
    if (wanted.isEmpty() || wanted == site.id) return
    if (!GemlCli.isSafeId(wanted)) {
      return say(project, "`$wanted` is not a usable id here — letters, digits, `-`, `_`, `.` and `:` only.")
    }

    val text = document.text
    val workDir = file.virtualFile?.let { GemlIndex.workDirOf(it) }
    val result = GemlTasks.underProgress(project, "Renaming #${site.id}") {
      GemlCli.run(listOf("rename", "-", "#${site.id}", "#$wanted"), workDir, text)
    } ?: return

    if (result.code != 0 || result.stdout.isEmpty()) {
      // The CLI refuses any rename whose result would not be a clean document —
      // a duplicate id, a dangling reference, or an error that was already
      // there. Its sentence is the explanation, and better than anything this
      // plugin could invent.
      val why = result.stderr.trim().removePrefix("error:").trim().ifEmpty { "the CLI refused the rename" }
      val hint = if (Regex("cannot resolve|unresolved").containsMatchIn(why)) {
        "\n\nFix the problems in this document first — they are in the editor and the Problems view."
      } else {
        ""
      }
      return say(project, "$why$hint")
    }

    // One command over the whole document. The CLI returns the finished text and
    // is the only thing that knows every site; reconstructing minimal edits from
    // it would mean diffing its output against the buffer to arrive back at what
    // it has already told us, with a chance of getting it wrong.
    WriteCommandAction.runWriteCommandAction(project, "Rename GEML Block", null, {
      document.setText(result.stdout)
    }, file)

    // Put the caret back where the id now is, so a rename does not lose the
    // reader's place in a long document.
    val moved = offset.coerceAtMost(document.textLength)
    editor.caretModel.moveToOffset(moved)
  }

  /** What the caret is sitting on: an id, and where its text is. */
  private fun siteAt(project: Project, file: GemlFile, editor: Editor): Site? {
    val document = editor.document
    val offset = editor.caretModel.offset

    // On a reference — the common case, and the one that needs no CLI call.
    val ref = GemlRefs.at(document, offset)
    if (ref?.id != null && ref.idRange != null) return Site(ref.id, ref.idRange)

    // On the block's own head, where the id is declared. The id comes from the
    // CLI's index; GemlRefs only locates it on the line.
    val line = document.getLineNumber(offset)
    val unit = GemlIndex.unitAt(GemlIndex.units(file, document), line + 1)
    if (unit?.id == null || unit.startLine - 1 != line) {
      say(project, "There is no GEML id here to rename. Put the caret on a reference, or on the block head that declares the id.")
      return null
    }

    val lineText = document.getText(TextRange(document.getLineStartOffset(line), document.getLineEndOffset(line)))
    val range = GemlRefs.idRangeOnLine(lineText, document.getLineStartOffset(line), unit.id)
    if (range == null) {
      // A heading with a DERIVED id has no `#id` text on the line to rename: the
      // id is a function of the heading's words (§4). Renaming it means editing
      // the heading, or giving it an explicit `{#id}` — not something to do
      // behind the user's back.
      say(
        project,
        "`#${unit.id}` is derived from this heading's text, so there is no id here to rename.\n\n" +
          "Edit the heading, or give it an explicit {#id} first.",
      )
      return null
    }
    return Site(unit.id, range)
  }

  private fun say(project: Project, message: String) =
    Messages.showInfoMessage(project, message, "GEML")

  private object IdValidator : InputValidatorEx {
    override fun getErrorText(inputString: String?): String? {
      val candidate = inputString?.trim()?.removePrefix("#").orEmpty()
      if (candidate.isEmpty()) return "An id cannot be empty."
      if (!GemlCli.isSafeId(candidate)) return "Letters, digits, - _ . and : only."
      return null
    }
  }
}
