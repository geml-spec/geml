package org.geml.intellij.cli

import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages

/** The two things every user-initiated verb here needs before it can run. */
object GemlTasks {

  /**
   * Run the CLI where the user is waiting for it.
   *
   * A process cannot be spawned on the EDT without freezing the IDE, and these
   * verbs are all answers to a direct request — so they get a progress dialog
   * rather than the silent cache-or-nothing path the background features use.
   */
  fun <T> underProgress(project: Project, title: String, work: () -> T): T =
    ProgressManager.getInstance().runProcessWithProgressSynchronously<T, RuntimeException>(work, title, true, project)

  /**
   * `history` and `revert` read the FILE and its sidecar, not the buffer.
   * Running them over unsaved edits would checkpoint or restore the wrong text,
   * so the buffer has to be settled first — and saving is nearly always what was
   * meant. Returns false when the user declined.
   */
  fun settle(project: Project, document: Document, why: String): Boolean {
    if (!FileDocumentManager.getInstance().isDocumentUnsaved(document)) return true
    val answer = Messages.showYesNoDialog(project, why, "GEML", "Save and Continue", "Cancel", Messages.getWarningIcon())
    if (answer != Messages.YES) return false
    FileDocumentManager.getInstance().saveDocument(document)
    return true
  }
}
