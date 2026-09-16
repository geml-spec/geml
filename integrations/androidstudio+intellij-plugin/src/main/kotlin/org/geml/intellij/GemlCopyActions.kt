package org.geml.intellij

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.Balloon
import com.intellij.psi.PsiFile
import com.intellij.ui.awt.RelativePoint
import com.intellij.openapi.ui.MessageType
import org.geml.intellij.cli.GemlIndex
import org.geml.intellij.cli.GemlUnit
import org.geml.intellij.lang.GemlFile
import java.awt.datatransfer.StringSelection

/**
 * "What do I call this block?", answered without reading the file.
 *
 * The address comes from `geml list`, so what lands on the clipboard is exactly
 * what `geml get` will take back — including for the blocks that have no id and
 * are addressed by type or by content hash, which are the ones nobody can work
 * out by looking.
 */
abstract class GemlCopyAction : AnAction() {

  protected abstract fun textFor(unit: GemlUnit): String?

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    event.presentation.isEnabledAndVisible = event.getData(CommonDataKeys.PSI_FILE) is GemlFile
  }

  override fun actionPerformed(event: AnActionEvent) {
    val editor = event.getData(CommonDataKeys.EDITOR) ?: return
    val file = event.getData(CommonDataKeys.PSI_FILE) as? GemlFile ?: return

    val line = editor.document.getLineNumber(editor.caretModel.offset) + 1
    val units = index(file, editor) ?: return report(editor, "The GEML parser did not answer.")
    val unit = GemlIndex.unitAt(units, line) ?: return report(editor, "No block at the caret.")

    val text = textFor(unit)
      ?: return report(editor, "That block has no id — copy its address instead.")

    CopyPasteManager.getInstance().setContents(StringSelection(text))
    report(editor, "Copied  $text")
  }

  /**
   * The cached index when it is current, and otherwise a run under a progress
   * dialog. This one is worth waiting for: the user asked a direct question and
   * an empty answer because a background pass had not happened yet would just
   * look broken.
   */
  private fun index(file: PsiFile, editor: Editor): List<GemlUnit>? {
    val virtualFile = file.virtualFile ?: return null
    val document = editor.document
    GemlIndex.cached(virtualFile, document.modificationStamp)?.let { return it }

    val text = document.text
    val workDir = GemlIndex.workDirOf(virtualFile)
    val units = ProgressManager.getInstance().runProcessWithProgressSynchronously<List<GemlUnit>?, RuntimeException>(
      { GemlIndex.list(text, workDir) },
      "Reading GEML Block Index",
      true,
      file.project,
    )
    if (units != null) GemlIndex.put(virtualFile, document.modificationStamp, units)
    return units
  }

  private fun report(editor: Editor, message: String) {
    JBPopupFactory.getInstance()
      .createHtmlTextBalloonBuilder(message, MessageType.INFO, null)
      .setFadeoutTime(2500)
      .createBalloon()
      .show(RelativePoint.getCenterOf(editor.contentComponent), Balloon.Position.atRight)
  }
}

/** The address `geml get` takes: `#id`, `=== code`, `@13b4c5ae`, `L27`. */
class GemlCopyAddressAction : GemlCopyAction() {
  override fun textFor(unit: GemlUnit): String = unit.address
}

/** The reference another document would write: `[[#id]]`. */
class GemlCopyReferenceAction : GemlCopyAction() {
  override fun textFor(unit: GemlUnit): String? = unit.id?.let { "[[#$it]]" }
}
