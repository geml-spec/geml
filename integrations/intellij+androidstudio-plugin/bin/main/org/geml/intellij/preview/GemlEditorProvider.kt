package org.geml.intellij.preview

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.fileEditor.impl.text.TextEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import org.geml.intellij.GemlFileType

/**
 * Source and preview in one tab, with the platform's own editor/split/preview
 * toggle in the corner — the same shape Markdown has, so nobody has to learn
 * where the preview lives.
 *
 * It opens on the source. A preview that took half the tab uninvited would be a
 * decision this plugin has no business making for a file the user may only have
 * wanted to glance at.
 */
class GemlEditorProvider : FileEditorProvider, DumbAware {

  override fun accept(project: Project, file: VirtualFile): Boolean = file.fileType == GemlFileType

  override fun createEditor(project: Project, file: VirtualFile): FileEditor {
    val source = TextEditorProvider.getInstance().createEditor(project, file) as TextEditor
    return TextEditorWithPreview(
      source,
      GemlPreviewEditor(project, file),
      "GEML",
      TextEditorWithPreview.Layout.SHOW_EDITOR,
    )
  }

  override fun getEditorTypeId(): String = "geml-split-editor"

  override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}
