package org.geml.intellij

import com.google.gson.JsonParser
import com.intellij.ide.actions.SearchEverywhereBaseAction
import com.intellij.ide.actions.searcheverywhere.SearchEverywhereContributor
import com.intellij.ide.actions.searcheverywhere.SearchEverywhereContributorFactory
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.util.Processor
import javax.swing.JList
import javax.swing.ListCellRenderer
import org.geml.intellij.cli.GemlCli

/** One row of `geml find --json`. */
class GemlHit(val file: VirtualFile, val relative: String, val address: String, val kind: String, val line: Int)

/**
 * Find a block in any document in the project, by address or by content.
 *
 * `geml find <pattern> <dir> --json` already answers this, and it answers in the
 * currency that matters — an address you can paste into `geml get` — rather than
 * a line number. So this is a thin mapping onto Search Everywhere rows.
 *
 * Search Everywhere rather than Go to Symbol, and not by preference: the
 * ChooseByName contributors are shaped for an index ("give me every name, I will
 * filter"), and this search has no index to enumerate — the pattern has to reach
 * the CLI. SearchEverywhereContributor is the one extension point that is handed
 * the pattern and a cancellable indicator, which is exactly a live external
 * search.
 *
 * One thing differs from a code language's Go to Symbol, and it is worth
 * knowing: `geml find` matches block CONTENT, not just names. For prose that is
 * the more useful of the two — block ids are rarely what you remember, sentences
 * are — so rows whose ADDRESS matches are ranked first and the rest follow.
 */
class GemlSearchEverywhereContributor(private val project: Project) : SearchEverywhereContributor<GemlHit> {

  private companion object {
    /** Below this, a query matches most of every document and the list is noise. */
    const val MIN_QUERY = 2

    /** A guard on the reply, not the search: one common word can match thousands. */
    const val MAX_HITS = 500
  }

  override fun getSearchProviderId(): String = GemlSearchEverywhereContributor::class.java.simpleName
  override fun getGroupName(): String = "GEML Blocks"
  override fun getSortWeight(): Int = 600
  override fun showInFindResults(): Boolean = false
  override fun isShownInSeparateTab(): Boolean = true

  override fun fetchElements(pattern: String, indicator: ProgressIndicator, consumer: Processor<in GemlHit>) {
    val query = pattern.trim()
    if (query.length < MIN_QUERY) return

    val roots = ProjectRootManager.getInstance(project).contentRoots
      .filter { it.isInLocalFileSystem && it.isDirectory }
    val hits = ArrayList<GemlHit>()

    for (root in roots) {
      if (indicator.isCanceled) return
      // `.` — the folder travels in the working directory, never in argv.
      val result = GemlCli.run(
        listOf("find", query, ".", "--json"),
        runCatching { root.toNioPath() }.getOrNull() ?: continue,
        null,
        indicator,
      ) ?: continue
      // Exit 1 is "nothing matched", which is not an error.
      if (result.stdout.isEmpty()) continue
      hits += parse(result.stdout, root)
    }

    // Address matches first: somebody typing `budget` who means `#budget` should
    // not have to scroll past every paragraph that mentions the word.
    val needle = query.lowercase()
    hits.sortBy { rank(it, needle) }
    for (hit in hits.take(MAX_HITS)) {
      if (indicator.isCanceled || !consumer.process(hit)) return
    }
  }

  private fun parse(json: String, root: VirtualFile): List<GemlHit> {
    val parsed = runCatching { JsonParser.parseString(json) }.getOrNull() ?: return emptyList()
    if (!parsed.isJsonArray) return emptyList()
    return parsed.asJsonArray.mapNotNull { element ->
      if (!element.isJsonObject) return@mapNotNull null
      val o = element.asJsonObject
      val relative = o.get("file")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
      val address = o.get("address")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
      val file = VfsUtilCore.findRelativeFile(relative.replace('\\', '/'), root) ?: return@mapNotNull null
      val line = o.getAsJsonArray("lines")?.get(0)?.asInt ?: 1
      GemlHit(
        file = file,
        relative = relative,
        address = address,
        kind = o.get("kind")?.takeIf { !it.isJsonNull }?.asString ?: "block",
        line = (line - 1).coerceAtLeast(0),
      )
    }
  }

  private fun rank(hit: GemlHit, needle: String): Int {
    val address = hit.address.lowercase()
    return when {
      address == "#$needle" -> 0
      address.contains(needle) -> 1
      else -> 2
    }
  }

  override fun processSelectedItem(selected: GemlHit, modifiers: Int, searchText: String): Boolean {
    OpenFileDescriptor(project, selected.file, selected.line, 0).navigate(true)
    return true
  }

  override fun getElementsRenderer(): ListCellRenderer<in GemlHit> = object : ColoredListCellRenderer<GemlHit>() {
    override fun customizeCellRenderer(
      list: JList<out GemlHit>,
      value: GemlHit,
      index: Int,
      selected: Boolean,
      hasFocus: Boolean,
    ) {
      icon = GemlIcons.FILE
      append(value.address)
      append("  ${value.kind}", SimpleTextAttributes.GRAY_ATTRIBUTES)
      // The file is the useful thing to see when the same address exists in
      // several documents, which for `#meta` it always does.
      append("  ${value.relative}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
    }
  }

  override fun getDataForItem(element: GemlHit, dataId: String): Any? = null
}

class GemlSearchEverywhereContributorFactory : SearchEverywhereContributorFactory<GemlHit> {
  override fun createContributor(initEvent: AnActionEvent): SearchEverywhereContributor<GemlHit> =
    GemlSearchEverywhereContributor(initEvent.project!!)
}

/** Opens Search Everywhere with the GEML tab already selected. */
class GemlFindBlockAction : SearchEverywhereBaseAction() {
  override fun actionPerformed(event: AnActionEvent) {
    showInSearchEverywherePopup(
      GemlSearchEverywhereContributor::class.java.simpleName,
      event,
      true,
      true,
    )
  }
}
