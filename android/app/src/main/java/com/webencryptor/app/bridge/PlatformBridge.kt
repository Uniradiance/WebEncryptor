/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.bridge

import com.webencryptor.app.api.ApiRequest
import com.webencryptor.app.api.ApiRouter
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Clipboard side of the bridge, injected so the dispatcher is unit-testable. */
interface ClipboardPort {
    fun write(text: String, sensitive: Boolean)
    fun read(): String?
}

/** Backup export side of the bridge (SAF `CreateDocument` on Android). */
interface FileExportPort {
    /**
     * Writes [bytes] to a user-chosen location. [onResult] receives `null` on
     * success or the reason for the failure (including "cancelled"), and may be
     * invoked after [export] has returned.
     */
    fun export(name: String, mime: String, bytes: ByteArray, onResult: (Throwable?) -> Unit)
}

/**
 * Executes bridge requests for the WebView host.
 *
 * Requests run on a single background thread: that keeps file I/O and the
 * database mutex off the UI thread while preserving arrival order, which is what
 * an HTTP server would have given the web client for free (two rapid saves cannot
 * race). Every request produces exactly one reply, so a page promise can never
 * hang — a failure that is not a modelled API error still answers with `ok:false`.
 */
class PlatformBridge(
    private val router: ApiRouter,
    private val clipboard: ClipboardPort,
    private val fileExporter: FileExportPort,
    private val log: (String) -> Unit = {},
    private val onShutdownRequested: () -> Unit = {},
    private val onPageReady: (BridgeRequest.Ready) -> Unit = {},
) {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "webencryptor-bridge").apply { isDaemon = true }
    }

    /** Ids of requests the page abandoned (`AbortSignal`). */
    private val cancelled: MutableSet<Long> = ConcurrentHashMap.newKeySet()

    private val closed = AtomicBoolean(false)

    /**
     * Queues [request]; [reply] is invoked exactly once, from a background thread,
     * with the JSON reply document. It may be invoked after [submit] returned
     * (file export) and is never invoked for a cancelled request.
     */
    fun submit(request: BridgeRequest, reply: (String) -> Unit) {
        if (closed.get()) return
        executor.execute {
            if (closed.get()) return@execute
            val result = runCatching { handle(request, reply) }
                .getOrElse { error ->
                    log("Bridge request ${request.id} failed: ${error.javaClass.simpleName}: ${error.message}")
                    BridgeProtocol.errorReply(request.id, error.message ?: "bridge failure", 500)
                }
            if (result != null) answer(request.id, reply, result)
        }
    }

    /**
     * Synchronous entry point for the `@JavascriptInterface` fallback transport.
     * Returns the reply, or `null` when the reply will be delivered later through
     * [lateReply] (only file export behaves that way).
     */
    fun handleNow(request: BridgeRequest, lateReply: (String) -> Unit): String? =
        runCatching { handle(request, lateReply) }
            .getOrElse { error ->
                log("Bridge request ${request.id} failed: ${error.javaClass.simpleName}: ${error.message}")
                BridgeProtocol.errorReply(request.id, error.message ?: "bridge failure", 500)
            }

    fun cancel(id: Long) {
        cancelled.add(id)
        // Ids are monotonic per page load; a few thousand entries cover every
        // realistic number of in-flight requests.
        if (cancelled.size > 4096) cancelled.clear()
    }

    fun shutdown() {
        closed.set(true)
        executor.shutdownNow()
    }

    // ------------------------------------------------------------------

    private fun answer(id: Long, reply: (String) -> Unit, payload: String) {
        if (closed.get() || cancelled.remove(id)) return
        reply(payload)
    }

    private fun handle(request: BridgeRequest, reply: (String) -> Unit): String? {
        return when (request) {
            is BridgeRequest.Http -> {
                if (cancelled.remove(request.id)) return null
                val response = router.handle(
                    ApiRequest(
                        method = request.method,
                        path = request.path,
                        headers = request.headers,
                        body = request.body,
                    )
                )
                if (request.method.equals("POST", true) && request.path.trimEnd('/') == "/api/shutdown") {
                    onShutdownRequested()
                }
                BridgeProtocol.httpReply(request.id, response.status, response.body)
            }

            is BridgeRequest.ClipboardWrite -> {
                clipboard.write(request.text, request.sensitive)
                BridgeProtocol.okReply(request.id)
            }

            is BridgeRequest.ClipboardRead -> BridgeProtocol.clipboardReply(request.id, clipboard.read())

            is BridgeRequest.FileSave -> {
                val bytes = decodeBase64(request.base64)
                if (bytes == null) {
                    BridgeProtocol.errorReply(request.id, "the export payload was not valid base64")
                } else {
                    val id = request.id
                    val replyOnce = reply
                    fileExporter.export(request.name, request.mime, bytes) { failure ->
                        val payload = if (failure == null) {
                            BridgeProtocol.okReply(id)
                        } else {
                            BridgeProtocol.errorReply(id, failure.message ?: "export failed")
                        }
                        answer(id, replyOnce, payload)
                    }
                    null
                }
            }

            is BridgeRequest.Cancel -> {
                cancel(request.targetId)
                null
            }

            is BridgeRequest.Ready -> {
                log("Page bridge ready (platform=${request.platform}).")
                onPageReady(request)
                BridgeProtocol.okReply(request.id)
            }

            is BridgeRequest.Log -> {
                log("page: ${request.message}")
                BridgeProtocol.okReply(request.id)
            }

            is BridgeRequest.Unsupported -> BridgeProtocol.errorReply(
                request.id,
                "unsupported bridge operation: ${request.op}",
            )
        }
    }

    private fun decodeBase64(value: String): ByteArray? = try {
        Base64.getDecoder().decode(value.filterNot { it == '\n' || it == '\r' })
    } catch (_: IllegalArgumentException) {
        null
    }
}
