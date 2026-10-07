/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app

/**
 * MIME types for the web assets shipped in the APK.
 *
 * `WebViewAssetLoader` guesses from the platform's MIME table, which is not
 * guaranteed to know `.mjs` or `.wasm` on older devices. Both matter:
 *  * an ES module served with the wrong type is **refused** by the renderer, which
 *    would break `import` of the vendored React modules;
 *  * `WebAssembly.instantiateStreaming` requires exactly `application/wasm`, and
 *    the page would silently fall back to its slower JavaScript recogniser.
 */
internal object AssetMime {

    fun forPath(path: String): String? = when (path.substringAfterLast('.', "").lowercase()) {
        "js", "mjs" -> "text/javascript"
        "wasm" -> "application/wasm"
        "json" -> "application/json"
        "webmanifest" -> "application/manifest+json"
        "css" -> "text/css"
        "html", "htm" -> "text/html"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "ico" -> "image/x-icon"
        else -> null
    }
}
