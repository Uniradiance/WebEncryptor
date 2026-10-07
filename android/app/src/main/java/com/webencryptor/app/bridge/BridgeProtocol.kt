/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.bridge

import com.webencryptor.app.data.GoJson
import com.webencryptor.app.data.GoJson.strictLongOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The wire format spoken between the injected page shim
 * (`bridge-assets/webencryptor_platform_bridge.js`) and this process.
 *
 * It is intentionally a tiny, boring request/response protocol: one JSON object
 * per message, one optional reply per request id, no shared mutable state. The
 * shim turns `/api/...` fetches into [Http] requests, which is what lets the web
 * frontend stay byte-identical to the desktop build.
 */
sealed class BridgeRequest {
    abstract val id: Long

    data class Http(
        override val id: Long,
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String?,
    ) : BridgeRequest()

    data class ClipboardWrite(override val id: Long, val text: String, val sensitive: Boolean) : BridgeRequest()

    data class ClipboardRead(override val id: Long) : BridgeRequest()

    /** A blob download was intercepted; the bytes travel base64 encoded. */
    data class FileSave(
        override val id: Long,
        val name: String,
        val mime: String,
        val base64: String,
    ) : BridgeRequest()

    /** Best-effort abortion of an in-flight request (fetch `AbortSignal`). */
    data class Cancel(val targetId: Long) : BridgeRequest() {
        override val id: Long get() = targetId
    }

    data class Ready(override val id: Long, val userAgent: String?, val platform: String?) : BridgeRequest()

    data class Log(override val id: Long, val message: String) : BridgeRequest()

    data class Unsupported(override val id: Long, val op: String) : BridgeRequest()
}

object BridgeProtocol {

    private const val MAX_CLIPBOARD_CHARS = 1 shl 20

    /**
     * Parses one message. Returns `null` only when the payload is not a JSON
     * object at all; unknown operations come back as [BridgeRequest.Unsupported]
     * so the shim always gets an answer instead of hanging on a promise.
     */
    fun parse(message: String): BridgeRequest? {
        val root = GoJson.parseObjectOrNull(message) ?: return null
        val id = root["id"]?.strictLongOrNull() ?: 0L
        return when (val op = root.string("op")) {
            "http" -> BridgeRequest.Http(
                id = id,
                method = root.string("method") ?: "GET",
                path = root.string("path") ?: "/",
                headers = root.stringMap("headers"),
                body = root.string("body"),
            )
            "clipboard.write" -> BridgeRequest.ClipboardWrite(
                id = id,
                text = root.string("text").orEmpty().take(MAX_CLIPBOARD_CHARS),
                sensitive = root.boolean("sensitive") ?: true,
            )
            "clipboard.read" -> BridgeRequest.ClipboardRead(id)
            "file.save" -> BridgeRequest.FileSave(
                id = id,
                name = root.string("name") ?: "vault-backup.json",
                mime = root.string("mime") ?: "application/json",
                base64 = root.string("base64").orEmpty(),
            )
            "cancel" -> BridgeRequest.Cancel(root["targetId"]?.strictLongOrNull() ?: id)
            "app.ready" -> BridgeRequest.Ready(id, root.string("userAgent"), root.string("platform"))
            "app.log" -> BridgeRequest.Log(id, root.string("message").orEmpty())
            null -> BridgeRequest.Unsupported(id, "<missing>")
            else -> BridgeRequest.Unsupported(id, op)
        }
    }

    // ------------------------------------------------------------------
    // Replies
    // ------------------------------------------------------------------

    fun httpReply(id: Long, status: Int, body: String): String {
        val payload = JsonObject(
            linkedMapOf(
                "id" to JsonPrimitive(id),
                "ok" to JsonPrimitive(true),
                "status" to JsonPrimitive(status),
                "body" to JsonPrimitive(body),
                "headers" to JsonObject(
                    linkedMapOf(
                        "Content-Type" to JsonPrimitive("application/json; charset=utf-8"),
                        "Cache-Control" to JsonPrimitive("no-store"),
                    )
                ),
            )
        )
        return GoJson.compact(payload)
    }

    fun clipboardReply(id: Long, text: String?): String = GoJson.compact(
        JsonObject(
            linkedMapOf(
                "id" to JsonPrimitive(id),
                "ok" to JsonPrimitive(true),
                "text" to (text?.let { JsonPrimitive(it) } ?: JsonNull),
            )
        )
    )

    fun okReply(id: Long): String =
        GoJson.compact(JsonObject(linkedMapOf("id" to JsonPrimitive(id), "ok" to JsonPrimitive(true))))

    fun errorReply(id: Long, message: String, status: Int? = null): String {
        val map = linkedMapOf<String, JsonElement>(
            "id" to JsonPrimitive(id),
            "ok" to JsonPrimitive(false),
            "error" to JsonPrimitive(message),
        )
        if (status != null) map["status"] = JsonPrimitive(status)
        return GoJson.compact(JsonObject(map))
    }

    /**
     * An `evaluateJavascript` expression that hands [reply] to the page. Used by
     * the `@JavascriptInterface` fallback, where a reply can arrive after the
     * synchronous call has already returned.
     */
    fun deliverExpression(reply: String): String = "window.__WE_DELIVER__(" + quote(reply) + ")"

    /** Minimal, strict JavaScript string literal quoting. */
    internal fun quote(value: String): String {
        val sb = StringBuilder(value.length + 16)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\u2028' -> sb.append("\\u2028")
                '\u2029' -> sb.append("\\u2029")
                '<' -> sb.append("\\u003c")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    // ------------------------------------------------------------------
    // Field helpers
    // ------------------------------------------------------------------

    private fun JsonObject.string(key: String): String? {
        val raw = this[key] ?: return null
        if (raw is JsonNull) return null
        val primitive = raw as? JsonPrimitive ?: return null
        if (!primitive.isString) return null
        return primitive.content
    }

    private fun JsonObject.boolean(key: String): Boolean? {
        val primitive = this[key] as? JsonPrimitive ?: return null
        if (primitive.isString) return null
        return when (primitive.content) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

    private fun JsonObject.stringMap(key: String): Map<String, String> {
        val obj = this[key] as? JsonObject ?: return emptyMap()
        val out = LinkedHashMap<String, String>(obj.size)
        for ((name, value) in obj) {
            val primitive = value as? JsonPrimitive ?: continue
            if (primitive is JsonNull || !primitive.isString) continue
            out[name] = primitive.content
        }
        return out
    }
}
