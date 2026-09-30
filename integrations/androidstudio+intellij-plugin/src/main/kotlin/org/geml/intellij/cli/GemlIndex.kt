package org.geml.intellij.cli

import com.google.gson.JsonParser
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

/** One row of `geml list --json`: a block, and the address that reaches it. */
class GemlUnit(
  /** Pastes straight back into `geml get`. */
  val address: String,
  /** heading | prose | note | table | view | code | data | meta | … */
  val kind: String,
  /** 1-based, inclusive. */
  val startLine: Int,
  val endLine: Int,
  val id: String?,
  /** Headings only. */
  val level: Int?,
  val text: String?,
  /** No id: addressed by type or by content. */
  val anon: Boolean,
) {
  /** What to show in a tree: the heading's words, else the address. */
  val label: String get() = text?.takeIf { it.isNotBlank() } ?: address
}

/** One row of `geml check --json`. */
class GemlDiagnostic(val severity: String, val code: String?, val message: String, val line: Int)

/**
 * The block index, and the one cache in front of the CLI.
 *
 * The structure view, folding and "copy this block's address" all want the same
 * answer, the platform asks for them separately and often, and each ask would
 * otherwise be its own process. So the annotator — which already runs a pass per
 * edit, on a background thread, at its own pace — stores what it learned here,
 * and the synchronous consumers read it.
 *
 * Keyed by the document's modification stamp, so a stale index can be recognised
 * rather than served.
 */
object GemlIndex {

  private class Entry(val stamp: Long, val units: List<GemlUnit>)

  private val cache = ConcurrentHashMap<String, Entry>()

  /**
   * Files something has actually asked an index for. `geml check` runs on every
   * pass because diagnostics are the point; `geml list` is a second process for
   * the same keystroke, so it runs only once a consumer exists — which, for a
   * document nobody has opened a structure view on, is never.
   */
  private val wanted = ConcurrentHashMap.newKeySet<String>()

  fun put(file: VirtualFile, stamp: Long, units: List<GemlUnit>) {
    cache[file.url] = Entry(stamp, units)
  }

  fun isWanted(file: VirtualFile): Boolean = wanted.contains(file.url)

  fun forget(file: VirtualFile) {
    cache.remove(file.url)
    wanted.remove(file.url)
  }

  /** The cached index for this exact version of the document, if there is one. */
  fun cached(file: VirtualFile, stamp: Long): List<GemlUnit>? =
    cache[file.url]?.takeIf { it.stamp == stamp }?.units

  /**
   * The index for a document, current as of this edit.
   *
   * Off the EDT — the folding pass, a structure view built in the background —
   * a miss is filled by running the CLI right there. ON the EDT nothing is ever
   * spawned: a structure view is not worth a frozen editor. The fill happens on
   * a pooled thread instead and then asks the daemon to run its passes again,
   * by which point this is a plain cache hit.
   */
  fun units(psiFile: PsiFile, document: Document?): List<GemlUnit> {
    val file = psiFile.virtualFile ?: return emptyList()
    val stamp = document?.modificationStamp ?: psiFile.modificationStamp
    cached(file, stamp)?.let { return it }
    wanted.add(file.url)

    if (!ApplicationManager.getApplication().isDispatchThread) {
      val units = list(document?.text ?: psiFile.text, workDirOf(file))
      if (units != null) {
        put(file, stamp, units)
        return units
      }
      return cache[file.url]?.units ?: emptyList()
    }

    fillInBackground(psiFile, document?.text ?: psiFile.text, file, stamp)
    // Whatever was last known. One pass out of date beats an empty tree that
    // blinks back a moment later.
    return cache[file.url]?.units ?: emptyList()
  }

  private val filling = ConcurrentHashMap.newKeySet<String>()

