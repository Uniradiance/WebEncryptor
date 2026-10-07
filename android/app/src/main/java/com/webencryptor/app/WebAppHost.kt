/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewDatabase
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.webencryptor.app.bridge.BridgeProtocol
import com.webencryptor.app.bridge.PlatformBridge
import com.webencryptor.app.data.GoJson
import com.webencryptor.app.ui.FileExchange
import com.webencryptor.app.ui.JsDialogHandler
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayInputStream

/** The result of routing the system back action through the page. */
data class BackDecision(val handled: Boolean, val dirty: Boolean, val step: String)

/**
 * The WebView host.
 *
 * Two things here are security-relevant rather than cosmetic:
 *
 *  1. **Secure context.** The app is served from
 *     `https://appassets.androidplatform.net/assets/` through
 *     [WebViewAssetLoader] instead of `file://`. That is what makes ES modules,
 *     import maps, dedicated Workers, WebAssembly and `crypto.subtle` work at all,
 *     and it removes `setAllowFileAccess` from the equation entirely.
 *  2. **No other origin can load.** `shouldInterceptRequest` answers only for the
 *     asset domain and refuses everything else with 403; navigation away is
 *     blocked in `shouldOverrideUrlLoading`. Combined with the missing INTERNET
 *     permission, "offline" becomes a property of the platform rather than a
 *     promise in the source code.
 *
 * Both of those depend on the clients below actually being installed on the
 * WebView. Without a [WebViewClient] the WebView tries to fetch the asset URL over
 * the network, and because the app has no INTERNET permission the page fails with
 * `net::ERR_CACHE_MISS` instead of rendering. Since Kotlin initialises properties in
 * declaration order, the clients are declared **before** [webView] and
 * [buildWebView] re-checks them; see the comment there.
 */
