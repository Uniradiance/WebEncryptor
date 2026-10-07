#!/usr/bin/env bash
#
# Provisions a self-contained Android build toolchain in a scratch prefix:
# Temurin JDK 17, the Android command-line tools + platform 35 + build-tools,
# and Gradle 8.11.1. Nothing is installed system-wide and no root is required.
#
#   tools/setup-toolchain.sh [prefix]        (default: /tmp/webencryptor-toolchain)
#
# Afterwards:  source <prefix>/env.sh
#
# This exists because the reference build host has a full workspace partition;
# see tools/ci-build.sh, which calls it automatically when the toolchain is
# missing and redirects Gradle's caches and build directory to the scratch prefix.
set -euo pipefail

prefix="${1:-${WE_TOOLCHAIN:-/tmp/webencryptor-toolchain}}"
dl="$prefix/downloads"
mkdir -p "$prefix" "$dl" "$prefix/sdk" "$prefix/gradle" "$prefix/gradle-home"

JDK_URL="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
GRADLE_URL="https://services.gradle.org/distributions/gradle-8.11.1-bin.zip"

fetch() { # url file
    if [ -s "$2" ]; then
        echo "    cached $(basename "$2")"
        return 0
    fi
    echo "    downloading $(basename "$2")"
    curl -fL --retry 3 --retry-delay 2 -o "$2.part" "$1"
    mv "$2.part" "$2"
}

unzip_to() { # zip dir
    mkdir -p "$2"
    # python3's zipfile does not restore the executable bit, so callers fix up
    # their bin/ directories afterwards with mark_executable.
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$1" "$2"
}

mark_executable() { # dir
    [ -d "$1" ] || return 0
    find "$1" -type f -exec chmod u+x {} +
}

echo "==> toolchain prefix: $prefix"

if [ ! -x "$prefix/jdk/bin/javac" ]; then
    echo "==> JDK 17"
    fetch "$JDK_URL" "$dl/jdk.tar.gz"
    mkdir -p "$prefix/jdk"
    tar -xzf "$dl/jdk.tar.gz" -C "$prefix/jdk" --strip-components=1
else
    echo "==> JDK 17 (already present)"
fi
export JAVA_HOME="$prefix/jdk"
export PATH="$JAVA_HOME/bin:$PATH"
"$JAVA_HOME/bin/java" -version

if [ ! -x "$prefix/gradle/gradle-8.11.1/bin/gradle" ]; then
    echo "==> Gradle 8.11.1"
    fetch "$GRADLE_URL" "$dl/gradle.zip"
    unzip_to "$dl/gradle.zip" "$prefix/gradle"
    mark_executable "$prefix/gradle/gradle-8.11.1/bin"
else
    echo "==> Gradle 8.11.1 (already present)"
fi

