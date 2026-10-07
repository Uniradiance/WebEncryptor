// Root build script for the WebEncryptor Android port.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

// Optional build-directory relocation. The reference build host has a nearly
// full workspace partition, so CI passes -Pwe.buildRoot=/path/with/space to keep
// Gradle's intermediates off it. Unset (the default) keeps the standard layout.
val relocatedBuildRoot: String? = providers.gradleProperty("we.buildRoot").orNull
if (!relocatedBuildRoot.isNullOrBlank()) {
    allprojects {
        layout.buildDirectory.set(file("$relocatedBuildRoot/${project.name}"))
    }
}

// `./gradlew` needs no toolchain beyond a JDK, but the project is developed
// against the versions above; fail early with an actionable message instead of
// a wall of Kotlin/AGP errors.
tasks.register("checkToolchain") {
    val min = 17
    val current = JavaVersion.current()
    doLast {
        if (current.majorVersion.toInt() < min) {
            throw GradleException(
                "JDK ${current.majorVersion} detected. Android Gradle Plugin 8.7 requires JDK $min or newer " +
                    "(JAVA_HOME or -Dorg.gradle.java.home=<jdk>)."
            )
        }
        println("Toolchain OK: JDK ${current.majorVersion}, Gradle ${gradle.gradleVersion}")
    }
}
