package org.geml.intellij

import com.google.gson.JsonParser
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import com.intellij.openapi.wm.WindowManager
import org.geml.intellij.cli.GemlCli
import org.geml.intellij.cli.GemlIndex
import org.geml.intellij.cli.GemlTasks
import org.geml.intellij.cli.GemlUnit
import org.geml.intellij.lang.GemlFile
import java.nio.file.Path

/**
 * Revert one block to a past revision, and save the revisions that makes
 * possible.
 *
 * This is the feature no Markdown editor can have, because it needs two things
 * Markdown has not got: a stable address for a PART of a document, and a history
 * of that document keyed by it. `.gemlhistory` and `geml revert` supply both, so
 * the editor's whole job is to ask which revision and show what is in it.
 *
 * It deliberately does not let the CLI write the file. `revert … -o -` prints the
 * result instead, and that becomes one write command — so the change lands in
 * the IDE's own undo stack, which is where someone who has just reverted a block
 * by accident will look for it.
 */
abstract class GemlFileAction : AnAction() {

  protected class Context(
    val project: Project,
    val editor: Editor,
    val file: GemlFile,
    val virtualFile: VirtualFile,
    val base: String,
    val workDir: Path?,
  )

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val file = event.getData(CommonDataKeys.PSI_FILE)
    event.presentation.isEnabledAndVisible = file is GemlFile && file.virtualFile?.isInLocalFileSystem == true
  }

  protected fun contextOf(event: AnActionEvent): Context? {
    val project = event.project ?: return null
    val editor = event.getData(CommonDataKeys.EDITOR) ?: return null
    val file = event.getData(CommonDataKeys.PSI_FILE) as? PsiFile as? GemlFile ?: return null
    val virtualFile = file.virtualFile ?: return null
    if (!virtualFile.isInLocalFileSystem) {
      Messages.showInfoMessage(project, "A revision lives beside the file on disk, so this needs a saved document.", "GEML")
      return null
    }
    return Context(project, editor, file, virtualFile, virtualFile.name, GemlIndex.workDirOf(virtualFile))
  }

  protected fun fail(project: Project, result: GemlCli.Result?, fallback: String) {
    val why = result?.stderr?.trim()?.removePrefix("error:")?.trim().orEmpty().ifEmpty { fallback }
    Messages.showErrorDialog(project, why, "GEML")
  }

  protected fun status(project: Project, message: String) {
    WindowManager.getInstance().getStatusBar(project)?.info = "GEML: $message"
  }
}

/**
 * Append the file as a new revision.
 *
 * Not optional, and not an autosave: without a `.gemlhistory` there is nothing
 * to revert to, and these are checkpoints somebody decided to keep.
 */
class GemlSaveRevisionAction : GemlFileAction() {

  override fun actionPerformed(event: AnActionEvent) {
    val ctx = contextOf(event) ?: return
    // `history save` reads the file, so an unsaved buffer would be checkpointed
    // at its old contents — the opposite of what pressing this means.
    if (!GemlTasks.settle(ctx.project, ctx.editor.document, "Saving a revision reads the file on disk. Save this document first?")) return

    val note = Messages.showInputDialog(
      ctx.project,
      "An optional note, recorded with the revision:",
      "Save a Revision of ${ctx.base}",
      null,
    ) ?: return   // dismissed, as opposed to left empty

    // The note goes straight into argv. Unlike the VS Code extension, which has
    // to refuse shell syntax here because its spawn passes through cmd.exe on
    // Windows, GeneralCommandLine talks to the OS directly — so any note the
    // user can type is safe to pass on.
    val args = listOf("history", "save", ctx.base) + if (note.isBlank()) emptyList() else listOf("-m", note.trim())
    val result = GemlTasks.underProgress(ctx.project, "Saving a GEML Revision") {
      GemlCli.run(args, ctx.workDir)
    }
    if (result == null || result.code != 0) return fail(ctx.project, result, "could not save a revision")

    // The sidecar was written behind the VFS's back.
    VfsUtil.markDirtyAndRefresh(true, false, false, ctx.virtualFile.parent)
    // "saved <id>", or the no-op line when the file already matches the tip.
    status(ctx.project, result.stdout.trim().ifEmpty { "revision saved" })
  }
}

/** Restore the block at the caret to how it was in a chosen revision. */
class GemlRevertBlockAction : GemlFileAction() {

  /** Revision ids are timestamps plus a hex suffix; anything else is not one. */
  private val revId = Regex("^[0-9A-Za-z][0-9A-Za-z-]{0,63}$")

  private class Revision(val id: String, val offset: Int) {
    override fun toString(): String =
      "$offset revision${if (offset == 1) "" else "s"} back  —  $id"
  }

