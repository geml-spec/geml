package org.geml.intellij.preview

import java.net.URI
import java.nio.file.Path

/**
 * What may load in the preview pane, and what its page may load.
 *
 * The pane is a browser showing one local page, and the document it renders is
 * whatever the project says. A link in it — `[x](https://…)` — would navigate
 * the pane itself, and the page that replaced the preview would then be handed
 * every keystroke's render message and the host's message channel. So the pane
 * shows the preview page and nothing else, and the page's policy lets no script
 * run but its own.
 *
 * Plain JDK, so it is tested without an IDE.
 */
object GemlPreviewPolicy {

  /**
   * Whether `url` is the preview page, a jump to one of its own anchors
   * included. Compared as normalized file paths, so Chromium's spelling of the
   * URL and Java's need not agree on which characters to escape or on `..`.
   */
  fun isPage(url: String?, page: Path): Boolean {
    if (url == null || !url.startsWith("file:", ignoreCase = true)) return false
    val loaded = runCatching { Path.of(URI(url.substringBefore('#'))) }.getOrNull() ?: return false
    return loaded.normalize() == page.toAbsolutePath().normalize()
  }

  /** A link to open in the system browser instead: http and https, nothing else. */
  fun isWebLink(url: String): Boolean {
    val scheme = url.substringBefore(':', "").lowercase()
    return scheme == "http" || scheme == "https"
  }

  /**
   * The page's Content-Security-Policy: the VS Code webview's, with `file:` —
   * where the plugin's bundle and the page live — in place of the webview's
   * resource origin. Scripts run only with the page's nonce; 'unsafe-inline'
   * styles are Mermaid's requirement, and widen nothing a document can use.
   */
  fun csp(nonce: String): String = listOf(
    "default-src 'none'",
    "img-src file: https: data:",
    "font-src file:",
    "style-src file: 'unsafe-inline'",
    "script-src 'nonce-$nonce'",
  ).joinToString("; ")
}
