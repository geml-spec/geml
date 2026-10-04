package org.geml.intellij.preview

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * The preview pane shows one local page, rendering whatever the project's
 * document says. A link in that document must not become the page the pane
 * shows — and so the page that receives every keystroke's render message.
 */
class GemlPreviewPolicyTest {

  private val dir = Files.createTempDirectory("geml preview ü-")
  private val page = dir.resolve("preview-dark.html")

  @Test
  fun `round 6 - only the preview page itself may load in the pane`() {
    val url = page.toUri().toString()
    assertTrue(GemlPreviewPolicy.isPage(url, page))
    assertTrue("an anchor on the page is the page", GemlPreviewPolicy.isPage("$url#budget", page))
    // Chromium escapes every non-ASCII character; Java's URI keeps them.
    assertTrue("however the URL escapes the path", GemlPreviewPolicy.isPage(page.toUri().toASCIIString(), page))
    val dotted = dir.resolve("sub").resolve("..").resolve("preview-dark.html").toUri().toString()
    assertTrue("and after `..` is resolved", GemlPreviewPolicy.isPage(dotted, page))

    for (other in listOf(
      "https://attacker.example/x", "http://localhost:8080/preview-dark.html", "about:blank",
      dir.resolve("other.html").toUri().toString(), "$url?x=1", "javascript:alert(1)", "data:text/html,hi",
    )) {
      assertFalse(other, GemlPreviewPolicy.isPage(other, page))
    }
    assertFalse(GemlPreviewPolicy.isPage(null, page))
  }

  @Test
  fun `round 6 - only a web link is handed to the system browser`() {
    for (url in listOf("https://example.com/x", "http://example.com", "HTTPS://EXAMPLE.COM")) {
      assertTrue(url, GemlPreviewPolicy.isWebLink(url))
    }
    for (url in listOf("file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank", "ftp://x", "mailto:a@b", "x")) {
      assertFalse(url, GemlPreviewPolicy.isWebLink(url))
    }
  }

  @Test
  fun `round 6 - the page runs no script but its own`() {
    val policy = GemlPreviewPolicy.csp("n0nce").split(';').map { it.trim() }
    assertTrue(policy.toString(), "default-src 'none'" in policy)
    assertTrue(policy.toString(), "script-src 'nonce-n0nce'" in policy)
    val scripts = policy.first { it.startsWith("script-src") }
    for (loose in listOf("'unsafe-inline'", "'unsafe-eval'", "file:", "https:", "*")) {
      assertFalse("script-src allows $loose", scripts.contains(loose))
    }
    assertFalse("nothing to connect to", policy.any { it.startsWith("connect-src") || it.startsWith("frame-src") })
  }
}
