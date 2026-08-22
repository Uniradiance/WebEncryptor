#!/usr/bin/env bash
# 交叉编译 WebEncryptor 单文件服务器到多个平台。
# 产物输出到 dist/ 目录。纯 Go 标准库，无需 CGO。
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist

# 目标平台列表: "GOOS/GOARCH"
targets=(
  "windows/amd64"
  "windows/arm64"
  "linux/amd64"
  "linux/arm64"
  "linux/arm"
  "darwin/amd64"
  "darwin/arm64"
)

for t in "${targets[@]}"; do
  goos="${t%/*}"
  goarch="${t#*/}"
  suffix=""
  goarm=""
  [ "$goos" = "windows" ] && suffix=".exe"
  [ "$goos" = "linux" ] && [ "$goarch" = "arm" ] && goarm="7"
  out="dist/webencryptor-${goos}-${goarch}${suffix}"
  [ "$goos" = "linux" ] && [ "$goarch" = "arm" ] && out="dist/webencryptor-linux-armv7"
  echo "==> ${goos}/${goarch} (GOARM=${goarm:-default}) -> ${out}"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" GOARM="$goarm" \
    go build -trimpath -ldflags "-s -w" -o "$out" .
done

# Windows 静默版 (无控制台窗口, 双击即用, 日志不可见)
echo "==> windows/amd64 (silent) -> dist/webencryptor-windows-amd64-silent.exe"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w -H=windowsgui" -o dist/webencryptor-windows-amd64-silent.exe .

echo
echo "构建完成:"
ls -lh dist/
