import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The GEML plugin for IntelliJ-based IDEs, Android Studio included.
//
// Built against IntelliJ IDEA Community, which is the platform Android Studio
// is built on. Nothing here touches an Android API, so the result installs in
// Android Studio, IDEA CE/Ultimate, PyCharm and the rest from one zip.
plugins {
  kotlin("jvm") version "2.1.0"
  id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "org.geml"
version = "0.2.0"

repositories {
  mavenCentral()
  intellijPlatform { defaultRepositories() }
}

dependencies {
  intellijPlatform {
    // IDEA Community, not androidStudio(): the Android Studio artifact is a
    // 1 GB download that adds only APIs this plugin must not use anyway.
    intellijIdeaCommunity("2024.2.5")
  }
  // Plain JUnit, no IDE fixture. What is worth testing here is the lexer and the
  // reference scanner, and both are ordinary functions over text — standing an
  // Application up to exercise them would buy nothing and cost a minute a run.
  testImplementation("junit:junit:4.13.2")
}

tasks.test {
  useJUnit()
  testLogging { showStandardStreams = false }
}

kotlin {
  compilerOptions { jvmTarget = JvmTarget.JVM_17 }
}
java {
  // 17, not the JDK we happen to compile with: an IDE on JBR 17 would refuse
  // class files built for 21, and Android Studio pins its own runtime.
  sourceCompatibility = JavaVersion.VERSION_17
  targetCompatibility = JavaVersion.VERSION_17
}

intellijPlatform {
  pluginConfiguration {
    ideaVersion {
      // 242 = 2024.2 = Android Studio Ladybug. Lower it if a friend is on an
      // older Studio; nothing in this plugin needs a recent API.
      sinceBuild = "242"
      // Left open on purpose. This plugin is installed by hand from a zip, and
      // an untilBuild is the usual reason a hand-installed plugin stops loading
      // after an IDE update it would have run in perfectly well.
      untilBuild = provider { null }
    }
  }
  // Nothing to index: the settings page has two fields and no searchable text
  // worth launching a headless IDE to collect.
  buildSearchableOptions = false
}

// ---------------------------------------------------------------------------
// What the plugin carries with it.
//
// The parser's dist/ goes INSIDE the plugin so installing it is one drag of one
// zip: no `npm i -g @geml/geml`, no PATH, and no way for the plugin and the CLI
// answering it to be different versions. dist/ has zero runtime dependencies,
// so "carry the CLI" means copying .js files — Node is the only thing the user
// still has to have.
//
// The preview's bundle comes from integrations/vscode/media, which the viewer
// package already builds for the VS Code webview. One esbuild configuration,
// two editors: a second one here would be a second place for the node-module
// alias list to go stale.
// ---------------------------------------------------------------------------
val parserDist = layout.projectDirectory.dir("../../geml-parser/dist")
val viewerMedia = layout.projectDirectory.dir("../vscode/media")
val bundledDir = layout.buildDirectory.dir("bundled")

val parserPackageJson = layout.projectDirectory.file("../../geml-parser/package.json")
val parserEntry = parserDist.file("cli.js").asFile
val previewEntry = viewerMedia.file("geml-webview.js").asFile

val prepareBundledRuntime by tasks.registering(Sync::class) {
  description = "Stage the parser CLI and the preview bundle for the plugin distribution."
  into(bundledDir)
  into("geml") {
    // .js only: the .d.ts files are half of dist/ and mean nothing at runtime.
    from(parserDist) { include("**/*.js") }
    // The package.json travels with them, and is not optional.
    //
    // dist/ is ES modules, and Node decides that from the nearest package.json.
    // Without one, only a Node new enough to guess from the syntax (24, and 22.7
    // behind a flag) runs the CLI at all — every older one dies on the first
    // `import` and takes the plugin's diagnostics, structure view and folding
    // with it. It is also where PARSER_VERSION is read from at runtime, so
    // leaving it out makes the bundled parser report itself as 0.0.0.
    from(parserPackageJson)
  }
  into("preview") {
    from(viewerMedia) {
      include("geml-webview.js", "geml.css", "katex.css", "preview.js", "preview.css", "fonts/**")
    }
  }
  doFirst {
    check(parserEntry.exists()) {
      "geml-parser is not built. Run:  cd ../../geml-parser && npm install && npm run build"
    }
    check(previewEntry.exists()) {
      "the preview bundle is not built. Run:  npm --prefix ../geml-viewer run build:vscode"
    }
  }
}

tasks {
  prepareSandbox {
    dependsOn(prepareBundledRuntime)
    // Alongside lib/, not inside a jar: the plugin hands these paths to `node`
    // and to a browser, and neither can open a file that only exists as a jar
    // entry. pluginPath in GemlCli/GemlPreview resolves to this same directory.
    from(bundledDir) { into(pluginName.get()) }
  }

  // Point this at a local Android Studio to debug there instead of IDEA CE:
  //   runIde { ideDir = file("C:/Program Files/Android/Android Studio") }
}
