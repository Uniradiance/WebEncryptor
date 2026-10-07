// WebEncryptor Android port (route B: WebView + native storage bridge).
//
// The repository root stays the single source of truth for the web frontend:
// `htdocs/` is *not* copied into this module, it is added as an extra asset
// source directory (see app/build.gradle.kts). That guarantees the shipped web
// app is byte-identical to the desktop one.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "WebEncryptorAndroid"
include(":app")
