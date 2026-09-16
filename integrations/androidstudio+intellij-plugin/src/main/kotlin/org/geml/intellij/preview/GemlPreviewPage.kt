package org.geml.intellij.preview

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.extensions.PluginId
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * The preview page.
 *
 * The renderer is the viewer's, byte for byte — the same bundle the VS Code
 * webview, the browser extension and the playground use, built once by
 * integrations/geml-viewer. So the pane cannot show something a reader would
 * not see, and there is no second renderer here to keep in step.
 *
 * Two things are this plugin's own. The page script talks to its host through
 * VS Code's tiny `acquireVsCodeApi()` interface, so that gets a shim over JCEF's
 * query channel rather than a fork of preview.js. And the `--vscode-*` custom
 * properties preview.css is written against get their values from the IDE's
 * current colour scheme, which is what makes the pane match Darcula or a
 * high-contrast theme without either side knowing about the other.
 */
object GemlPreviewPage {

  private const val PLUGIN_ID = "org.geml.intellij"

  /** Where prepareBundledRuntime put the viewer's bundle. */
  val assets: Path? by lazy {
    val dir = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath?.resolve("preview")
    if (dir != null && Files.isRegularFile(dir.resolve("geml-webview.js"))) dir else null
  }

  /**
   * Write the page and return its URL. It lives in the IDE's temp directory and
   * names every asset absolutely, rather than sitting next to them: a plugin
   * directory under Program Files is not writable, and a preview that only
   * worked for some installations would be worse than none.
   */
  fun write(postMessageJs: String, dark: Boolean): String? {
    val dir = assets ?: return null
    val page = Path.of(PathManager.getTempPath(), "geml-preview").also { Files.createDirectories(it) }
      .resolve("preview-${if (dark) "dark" else "light"}.html")
    Files.write(page, html(dir, postMessageJs, dark).toByteArray(StandardCharsets.UTF_8))
    return page.toUri().toString()
  }

  private fun url(dir: Path, name: String): String = dir.resolve(name).toUri().toString()

  private fun html(dir: Path, postMessageJs: String, dark: Boolean): String = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GEML preview</title>
<link rel="stylesheet" href="${url(dir, "geml.css")}">
<link rel="stylesheet" href="${url(dir, "katex.css")}">
<style>${themeVariables()}</style>
<link rel="stylesheet" href="${url(dir, "preview.css")}">
</head>
<body class="geml-body ${if (dark) "vscode-dark" else "vscode-light"}">
<p id="note" class="geml-preview-note" hidden></p>
<div id="doc" class="geml-doc"></div>
<script>
// The host side of preview.js, over JCEF instead of a webview. Same three
// calls, same message shapes — which is the whole reason preview.js itself can
// be copied in unchanged.
(function () {
  var saved = null;
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) { $postMessageJs },
      getState: function () { return saved; },
      setState: function (s) { saved = s; return s; }
    };
  };
})();
</script>
<script src="${url(dir, "geml-webview.js")}"></script>
<script src="${url(dir, "preview.js")}"></script>
</body>
</html>
""".trimIndent()

  /**
   * preview.css is written against VS Code's custom properties. Rather than fork
   * it, hand it the IDE's colours under the names it already asks for.
   */
  private fun themeVariables(): String {
    val scheme = EditorColorsManager.getInstance().globalScheme
    val editorBackground = scheme.defaultBackground
    val editorForeground = scheme.defaultForeground
    val panel = UIUtil.getPanelBackground()
    val border = JBColor.border()
    val link = JBUI.CurrentTheme.Link.Foreground.ENABLED
    val error = JBColor.namedColor("Label.errorForeground", JBColor(0xC7222D, 0xFF5261))
    val warning = JBColor.namedColor("Component.warningFocusColor", JBColor(0xE8A33D, 0xD9A343))

    return """
      :root {
        --vscode-editor-background: ${hex(editorBackground)};
        --vscode-editor-foreground: ${hex(editorForeground)};
        --vscode-editor-font-family: "${scheme.editorFontName}", monospace;
        --vscode-font-family: "${UIUtil.getLabelFont().family}", sans-serif;
        --vscode-editorError-foreground: ${hex(error)};
        --vscode-inputValidation-errorBackground: ${hex(mix(editorBackground, error, 0.18))};
        --vscode-inputValidation-errorForeground: ${hex(editorForeground)};
        --vscode-inputValidation-warningBackground: ${hex(mix(editorBackground, warning, 0.18))};
        --vscode-inputValidation-warningForeground: ${hex(editorForeground)};
        --vscode-keybindingTable-headerBackground: ${hex(panel)};
        --vscode-list-hoverBackground: ${hex(mix(editorBackground, editorForeground, 0.08))};
        --vscode-panel-border: ${hex(border)};
        --vscode-textBlockQuote-background: ${hex(mix(editorBackground, editorForeground, 0.05))};
        --vscode-textBlockQuote-border: ${hex(border)};
        --vscode-textCodeBlock-background: ${hex(mix(editorBackground, editorForeground, 0.07))};
        --vscode-textLink-foreground: ${hex(link)};
        --vscode-textLink-activeForeground: ${hex(link)};
      }
    """.trimIndent()
  }

  private fun hex(color: Color): String = String.format("#%02x%02x%02x", color.red, color.green, color.blue)

  /** `weight` of `over` laid on `base` — for the tints a colour scheme does not name. */
  private fun mix(base: Color, over: Color, weight: Double): Color = Color(
    (base.red + (over.red - base.red) * weight).toInt().coerceIn(0, 255),
    (base.green + (over.green - base.green) * weight).toInt().coerceIn(0, 255),
    (base.blue + (over.blue - base.blue) * weight).toInt().coerceIn(0, 255),
  )
}
