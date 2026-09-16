package org.geml.intellij

import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import org.geml.intellij.cli.GemlDiagnostic
import org.geml.intellij.cli.GemlIndex
import org.geml.intellij.cli.GemlSettings
import java.nio.file.Path

/**
 * `geml check` in the editor.
 *
 * ExternalAnnotator is the platform's shape for exactly this: collect on the
 * EDT, run the slow thing on a background thread, apply the result back. So the
 * diagnostics an author sees while typing are produced by the same program CI
 * runs, and there is no second opinion to disagree with it.
 *
 * The pass is fed the BUFFER, not the file on disk — an editor that linted the
 * saved copy would report problems the author has already fixed.
 */
class GemlAnnotator : ExternalAnnotator<GemlAnnotator.Request, GemlAnnotator.Answer>() {

  class Request(val text: String, val workDir: Path?, val file: VirtualFile, val stamp: Long)
  class Answer(val diagnostics: List<GemlDiagnostic>)

  override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): Request? {
    if (!GemlSettings.getInstance().state.checkEnabled) return null
    val virtualFile = file.virtualFile ?: return null
    val document = editor.document
    return Request(document.text, GemlIndex.workDirOf(virtualFile), virtualFile, document.modificationStamp)
  }

  override fun doAnnotate(request: Request): Answer? {
    // Piggy-backed on the pass that was happening anyway, for the consumers that
    // cannot afford a process of their own (see GemlIndex).
    if (GemlIndex.isWanted(request.file)) {
      GemlIndex.list(request.text, request.workDir)?.let { GemlIndex.put(request.file, request.stamp, it) }
    }
    val diagnostics = GemlIndex.check(request.text, request.workDir) ?: return null
    return Answer(diagnostics)
  }

  override fun apply(file: PsiFile, answer: Answer, holder: AnnotationHolder) {
    val document = file.viewProvider.document ?: return
    val lastLine = (document.lineCount - 1).coerceAtLeast(0)

    for (d in answer.diagnostics) {
      val line = (d.line - 1).coerceIn(0, lastLine)
      var start = document.getLineStartOffset(line)
      var end = document.getLineEndOffset(line)
      if (start == end) {
        // A blank line has nothing to underline. Take the line break with it so
        // the marker has somewhere to draw, or back up onto the previous one at
        // the very end of the file.
        if (end < document.textLength) end += 1 else start = (start - 1).coerceAtLeast(0)
      }
      holder.newAnnotation(severityOf(d.severity), message(d))
        .range(TextRange(start, end))
        .create()
    }
  }

  private fun message(d: GemlDiagnostic): String =
    if (d.code.isNullOrBlank()) d.message else "${d.message} (${d.code})"

  private fun severityOf(severity: String): HighlightSeverity = when (severity) {
    "error" -> HighlightSeverity.ERROR
    "warning" -> HighlightSeverity.WARNING
    else -> HighlightSeverity.WEAK_WARNING
  }
}
