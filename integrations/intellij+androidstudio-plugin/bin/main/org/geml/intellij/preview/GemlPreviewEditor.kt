package org.geml.intellij.preview

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.ui.JBUI
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.beans.PropertyChangeListener
import java.nio.file.Path
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The preview half of the split editor.
 *
 * The document is rendered INSIDE the page, by the viewer's renderer, so a
 * keystroke costs one parse in the browser rather than a process per keystroke.
 * Diagnostics stay with the CLI and the Problems view (GemlAnnotator); this pane
 * only draws.
 */
class GemlPreviewEditor(private val project: Project, private val file: VirtualFile) :
  UserDataHolderBase(), FileEditor {

  private val panel = JPanel(BorderLayout())
  private val browser: JBCefBrowser? = if (JBCefApp.isSupported()) JBCefBrowser() else null
  private val query: JBCefJSQuery? = browser?.let { JBCefJSQuery.create(it as com.intellij.ui.jcef.JBCefBrowserBase) }
  private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
  private var ready = false

  /** The preview page; the only thing this pane loads, posts to, or listens to. */
  private var page: Path? = null

  init {
    val browser = this.browser
    val query = this.query
    if (browser == null || query == null) {
      panel.add(unsupportedNotice(), BorderLayout.CENTER)
    } else {
      Disposer.register(this, browser)
      query.addHandler { request -> onMessage(request); null }

      // The theme is read once, when the pane is created: reopen the preview
      // after switching themes and it follows.
      val page = GemlPreviewPage.write(query.inject("JSON.stringify(msg)"), dark = !JBColor.isBright())
      if (page == null) {
        panel.add(missingBundleNotice(), BorderLayout.CENTER)
      } else {
        this.page = page
        keepToPage(browser, page)
        panel.add(browser.component, BorderLayout.CENTER)
        browser.loadURL(page.toUri().toString())
      }
    }

    document()?.addDocumentListener(object : DocumentListener {
      override fun documentChanged(event: DocumentEvent) = scheduleRender()
    }, this)
  }

  // -------------------------------------------------------------------------

  private fun document(): Document? = FileDocumentManager.getInstance().getDocument(file)

  /**
   * Hold the pane to the preview page (see GemlPreviewPolicy). Any other
   * navigation is cancelled — a link the user clicked to a web page opens in
   * the system browser instead — and so is every new window, `target=_blank`
   * and a middle click among them.
   */
  private fun keepToPage(browser: JBCefBrowser, page: Path) {
    val client = browser.jbCefClient
    client.addRequestHandler(object : CefRequestHandlerAdapter() {
      override fun onBeforeBrowse(
        cefBrowser: CefBrowser?, frame: CefFrame?, request: CefRequest?, userGesture: Boolean, isRedirect: Boolean,
      ): Boolean {
        val url = request?.url ?: return true
        if (GemlPreviewPolicy.isPage(url, page)) return false
        if (userGesture) openOutside(url)
        return true
      }

      override fun onOpenURLFromTab(cefBrowser: CefBrowser?, frame: CefFrame?, targetUrl: String?, userGesture: Boolean): Boolean {
        if (userGesture && targetUrl != null) openOutside(targetUrl)
        return true
      }
    }, browser.cefBrowser)
    client.addLifeSpanHandler(object : CefLifeSpanHandlerAdapter() {
      override fun onBeforePopup(cefBrowser: CefBrowser?, frame: CefFrame?, targetUrl: String?, targetFrameName: String?): Boolean {
        if (targetUrl != null) openOutside(targetUrl)
        return true
      }
    }, browser.cefBrowser)
  }

  /** A web link, in the system browser; anything else goes nowhere. */
  private fun openOutside(url: String) {
    if (GemlPreviewPolicy.isWebLink(url)) ApplicationManager.getApplication().invokeLater { BrowserUtil.browse(url) }
  }

  /** Whether the pane is showing the preview page — the only page a message goes to or comes from. */
  private fun showingPage(browser: JBCefBrowser): Boolean {
    val page = this.page ?: return false
    return GemlPreviewPolicy.isPage(browser.cefBrowser.url, page)
  }

  /**
   * Debounced. The renderer is fast, but a held-down key should not queue one
   * full render per character — and the pane is a reading surface, so being a
   * beat behind the caret is not a cost.
   */
  private fun scheduleRender() {
    if (!ready) return
    alarm.cancelAllRequests()
    alarm.addRequest({ render() }, 200)
  }

  private fun render() {
    val browser = this.browser ?: return
    val text = document()?.text ?: return
    val message = JsonObject().apply {
      addProperty("type", "render")
      addProperty("text", text)
      addProperty("uri", file.url)
      add("docs", JsonObject())          // cross-document embeds: see the class note
      add("skipped", com.google.gson.JsonArray())
    }
    post(browser, message.toString())
  }

  private fun post(browser: JBCefBrowser, json: String) {
    // The message carries the document: into the preview page, or nowhere.
    if (!showingPage(browser)) return
    browser.cefBrowser.executeJavaScript("window.postMessage($json, '*');", browser.cefBrowser.url, 0)
  }

  /** Page to host. The shapes are preview.js's, unchanged. */
  private fun onMessage(request: String?) {
    // The message router answers whatever page the browser holds; only the
    // preview page speaks for this pane.
    if (!showingPage(this.browser ?: return)) return
    val root = runCatching { JsonParser.parseString(request ?: "") }.getOrNull() ?: return
    if (!root.isJsonObject) return
    val message = root.asJsonObject
    when (message.get("type")?.asString) {
      "ready" -> {
        ready = true
        render()
      }
      "translate" -> {
        // Answered, not ignored. VS Code can borrow the editor's language model
        // for a translated projection; nothing in Android Studio offers a
        // third-party plugin the same thing, so say so at once — silence here
        // would leave the renderer waiting out its own minute-long timeout
        // before showing the source it is going to show anyway.
        val browser = this.browser ?: return
        val id = message.get("id") ?: return
        val answer = JsonObject().apply {
          addProperty("type", "translations")
          add("id", id)
          add("result", JsonObject().apply {
            addProperty("why", "this IDE has no translator the preview can use")
            addProperty("retryable", false)
          })
        }
        post(browser, answer.toString())
      }
    }
  }

  private fun unsupportedNotice(): JComponent = notice(
    "This IDE's runtime has no embedded browser, so the GEML preview cannot be shown. " +
      "Switching the boot runtime to a JetBrains Runtime with JCEF enables it."
  )

  private fun missingBundleNotice(): JComponent = notice(
    "The GEML plugin is missing its preview bundle. Rebuild it with: " +
      "npm --prefix ../chrome-geml-viewer run build:vscode"
  )

  private fun notice(text: String): JComponent = JLabel(
    "<html><body style='width: 320px; text-align: center'>$text</body></html>",
    SwingConstants.CENTER,
  ).apply { border = JBUI.Borders.empty(24) }

  // -------------------------------------------------------------------------

  override fun getComponent(): JComponent = panel
  override fun getPreferredFocusedComponent(): JComponent? = browser?.component
  override fun getName(): String = "Preview"
  override fun getFile(): VirtualFile = file
  override fun setState(state: FileEditorState) = Unit
  override fun getState(level: FileEditorStateLevel): FileEditorState = FileEditorState.INSTANCE
  override fun isModified(): Boolean = false
  override fun isValid(): Boolean = file.isValid && !project.isDisposed
  override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit
  override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit
  override fun dispose() = Unit
}
