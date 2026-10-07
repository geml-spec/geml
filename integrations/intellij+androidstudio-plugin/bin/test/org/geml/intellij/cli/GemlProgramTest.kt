package org.geml.intellij.cli

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * What the plugin is willing to run. Every CLI run happens in the document's
 * folder, and a cloned project fills that folder: a `geml` of its own, a
 * node_modules holding its own `@geml/geml`. None of it may be what runs.
 */
class GemlProgramTest {

  /** A directory holding executable files of these names. */
  private fun dirWith(vararg names: String): Path {
    val dir = Files.createTempDirectory("geml-program-")
    for (name in names) {
      val file = dir.resolve(name)
      Files.writeString(file, "#!/bin/sh\n")
      file.toFile().setExecutable(true)
    }
    return dir
  }

  private fun pathOf(vararg entries: Any): String = entries.joinToString(File.pathSeparator)

  @Test
  fun `round 6 - a package runner is refused, however it is spelled`() {
    for (program in listOf("npx", "NPX.cmd", "/usr/local/bin/npx", "C:\\Program Files\\nodejs\\npx.cmd", "pnpm", "yarn", "bunx")) {
      assertNotNull(program, GemlProgram.refusal(program))
    }
    for (program in listOf("geml", "node", "/opt/geml/bin/geml", "C:\\tools\\geml.cmd")) {
      assertNull(program, GemlProgram.refusal(program))
    }
  }

  @Test
  fun `round 6 - a bare name is found in PATH's absolute entries, never in the current directory`() {
    val project = dirWith("geml")
    val installed = dirWith("geml")
    // A relative entry — `.` and an empty one among them — is read against the
    // current directory, which is the document's folder when the CLI runs.
    // Spelled against this JVM's, it reaches a folder that does hold a `geml`,
    // and still may not answer for it.
    val relative = Path.of("").toAbsolutePath().relativize(project).toString()
    assertEquals(installed.resolve("geml"), GemlProgram.resolve("geml", pathOf(relative, ".", "", installed), null, windows = false))
    assertNull(GemlProgram.resolve("geml", pathOf(relative, ".", ""), null, windows = false))
    assertNull("a relative path names the working directory too", GemlProgram.resolve("$relative/geml", pathOf(installed), null, windows = false))
    assertEquals(project.resolve("geml"), GemlProgram.resolve(project.resolve("geml").toString(), null, null, windows = false))
    assertEquals(listOf(installed), GemlProgram.searchPath(pathOf(relative, ".", "", installed)))
  }

  @Test
  fun `round 6 - on Windows a bare name takes PATHEXT's extensions, as cmd would`() {
    val installed = dirWith("geml", "geml.cmd")
    val project = dirWith("geml.cmd")
    val relative = Path.of("").toAbsolutePath().relativize(project).toString()
    // Windows matches PATHEXT's spelling in any case, and so may this disk.
    fun found(name: String, path: String) =
      GemlProgram.resolve(name, path, ".EXE;.CMD", windows = true)?.toString()?.lowercase()
    val shim = installed.resolve("geml.cmd").toString().lowercase()
    // The extensionless file is npm's sh script, which cmd.exe cannot run.
    assertEquals(shim, found("geml", pathOf(installed)))
    assertEquals(shim, found("geml.cmd", pathOf(installed)))
    assertNull(found("geml", pathOf(relative, ".")))
  }
}
