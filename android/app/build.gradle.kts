import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// Single source of truth for the web frontend
// ---------------------------------------------------------------------------
// `htdocs/` in the repository root is used directly as an asset directory: the
// web app is never copied, patched or regenerated for Android. If this module
// is ever built outside the repository (a released source archive without the
// root), fall back to a vendored copy under app/src/main/assets/htdocs.
val repoRoot: File = rootProject.projectDir.parentFile
val repoHtdocs: File = repoRoot.resolve("htdocs")
val vendoredHtdocs: File = file("src/main/assets/htdocs")
val htdocsDir: File = if (repoHtdocs.isDirectory) repoHtdocs else vendoredHtdocs

// Injected platform shim. It is *not* part of htdocs: it is installed into the
// page by the native host before any page script runs.
val bridgeAssetsDir: File = file("src/main/bridge-assets")

android {
    namespace = "com.webencryptor.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.webencryptor.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        resourceConfigurations += listOf("en")
    }

    signingConfigs {
        val storePath = System.getenv("WE_KEYSTORE_FILE")
        if (!storePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(storePath)
                storePassword = System.getenv("WE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WE_KEY_ALIAS") ?: "webencryptor"
                keyPassword = System.getenv("WE_KEY_PASSWORD") ?: System.getenv("WE_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Falls back to the debug key so `assembleRelease` works on a bare
            // checkout; CI/release builds export the WE_KEYSTORE_* variables.
            signingConfig =
                if (!System.getenv("WE_KEYSTORE_FILE").isNullOrBlank()) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    sourceSets["main"].assets.srcDirs(htdocsDir, bridgeAssetsDir)

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "DebugProbesKt.bin")
    }
}

// ---------------------------------------------------------------------------
// Provenance manifest
// ---------------------------------------------------------------------------
// Records the SHA-256 of every shipped web asset so an APK can be tied back to
// an exact htdocs revision.
val generatedAssetDir: Provider<Directory> = layout.buildDirectory.dir("generated/weAssets")

val generateHtdocsManifest by tasks.registering {
    description = "Writes the SHA-256 manifest of the web assets packaged into the APK."
    val source = htdocsDir
    val shim = bridgeAssetsDir
    val outDir = generatedAssetDir
    inputs.dir(source)
    inputs.dir(shim)
    outputs.dir(outDir)
    doLast {
        val target = outDir.get().asFile
        target.mkdirs()
        fun digest(f: File): String =
            MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }

        val files = sortedMapOf<String, String>()
        fun collect(root: File, prefix: String) {
            root.walkTopDown().filter { it.isFile }.sortedBy { it.relativeTo(root).invariantSeparatorsPath }.forEach {
                files["$prefix${it.relativeTo(root).invariantSeparatorsPath}"] = digest(it)
            }
        }
        collect(source, "htdocs/")
        collect(shim, "bridge/")

        val root = MessageDigest.getInstance("SHA-256")
        files.forEach { (path, sha) -> root.update("$path:$sha\n".toByteArray()) }
        val rootHash = root.digest().joinToString("") { "%02x".format(it) }

        val json = buildString {
            append("{\n")
            append("  \"note\": \"Generated at build time; identifies the web assets packaged into this APK.\",\n")
            append("  \"source\": \"").append(source.absolutePath).append("\",\n")
            append("  \"rootHash\": \"").append(rootHash).append("\",\n")
            append("  \"files\": {\n")
            files.entries.forEachIndexed { i, (path, sha) ->
                append("    \"").append(path).append("\": \"").append(sha).append("\"")
                append(if (i == files.size - 1) "\n" else ",\n")
            }
            append("  }\n}\n")
        }
        target.resolve("htdocs-manifest.json").writeText(json)
        println("Web assets: ${files.size} files from ${source.absolutePath} (rootHash $rootHash)")
    }
}

tasks.named("preBuild") { dependsOn(generateHtdocsManifest) }
android.sourceSets["main"].assets.srcDir(generatedAssetDir)

// Guard: the port must never mutate the shared frontend.
val verifyHtdocsUntouched by tasks.registering {
    description = "Fails if htdocs/ has uncommitted modifications."
    doLast {
        if (!repoHtdocs.isDirectory) {
            println("htdocs/ not present (standalone build); skipping check.")
            return@doLast
        }
        val git = providers.exec {
            workingDir = repoRoot
            commandLine("git", "status", "--porcelain", "--", "htdocs")
        }
        val dirty = git.standardOutput.asText.get().trim()
        if (dirty.isNotEmpty()) {
            throw GradleException("htdocs/ has uncommitted changes; the Android port must not modify the web frontend:\n$dirty")
        }
        println("htdocs/ is clean: the packaged frontend is the desktop one.")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

}