  private fun fillInBackground(psiFile: PsiFile, text: String, file: VirtualFile, stamp: Long) {
    val key = "${file.url}@$stamp"
    if (!filling.add(key)) return
    val project = psiFile.project
    val application = ApplicationManager.getApplication()
    application.executeOnPooledThread {
      try {
        val units = list(text, workDirOf(file)) ?: return@executeOnPooledThread
        put(file, stamp, units)
        application.invokeLater({
          if (!project.isDisposed && psiFile.isValid) {
            DaemonCodeAnalyzer.getInstance(project).restart(psiFile)
          }
        }, project.disposed)
      } finally {
        filling.remove(key)
      }
    }
  }

  /**
   * The block holding a line: the SMALLEST unit whose span contains it, which is
   * the rule `geml get <file> 'L27'` documents. Headings span their whole
   * section, so without "smallest" every line in a document would answer with
   * its top-level heading.
   */
  fun unitAt(units: List<GemlUnit>, oneBasedLine: Int): GemlUnit? {
    var best: GemlUnit? = null
    for (unit in units) {
      if (oneBasedLine < unit.startLine || oneBasedLine > unit.endLine) continue
      val chosen = best
      if (chosen == null || unit.endLine - unit.startLine < chosen.endLine - chosen.startLine) best = unit
    }
    return best
  }

  /** The directory a document's relative references resolve against. */
  fun workDirOf(file: VirtualFile): Path? =
    file.takeIf { it.isInLocalFileSystem }?.parent?.toNioPathOrNull()

  private fun VirtualFile.toNioPathOrNull(): Path? = runCatching { toNioPath() }.getOrNull()

  // -------------------------------------------------------------------------

  /** `geml list - --json` over the buffer as it is now. */
  fun list(text: String, workDir: Path?): List<GemlUnit>? {
    val r = GemlCli.run(listOf("list", "-", "--json"), workDir, text) ?: return null
    return parseUnits(r.stdout)
  }

  /** `geml check --json -` over the buffer as it is now. */
  fun check(text: String, workDir: Path?): List<GemlDiagnostic>? {
    val r = GemlCli.run(listOf("check", "--json", "-"), workDir, text) ?: return null
    return parseDiagnostics(r.stdout)
  }

  fun parseUnits(json: String): List<GemlUnit>? = readArray(json) { o ->
    val lines = o.getAsJsonArray("lines")
    GemlUnit(
      address = o.get("address")?.takeIf { !it.isJsonNull }?.asString ?: return@readArray null,
      kind = o.get("kind")?.takeIf { !it.isJsonNull }?.asString ?: "block",
      startLine = lines?.get(0)?.asInt ?: 1,
      endLine = lines?.get(1)?.asInt ?: lines?.get(0)?.asInt ?: 1,
      id = o.get("id")?.takeIf { !it.isJsonNull }?.asString,
      level = o.get("level")?.takeIf { !it.isJsonNull }?.asInt,
      text = o.get("text")?.takeIf { !it.isJsonNull }?.asString,
      anon = o.get("anon")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
    )
  }

  fun parseDiagnostics(json: String): List<GemlDiagnostic>? = readArray(json) { o ->
    GemlDiagnostic(
      severity = o.get("severity")?.takeIf { !it.isJsonNull }?.asString ?: "error",
      code = o.get("code")?.takeIf { !it.isJsonNull }?.asString,
      message = o.get("message")?.takeIf { !it.isJsonNull }?.asString ?: "GEML diagnostic",
      line = o.get("line")?.takeIf { !it.isJsonNull }?.asInt ?: 1,
    )
  }

  /**
   * Null, not an empty list, whenever the output is not the array we asked for:
   * the CLI answers an error with an `{error, code}` envelope, and a document
   * caught mid-keystroke can produce one. "I do not know" has to stay
   * distinguishable from "there is nothing", or a transient parse failure would
   * blank the structure view.
   */
  private fun <T> readArray(json: String, row: (com.google.gson.JsonObject) -> T?): List<T>? {
    val root = runCatching { JsonParser.parseString(json) }.getOrNull() ?: return null
    if (!root.isJsonArray) return null
    return root.asJsonArray.mapNotNull { el ->
      if (el.isJsonObject) row(el.asJsonObject) else null
    }
  }
}