if [ ! -x "$prefix/sdk/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo "==> Android command-line tools"
    fetch "$CMDLINE_TOOLS_URL" "$dl/cmdline-tools.zip"
    rm -rf "$prefix/sdk/cmdline-tools" "$prefix/sdk/tmp-clt"
    unzip_to "$dl/cmdline-tools.zip" "$prefix/sdk/tmp-clt"
    mkdir -p "$prefix/sdk/cmdline-tools"
    mv "$prefix/sdk/tmp-clt/cmdline-tools" "$prefix/sdk/cmdline-tools/latest"
    rmdir "$prefix/sdk/tmp-clt" 2>/dev/null || true
    mark_executable "$prefix/sdk/cmdline-tools/latest/bin"
else
    echo "==> Android command-line tools (already present)"
fi

export ANDROID_HOME="$prefix/sdk"
export ANDROID_SDK_ROOT="$prefix/sdk"
export GRADLE_USER_HOME="$prefix/gradle-home"

# sdkmanager runs on the JVM, which cannot parse a `socks5://` proxy URL and
# refuses to start while HTTP(S)_PROXY holds one. Translate it into the JVM's own
# socket flags so the download still goes through the proxy. (curl, used above,
# understands socks5 directly, which is why the tarballs downloaded fine.)
sdk_proxy_opts=""
proxy_url="${HTTPS_PROXY:-${HTTP_PROXY:-${ALL_PROXY:-}}}"
case "$proxy_url" in
    socks5://* | socks://*)
        proxy_hostport="${proxy_url#*://}"
        sdk_proxy_opts="-DsocksProxyHost=${proxy_hostport%%:*} -DsocksProxyPort=${proxy_hostport##*:}"
        unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
        echo "==> using SOCKS proxy at $proxy_hostport for the JVM"
        ;;
esac
export JAVA_OPTS="${JAVA_OPTS:-} $sdk_proxy_opts"

# Gradle reads proxy settings from system properties in this file. It honours
# socksProxyHost, but on this host the SOCKS route only reaches dl.google.com while
# repo.maven.apache.org is only reachable directly -- and each route fails for the
# other host. tools/DevProxy.java (started by tools/ci-build.sh) presents one HTTP
# proxy that dials each host the way that works, so Gradle is pointed at it and
# every repository goes through it.
gradle_user_properties="$GRADLE_USER_HOME/gradle.properties"
dev_proxy_port="${WE_DEV_PROXY_PORT:-20180}"
if [ -n "$sdk_proxy_opts" ]; then
    {
        echo "# Written by android/tools/setup-toolchain.sh from HTTPS_PROXY=$proxy_url"
        echo "# tools/ci-build.sh runs tools/DevProxy.java on this port; it CONNECTs to"
        echo "# dl.google.com through the SOCKS proxy and to Maven Central directly."
        echo "# See the comment above for why one route is not enough."
        echo "systemProp.https.proxyHost=127.0.0.1"
        echo "systemProp.https.proxyPort=$dev_proxy_port"
        echo "systemProp.http.proxyHost=127.0.0.1"
        echo "systemProp.http.proxyPort=$dev_proxy_port"
    } > "$gradle_user_properties"
elif [ -f "$gradle_user_properties" ] && grep -q 'setup-toolchain.sh' "$gradle_user_properties"; then
    rm -f "$gradle_user_properties"
fi

sdkmanager="$prefix/sdk/cmdline-tools/latest/bin/sdkmanager"

if [ ! -d "$prefix/sdk/platforms/android-35" ] || [ ! -d "$prefix/sdk/build-tools/35.0.0" ]; then
    echo "==> accepting SDK licences"
    # `yes` exits on SIGPIPE once sdkmanager stops reading; that is expected.
    (yes || true) | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
    echo "==> installing platform-tools, android-35, build-tools 35.0.0"
    "$sdkmanager" --sdk_root="$ANDROID_HOME" --install \
        "platform-tools" "platforms;android-35" "build-tools;35.0.0" >/dev/null
else
    echo "==> SDK packages (already present)"
fi

cat > "$prefix/env.sh" <<EOF
# Generated by tools/setup-toolchain.sh -- source this before ./gradlew.
export JAVA_HOME="$prefix/jdk"
export ANDROID_HOME="$prefix/sdk"
export ANDROID_SDK_ROOT="$prefix/sdk"
export GRADLE_USER_HOME="$prefix/gradle-home"
# JAVA_OPTS is for sdkmanager, which speaks Java sockets directly and therefore
# does honour socksProxyHost. It is deliberately NOT exported as
# JAVA_TOOL_OPTIONS: that would route Gradle's "direct" connections through SOCKS
# too, and Maven Central is not reachable that way.
export JAVA_OPTS="\${JAVA_OPTS:-} $sdk_proxy_opts"
export WE_DEV_PROXY_PORT="$dev_proxy_port"
export PATH="\$JAVA_HOME/bin:$prefix/gradle/gradle-8.11.1/bin:\$ANDROID_HOME/platform-tools:\$PATH"
EOF

echo "==> done. Now run:  source $prefix/env.sh"
du -sh "$prefix" 2>/dev/null || true
