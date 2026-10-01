// The plugin builds on its own, out of the monorepo's Gradle-free world: no
// root build file to inherit from, and nothing else here speaks Gradle.
pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

rootProject.name = "geml-intellij"
