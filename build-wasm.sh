#!/usr/bin/env bash
# Build htdocs/recognition_wasm.wasm from rust/recognition (Rust -> wasm32).
#
# Requirements:
#   - cargo/rustc with the wasm32-unknown-unknown target installed
#     (rustup: `rustup target add wasm32-unknown-unknown`) plus wasm-ld
#     (bundled with rustc / Arch rust-wasm).
#   - Optional WE_RUST_SYSROOT=/path/to/sysroot when rust-std for wasm32 lives
#     in a custom sysroot (used by some distro setups).
set -euo pipefail
cd "$(dirname "$0")"

if [[ -n "${WE_RUST_SYSROOT:-}" ]]; then
  export RUSTFLAGS="--sysroot=${WE_RUST_SYSROOT}"
  echo "==> using sysroot: ${WE_RUST_SYSROOT}"
fi

cargo build --release --target wasm32-unknown-unknown \
  --manifest-path rust/recognition/Cargo.toml

cp rust/recognition/target/wasm32-unknown-unknown/release/recognition_wasm.wasm \
  htdocs/recognition_wasm.wasm
echo "==> htdocs/recognition_wasm.wasm ($(wc -c < htdocs/recognition_wasm.wasm | tr -d ' ') bytes)"