class WebAppHost(
    private val activity: AppCompatActivity,
    private val bridge: PlatformBridge,
    private val fileExchange: FileExchange,
    private val dialogs: JsDialogHandler,
    private val log: (String) -> Unit,
    private val onRenderProcessGone: (String) -> Unit,
    private val onLoadError: (String) -> Unit = {},
) {

    private val assetLoader: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(DOMAIN)
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(activity))
        .build()

    // ------------------------------------------------------------------
    // Clients
    //
    // Declared before `webView`: `buildWebView()` installs both of them while the
    // instance is still being constructed, and a property read before its
    // initialiser has run yields null.
    // ------------------------------------------------------------------

    private val assetClient = object : WebViewClient() {

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url ?: return null
            val scheme = url.scheme ?: return null
            if (scheme != "https" && scheme != "http") return null // data:, blob:, about:
            if (url.host != DOMAIN) {
                log("Blocked a request to ${url.host ?: url.toString()}")
                return forbidden()
            }
            val path = url.path.orEmpty()
            val response = try {
                assetLoader.shouldInterceptRequest(url)
            } catch (error: Throwable) {
                log("Asset load failed for $path: ${error.message}")
                null
            }
            if (response != null) return withCorrectMime(path, response)
            if (path.startsWith("/api/")) {
                // Reaching this point means the shim did not install: say so
                // instead of pretending the endpoint does not exist.
                return textResponse(501, "the page bridge is not installed")
            }
            log("Asset not found: $path")
            return textResponse(404, "not found")
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url ?: return true
            if (url.host == DOMAIN && url.path.orEmpty().startsWith("/assets/")) return false
            log("Blocked navigation to ${url.host ?: url.toString()}")
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val reason = if (detail.didCrash()) "crashed" else "was killed by the system"
            log("WebView renderer $reason")
            onRenderProcessGone(reason)
            return true // handled: the host rebuilds the WebView
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val description = "${error.errorCode} ${error.description}"
            log("Main frame failed to load: $description")
            onLoadError(description)
        }
    }

    private val chromeClient = object : WebChromeClient() {

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean =
            dialogs.onAlert(message.orEmpty(), result)

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean =
            dialogs.onConfirm(message.orEmpty(), result)

        override fun onJsPrompt(
            view: WebView,
            url: String?,
            message: String?,
            defaultValue: String?,
            result: android.webkit.JsPromptResult,
        ): Boolean = dialogs.onPrompt(message.orEmpty(), defaultValue.orEmpty(), result)

        override fun onShowFileChooser(
            view: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean = fileExchange.showFileChooser(filePathCallback, fileChooserParams)

        override fun onPermissionRequest(request: PermissionRequest) {
            // No camera, microphone or protected media is ever needed.
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) {
                log("console: ${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
            }
            return true
        }
    }

    private var javascriptInterface: JavascriptFallback? = null

    // ------------------------------------------------------------------
    // Feature gate
    // ------------------------------------------------------------------

    data class SupportReport(
        val versionName: String?,
        val majorVersion: Int?,
        val documentStartSupported: Boolean,
        val messageListenerSupported: Boolean,
    ) {
        /** Import maps and document-start scripts both need Chrome/WebView 89. */
        val supported: Boolean get() = documentStartSupported
    }

    fun supportReport(): SupportReport {
        val packageInfo = try {
            WebViewCompat.getCurrentWebViewPackage(activity)
        } catch (_: Throwable) {
            null
        }
        val versionName = packageInfo?.versionName
        return SupportReport(
            versionName = versionName,
            majorVersion = versionName?.substringBefore('.')?.toIntOrNull(),
            documentStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT),
            messageListenerSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
        )
    }

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    /**
     * Created only after [assetClient] and [chromeClient] exist: property
     * initialisers run in declaration order and [buildWebView] installs both of
     * them.
     */
    var webView: WebView = buildWebView()
        private set

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    private fun buildWebView(): WebView {
        val view = WebView(activity)
        view.isSaveEnabled = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            view.importantForContentCapture = View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
        }
        WebViewDatabase.getInstance(activity).clearFormData()
        view.clearFormData()
        view.setBackgroundColor(Color.parseColor("#F4F7F9"))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            saveFormData = false
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            // The frontend has no dark palette (index.css declares
            // `color-scheme: light`), so algorithmic darkening is switched off
            // rather than letting the platform re-tint an interface it does not own.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                try {
                    WebSettingsCompat.setAlgorithmicDarkeningAllowed(this, false)
                } catch (_: Throwable) {
                    // Not fatal: without the feature the platform does not darken.
                }
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // Without a WebViewClient the WebView would fetch this URL over the network,
        // and since the app has no INTERNET permission by design the page would die
        // with net::ERR_CACHE_MISS. `requireNotNull` turns a future reordering of the
        // declarations into an immediate, explicit failure instead of that.
        view.webViewClient = requireNotNull(assetClient) { "assetClient must be declared before webView" }
        view.webChromeClient = requireNotNull(chromeClient) { "chromeClient must be declared before webView" }
        return view
    }

    /**
     * Installs the page shim and the request channel. Must run before [load].
     * Returns false when the WebView is too old, in which case the host explains
     * the problem instead of showing a blank page.
     */
    fun install(): Boolean {
        val report = supportReport()
        log(
            "WebView ${report.versionName ?: "unknown"} " +
                "(documentStart=${report.documentStartSupported}, messageListener=${report.messageListenerSupported})"
        )
        if (!report.documentStartSupported) return false
        check(webView.webViewClient === assetClient) { "the asset WebViewClient is not installed" }
        check(webView.webChromeClient === chromeClient) { "the WebChromeClient is not installed" }

        WebViewCompat.addDocumentStartJavaScript(webView, readShim(), setOf("https://$DOMAIN"))

        if (report.messageListenerSupported) {
            WebViewCompat.addWebMessageListener(webView, BRIDGE_OBJECT, setOf("https://$DOMAIN")) { _, message, _, isMainFrame, reply ->
                if (!isMainFrame) return@addWebMessageListener
                val payload = message.data ?: return@addWebMessageListener
                val request = BridgeProtocol.parse(payload)
                if (request == null) {
                    postReply(reply, BridgeProtocol.errorReply(0, "malformed bridge message"))
                    return@addWebMessageListener
                }
                bridge.submit(request) { answer -> postReply(reply, answer) }
            }
        } else {
            // WebView < 88: fall back to a JavaScript interface. Safe here because
            // the only content that can ever run is the APK's own assets.
            val fallback = JavascriptFallback(bridge) { reply ->
                activity.runOnUiThread {
                    try {
                        webView.evaluateJavascript(BridgeProtocol.deliverExpression(reply), null)
                    } catch (_: Throwable) {
                        // The page is gone; the promise dies with it.
                    }
                }
            }
            javascriptInterface = fallback
            webView.addJavascriptInterface(fallback, NATIVE_OBJECT)
            log("Using the @JavascriptInterface fallback transport.")
        }
        return true
    }

    fun load() {
        webView.loadUrl(ENTRY_URL)
    }

    fun reload() {
        webView.loadUrl(ENTRY_URL)
    }

    /**
     * Rebuilds the WebView after the renderer was killed. The three-factor unlock
     * runs a 256 MiB Argon2id derivation inside the renderer, which is exactly the
     * situation where Android's low-memory killer steps in on a small device; the
     * app must recover instead of dying with it.
     */
    fun recreate(): WebView {
        val previous = webView
        try {
            (previous.parent as? ViewGroup)?.removeView(previous)
            previous.destroy()
        } catch (_: Throwable) {
            // best effort
        }
        javascriptInterface = null
        webView = buildWebView()
        return webView
    }

    fun destroy() {
        javascriptInterface = null
        try {
            webView.removeJavascriptInterface(NATIVE_OBJECT)
        } catch (_: Throwable) {
            // ignore
        }
        try {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        } catch (_: Throwable) {
            // ignore
        }
    }

    // ------------------------------------------------------------------
    // Host -> page lifecycle calls
    // ------------------------------------------------------------------

    /** `window.__WE_APP__.lock()`: the page's own `pagehide` handler locks the vault. */
    fun lockVault() {
        evaluate("(window.__WE_APP__ && window.__WE_APP__.lock) ? (window.__WE_APP__.lock(), true) : false")
    }

    /**
     * Routes the back gesture through the page: app menu, overlay, open
     * `<details>`, account editor, unlock form, then the first workspace tab —
     * mirroring the page's own Escape handling. `handled == false` means the host
     * should ask the user whether to close the app.
     */
    fun requestBack(callback: (BackDecision) -> Unit) {
        val script = "(window.__WE_APP__ && window.__WE_APP__.handleBack) ? window.__WE_APP__.handleBack() : null"
        try {
            webView.evaluateJavascript(script) { value ->
                val parsed = GoJson.parseObjectOrNull(value ?: "")
                callback(
                    BackDecision(
                        handled = parsed?.flag("handled") == true,
                        dirty = parsed?.flag("dirty") == true,
                        step = parsed?.string("step").orEmpty(),
                    )
                )
            }
        } catch (_: Throwable) {
            callback(BackDecision(handled = false, dirty = false, step = "unavailable"))
        }
    }

    private fun evaluate(script: String) {
        try {
            webView.evaluateJavascript(script, null)
        } catch (_: Throwable) {
            // The WebView may already be gone.
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private fun postReply(replyProxy: JavaScriptReplyProxy, payload: String) {
        activity.runOnUiThread {
            try {
                replyProxy.postMessage(payload)
            } catch (_: Throwable) {
                // The page navigated away while the request was in flight.
            }
        }
    }

    private fun readShim(): String =
        activity.assets.open(SHIM_ASSET).use { it.readBytes().toString(Charsets.UTF_8) }

    private fun forbidden(): WebResourceResponse = textResponse(403, "forbidden")

    private fun textResponse(status: Int, message: String): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "utf-8",
        status,
        if (status == 403) "Forbidden" else "Error",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(message.toByteArray(Charsets.UTF_8)),
    )

    /**
     * `WebViewAssetLoader` derives the MIME type from the platform MIME table, which
     * is not guaranteed to know `.wasm` or `.mjs`. ES module scripts are rejected
     * outright when the MIME type is wrong, and `WebAssembly.instantiateStreaming`
     * requires exactly `application/wasm` (the page would silently fall back to its
     * slower JavaScript recogniser), so the load-bearing types are pinned here.
     *
     * `internal` rather than private so `WebAppHostWiringTest` can exercise it: the
     * Robolectric shadow does not model the status code of a response built by
     * `AssetsPathHandler`, so this path cannot be reached through the client there.
     */
    internal fun withCorrectMime(path: String, response: WebResourceResponse): WebResourceResponse {
        val expected = AssetMime.forPath(path) ?: return response
        if (response.mimeType.equals(expected, ignoreCase = true)) return response
        val status = response.statusCode
        if (status < 100) return response
        return WebResourceResponse(
            expected,
            response.encoding ?: "utf-8",
            status,
            response.reasonPhrase ?: "OK",
            response.responseHeaders ?: emptyMap(),
            response.data,
        )
    }

    companion object {
        const val DOMAIN = "appassets.androidplatform.net"

        /** The same entry point the desktop server opens; htdocs/ is the assets root. */
        const val ENTRY_URL = "https://$DOMAIN/assets/index.html"

        const val SHIM_ASSET = "webencryptor_platform_bridge.js"
        const val BRIDGE_OBJECT = "weBridge"
        const val NATIVE_OBJECT = "__WE_NATIVE__"

        /** Import maps and document-start scripts both need Chrome/WebView 89. */
        const val MIN_WEBVIEW_MAJOR = 89
    }
}

/**
 * `@JavascriptInterface` fallback for WebView builds without
 * `WEB_MESSAGE_LISTENER`. Every call is in-process (the WebView runs inside this
 * app) and the only content that can run is the APK's own assets, so this is not a
 * remote attack surface; it is used only when the modern transport is missing.
 */
class JavascriptFallback(
    private val bridge: PlatformBridge,
    private val deliver: (String) -> Unit,
) {
    @JavascriptInterface
    fun call(json: String): String {
        val request = BridgeProtocol.parse(json)
            ?: return BridgeProtocol.errorReply(0, "malformed bridge message")
        return bridge.handleNow(request, deliver).orEmpty()
    }
}

// ---------------------------------------------------------------------------
// Small JSON readers shared by the host
// ---------------------------------------------------------------------------

private fun JsonObject.flag(key: String): Boolean? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    return when (primitive.content) {
        "true" -> true
        "false" -> false
        else -> null
    }
}

private fun JsonObject.string(key: String): String? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else null
}
