#!/usr/bin/env bash
#
# One-command build entry point for the Android port.
#
#   tools/ci-build.sh [assemble|clean]      (default: assemble)
#
# It provisions the toolchain if needed (tools/setup-toolchain.sh), keeps Gradle's
# caches and the build directory inside the scratch prefix so a small workspace
# partition is not a problem, then builds both APKs.
# Artifacts are copied to android/build-artifacts/.
#
# Environment:
#   WE_TOOLCHAIN      toolchain prefix        (default /tmp/webencryptor-toolchain)
#   WE_BUILD_ROOT     scratch build root      (default $WE_TOOLCHAIN/build)
#   WE_KEYSTORE_FILE  release signing keystore (optional; falls back to debug key)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
android_dir="$(cd "$here/.." && pwd)"
mode="${1:-assemble}"

prefix="${WE_TOOLCHAIN:-/tmp/webencryptor-toolchain}"
build_root="${WE_BUILD_ROOT:-$prefix/build}"
artifacts="$android_dir/build-artifacts"

if [ ! -f "$prefix/env.sh" ]; then
    echo "==> toolchain missing; provisioning it first"
    bash "$here/setup-toolchain.sh" "$prefix"
fi
# shellcheck disable=SC1091
source "$prefix/env.sh"

# On a SOCKS-only build host, setup-toolchain.sh points Gradle at
# tools/DevProxy.java (Gradle ignores socksProxyHost and would otherwise connect
# directly). Start it when the configured port is not listening; harmless elsewhere.
dev_proxy_port="${WE_DEV_PROXY_PORT:-}"
if [ -n "$dev_proxy_port" ] && ! (exec 3<>"/dev/tcp/127.0.0.1/$dev_proxy_port") 2>/dev/null; then
    proxy_url="${HTTPS_PROXY:-${ALL_PROXY:-}}"
    case "$proxy_url" in
        socks5://* | socks://*)
            proxy_hostport="${proxy_url#*://}"
            echo "==> starting tools/DevProxy.java on port $dev_proxy_port (via SOCKS $proxy_hostport)"
            nohup "$JAVA_HOME/bin/java" \
                -DsocksProxyHost="${proxy_hostport%%:*}" -DsocksProxyPort="${proxy_hostport##*:}" \
                "$here/DevProxy.java" "$dev_proxy_port" > "$prefix/dev-proxy.log" 2>&1 &
            for _ in $(seq 1 60); do
                if (exec 3<>"/dev/tcp/127.0.0.1/$dev_proxy_port") 2>/dev/null; then break; fi
                sleep 0.25
            done
            ;;
    esac
fi

echo "==> java  : $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
echo "==> sdk   : $ANDROID_HOME"
echo "==> build : $build_root"

gradle() {
    command gradle --project-dir "$android_dir" --console=plain -Pwe.buildRoot="$build_root" "$@"
}

run_assemble() {
    echo "==> assembling debug + release APKs"
    gradle assembleDebug assembleRelease
    mkdir -p "$artifacts"
    find "$build_root" -name '*.apk' -print -exec cp {} "$artifacts/" \;
    ls -la "$artifacts"
}

case "$mode" in
    assemble) run_assemble ;;
    clean)
        gradle clean
        rm -rf "$artifacts"
        ;;
    *)
        echo "unknown mode: $mode (expected assemble|clean)" >&2
        exit 2
        ;;
esac

echo "==> done ($mode)"