  override fun actionPerformed(event: AnActionEvent) {
    val ctx = contextOf(event) ?: return
    val document = ctx.editor.document
    // `revert` reads the FILE and its sidecar, not the buffer. Applying its
    // output over unsaved edits would silently drop them.
    if (!GemlTasks.settle(ctx.project, document, "Reverting a block reads the file on disk, so unsaved changes would be lost. Save this document first?")) return

    val line = document.getLineNumber(ctx.editor.caretModel.offset) + 1
    val units = GemlTasks.underProgress(ctx.project, "Reading GEML Block Index") {
      GemlIndex.list(document.text, ctx.workDir)
    } ?: return Messages.showWarningDialog(ctx.project, "Could not read this document's blocks.", "GEML")

    val unit = GemlIndex.unitAt(units, line)
      ?: return Messages.showInfoMessage(ctx.project, "The caret is not inside an addressable block.", "GEML")
    // `revert` addresses by id. A block without one has no name for its history
    // to be keyed by, and picking it out by position would revert whatever now
    // happens to sit there.
    val id = unit.id
      ?: return Messages.showInfoMessage(
        ctx.project,
        "`${unit.address}` has no id, and a revision is addressed by id.\n\nGive the block an {#id} to keep its history.",
        "GEML",
      )
    if (!GemlCli.isSafeId(id)) {
      return Messages.showInfoMessage(ctx.project, "`#$id` contains characters this command cannot pass on safely. Use `geml revert` directly.", "GEML")
    }

    val past = revisions(ctx) ?: return
    if (past.isEmpty()) {
      return Messages.showInfoMessage(ctx.project, "This document has only one saved revision, so there is nothing to revert to.", "GEML")
    }

    JBPopupFactory.getInstance()
      .createPopupChooserBuilder(past)
      .setTitle("Revert ${unit.address} in ${ctx.base}")
      .setItemChosenCallback { chosen -> confirmAndRevert(ctx, unit, id, chosen) }
      .createPopup()
      .showInBestPositionFor(ctx.editor)
  }

  /** The past revisions of this document, newest first. Offset 0 is the current text. */
  private fun revisions(ctx: Context): List<Revision>? {
    val result = GemlTasks.underProgress(ctx.project, "Reading GEML History") {
      GemlCli.run(listOf("history", "get", ctx.base, "--json"), ctx.workDir)
    }
    if (result == null) return null
    if (result.code != 0) {
      val why = result.stderr.trim().removePrefix("error:").trim()
      Messages.showInfoMessage(
        ctx.project,
        "No history for this document${if (why.isEmpty()) "" else " — $why"}.\n\nUse \"Save a GEML Revision\" to start one.",
        "GEML",
      )
      return null
    }
    val root = runCatching { JsonParser.parseString(result.stdout) }.getOrNull() ?: return null
    if (!root.isJsonArray) return null
    return root.asJsonArray.mapNotNull { element ->
      if (!element.isJsonObject) return@mapNotNull null
      val o = element.asJsonObject
      val id = o.get("id")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
      val offset = o.get("offset")?.takeIf { !it.isJsonNull }?.asInt ?: return@mapNotNull null
      if (offset <= 0 || !revId.matches(id)) null else Revision(id, offset)
    }
  }

  /**
   * Show the block as it was, then restore it.
   *
   * The preview is fetched for the CHOSEN revision only. The VS Code extension
   * previews whichever row is highlighted, which costs two CLI calls per arrow
   * key; one confirmation on the way out gives a reader the same protection for
   * one pair of calls.
   */
  private fun confirmAndRevert(ctx: Context, unit: GemlUnit, id: String, revision: Revision) {
    val was = GemlTasks.underProgress(ctx.project, "Reading Revision ${revision.id}") {
      blockAt(ctx, id, revision.id)
    }
    val preview = (was ?: "(could not read this revision)").let {
      if (it.length > 1500) it.take(1500) + "\n…" else it
    }
    val go = Messages.showYesNoDialog(
      ctx.project,
      "Restore ${unit.address} to how it was ${revision.offset} revision${if (revision.offset == 1) "" else "s"} back?\n\n$preview",
      "Revert GEML Block",
      "Restore",
      "Cancel",
      Messages.getQuestionIcon(),
    )
    if (go != Messages.YES) return

    val out = GemlTasks.underProgress(ctx.project, "Reverting ${unit.address}") {
      GemlCli.run(listOf("revert", ctx.base, "#$id", "--rev", revision.id, "-o", "-"), ctx.workDir)
    }
    if (out == null || out.code != 0 || out.stdout.isEmpty()) {
      return fail(ctx.project, out, "the CLI refused the revert")
    }

    val document = ctx.editor.document
    WriteCommandAction.runWriteCommandAction(ctx.project, "Revert GEML Block", null, {
      document.setText(out.stdout)
    }, ctx.file)
    status(ctx.project, "reverted #$id to ${revision.id} — undo puts it back")
  }

  /** The block's source as of one revision. */
  private fun blockAt(ctx: Context, id: String, revision: String): String? {
    // `<rev>` is POSITIONAL for `history get` — `--rev` belongs to `revert`, and
    // `history` rejects it as an unknown flag.
    val at = GemlCli.run(listOf("history", "get", ctx.base, revision), ctx.workDir)
    if (at == null || at.code != 0 || at.stdout.isEmpty()) return null

    // The revision's whole document, then one block out of it — on stdin, so the
    // revision text never becomes a temporary file or an argument.
    val block = GemlCli.run(listOf("get", "-", "#$id"), ctx.workDir, at.stdout)
    if (block == null || block.code != 0) return null
    return block.stdout.trim().ifEmpty { "(the block did not exist in this revision)" }
  }
}
