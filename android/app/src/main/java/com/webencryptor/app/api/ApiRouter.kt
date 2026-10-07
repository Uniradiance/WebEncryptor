/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.api

import com.webencryptor.app.data.ApiException
import com.webencryptor.app.data.DatabaseFile
import com.webencryptor.app.data.EntryCodec
import com.webencryptor.app.data.GoJson
import com.webencryptor.app.data.PasswordEntry
import com.webencryptor.app.data.PasswordStore
import com.webencryptor.app.data.VaultValidation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One bridge-transported API call: the parts of an HTTP request that matter here. */
class ApiRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
) {
    fun header(name: String): String? =
        headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/**
 * The response the web client sees. [body] is already the exact byte stream the
 * Go server would have written, including the trailing newline that
 * `json.NewEncoder(...).Encode` appends, so `password_service.js` cannot tell the
 * two implementations apart.
 */
class ApiResponse(val status: Int, val body: String) {
    val isEmpty: Boolean get() = body.isEmpty()
}

/**
 * Port of `apiHandler` in `server.go`.
 *
 * The routing table, status codes, error strings and even the id-space guard are
 * reproduced one-for-one. There is deliberately no token check: a single-device
 * app has no listening socket, so the `X-Auth-Token` path (and its 401 prompt)
 * is unreachable, which is exactly the security improvement route B buys.
 */
class ApiRouter(
    private val store: PasswordStore,
    private val log: (String) -> Unit = {},
) {

    fun handle(request: ApiRequest): ApiResponse = try {
        dispatch(request)
    } catch (error: ApiException) {
        errorResponse(error.status, error.message.orEmpty())
    }

    private fun dispatch(request: ApiRequest): ApiResponse {
        val path = request.path.trimEnd('/')
        val method = request.method.uppercase()

        if (path == "/api/passwords") {
            return when (method) {
                "GET" -> ApiResponse(200, json(GoJson.entriesToJson(store.transact { it.snapshot() })))
                "POST" -> create(request)
                else -> methodNotAllowed()
            }
        }

        if (path.startsWith("/api/passwords/")) {
            val id = path.removePrefix("/api/passwords/").toLongOrNull()
                ?: return errorResponse(404, "Not Found")
            return when (method) {
                "PUT" -> update(id, request)
                "DELETE" -> delete(id, request)
                else -> methodNotAllowed()
            }
        }

        if (path == "/api/shutdown" && method == "POST") {
            log("Shutdown requested (POST /api/shutdown).")
            return ApiResponse(200, json(JsonObject(mapOf("message" to JsonPrimitive("Server is shutting down...")))))
        }

        return errorResponse(404, "Not Found")
    }

    // ------------------------------------------------------------------
    // Handlers
    // ------------------------------------------------------------------

    private fun create(request: ApiRequest): ApiResponse {
        val update = EntryCodec.decodePasswordUpdate(request.body.orEmpty())
        return store.transact { session ->
            if (session.currentNextId >= VaultValidation.MAX_SAFE_INTEGER) {
                return@transact errorResponse(500, "Record ID space exhausted.")
            }
            var entry = PasswordEntry(id = session.currentNextId)
            update.name?.let { entry = entry.copy(name = it) }
            update.description?.let { entry = entry.copy(description = it) }
            update.password?.let { entry = entry.copy(password = it) }
            entry = VaultValidation.createVaultFields(entry, update, session.entries)
            val next = ArrayList(session.snapshot()).apply { add(entry) }
            session.commit(next)
            ApiResponse(201, json(GoJson.entryToJson(entry)))
        }
    }

    private fun update(id: Long, request: ApiRequest): ApiResponse {
        val update = EntryCodec.decodePasswordUpdate(request.body.orEmpty())
        return store.transact { session ->
            val next = ArrayList(session.snapshot())
            val index = next.indexOfFirst { it.id == id }
            if (index < 0) {
                return@transact errorResponse(404, "Password with id $id not found.")
            }
            var target = VaultValidation.updateVaultFields(next[index], update)
            update.name?.let { target = target.copy(name = it) }
            update.description?.let { target = target.copy(description = it) }
            update.password?.let { target = target.copy(password = it) }
            next[index] = target
            session.commit(next)
            ApiResponse(200, json(GoJson.entryToJson(target)))
        }
    }

    private fun delete(id: Long, request: ApiRequest): ApiResponse = store.transact { session ->
        val ifMatch = request.header("If-Match")
        for (entry in session.entries) {
            if (entry.id == id && entry.type == "vault" && ifMatch != "\"${entry.revision}\"") {
                return@transact errorResponse(
                    409,
                    "This vault changed in another session. Your draft is retained. " +
                        "Lock and reopen the vault before retrying.",
                )
            }
        }
        val filtered = session.entries.filterNot { it.id == id }
        if (filtered.size == session.entries.size) {
            return@transact errorResponse(404, "Password with id $id not found.")
        }
        session.commit(filtered)
        ApiResponse(204, "")
    }

    // ------------------------------------------------------------------
    // Response encoding (writeJSON / methodNotAllowed in server.go)
    // ------------------------------------------------------------------

    private fun json(element: kotlinx.serialization.json.JsonElement): String = GoJson.compact(element) + "\n"

    private fun errorResponse(status: Int, message: String): ApiResponse =
        ApiResponse(status, json(JsonObject(mapOf("error" to JsonPrimitive(message)))))

    private fun methodNotAllowed(): ApiResponse = errorResponse(405, "Method Not Allowed")

    /** Only used by the tests and by diagnostics. */
    internal fun databaseSummary(): DatabaseFile =
        store.transact { DatabaseFile(it.currentNextId, it.snapshot()) }
}
