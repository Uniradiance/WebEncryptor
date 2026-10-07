/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

import com.webencryptor.app.data.GoJson.strictLongOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One decoded API request body — the port of `passwordUpdate` in `server.go`.
 *
 * `null` means "the field was absent", which is exactly what the Go pointer
 * fields express. An explicit JSON `null` never reaches this class: Go rejects it
 * with a 400 and so does [EntryCodec.decodePasswordUpdate].
 */
data class PasswordUpdate(
    val name: String? = null,
    val description: String? = null,
    val password: String? = null,
    val type: String? = null,
    val vaultId: String? = null,
    val revision: Long? = null,
    /** `null` = absent, empty list = present but `[]` — Go's `*[]VaultChild`. */
    val children: List<VaultChild>? = null,
)

/** Raised when the on-disk database cannot be trusted; the file is never rewritten. */
class DatabaseFormatException(message: String) : Exception(message)

/**
 * Port of `decodePasswordUpdate` (request bodies) and of the `loadDB` document
 * decode from `server.go`.
 *
 * Field-by-field validation, error text and status codes follow the Go code so
 * that the web client sees identical behaviour. One deliberate difference is
 * documented: Go iterates a `map[string]json.RawMessage`, so when several fields
 * are invalid at once it reports an arbitrary one; this port reports the first
 * invalid field in document order, which is always an error Go could have
 * produced for the same request.
 */
object EntryCodec {

    private const val MAX_TYPE_BYTES = 16
    private const val MAX_VAULT_ID_BYTES = 36

    private val entryFields = setOf("id", "name", "description", "password", "type", "vaultId", "revision", "children")
    private val childFields = setOf("id", "name", "description", "password")

    // ------------------------------------------------------------------
    // Request bodies
    // ------------------------------------------------------------------

    fun decodePasswordUpdate(body: String): PasswordUpdate {
        if (VaultValidation.utf8Length(body) > VaultValidation.MAX_REQUEST_BYTES) {
            throw ApiException.TooLarge("Request exceeds the 32 MiB JSON limit.")
        }
        val fields = GoJson.parseObjectOrNull(body)
            ?: throw ApiException.BadRequest("Expected one JSON object.")

        var update = PasswordUpdate()
        for ((field, raw) in fields) {
            when (field) {
                "revision" -> {
                    val value = raw.strictLongOrNull()
                    if (value == null || value < 0 || value >= VaultValidation.MAX_SAFE_INTEGER) {
                        throw ApiException.BadRequest("revision must be a safe non-negative integer.")
                    }
                    update = update.copy(revision = value)
                }
                "children" -> {
                    val array = raw as? JsonArray
                        ?: throw ApiException.BadRequest(
                            "children must be an array of encrypted items without nested children."
                        )
                    val children = array.map { decodeChild(it) }
                    VaultValidation.validateChildren(children)
                    update = update.copy(children = children)
                }
                "type", "vaultId", "name", "description", "password" -> {
                    val limit = when (field) {
                        "type" -> MAX_TYPE_BYTES
                        "vaultId" -> MAX_VAULT_ID_BYTES
                        "name" -> VaultValidation.MAX_NAME_BYTES
                        "description" -> VaultValidation.MAX_DESCRIPTION_BYTES
                        else -> VaultValidation.MAX_PASSWORD_BYTES
                    }
                    val value = raw.asGoStringOrNull()
                        ?: throw ApiException.BadRequest("$field must be a string (null is not allowed).")
                    if (VaultValidation.utf8Length(value) > limit) {
                        throw ApiException.TooLarge("$field exceeds $limit UTF-8 bytes.")
                    }
                    update = when (field) {
                        "type" -> update.copy(type = value)
                        "vaultId" -> update.copy(vaultId = value)
                        "name" -> update.copy(name = value)
                        "description" -> update.copy(description = value)
                        else -> update.copy(password = value)
                    }
                }
                else -> throw ApiException.BadRequest("Unknown field: $field")
            }
        }
        return update
    }

    private fun decodeChild(element: JsonElement): VaultChild {
        val obj = element as? JsonObject ?: throw malformedChildren()
        if (obj.keys.any { it !in childFields }) throw malformedChildren()
        return VaultChild(
            id = obj.structString("id"),
            name = obj.structString("name"),
            description = obj.structString("description"),
            password = obj.structString("password"),
        )
    }

    private fun malformedChildren() = ApiException.BadRequest(
        "children must be an array of encrypted items without nested children."
    )

    // ------------------------------------------------------------------
    // Database document
    // ------------------------------------------------------------------

    /**
     * Parses `passwords.json` (and, on Android, the *unsealed* payload of
     * `passwords.json.enc`). Messages match `loadDB` in `server.go`, including
     * the "(original file preserved)" suffix, because they are shown to the user
     * when a database cannot be trusted.
     */
    fun parseDatabase(dbPath: String, text: String): DatabaseFile {
        val root = GoJson.parseObjectOrNull(text)
            ?: throw DatabaseFormatException(
                "cannot parse database $dbPath (original file preserved): not a single JSON object"
            )
        if (root.keys.any { it != "nextId" && it != "entries" }) {
            val unknown = root.keys.first { it != "nextId" && it != "entries" }
            throw DatabaseFormatException(
                "cannot parse database $dbPath (original file preserved): unknown field \"$unknown\""
            )
        }

        val nextId = root["nextId"]?.strictLongOrNull()
            ?: throw DatabaseFormatException("invalid database nextId or entries (original file preserved)")
        if (nextId < 1) {
            throw DatabaseFormatException("invalid database nextId or entries (original file preserved)")
        }
        val entriesElement = root["entries"]
            ?: throw DatabaseFormatException("invalid database nextId or entries (original file preserved)")
        val entriesArray = entriesElement as? JsonArray
            ?: throw DatabaseFormatException("invalid database nextId or entries (original file preserved)")

        val entries = entriesArray.map { element ->
            val obj = element as? JsonObject
                ?: throw DatabaseFormatException(
                    "cannot parse database $dbPath (original file preserved): entries must be objects"
                )
            parseEntry(obj)
        }

        val seen = HashSet<Long>(entries.size)
        val vaultIds = HashSet<String>()
        for (entry in entries) {
            try {
                VaultValidation.validateStoredEntry(entry)
            } catch (error: ApiException) {
                throw DatabaseFormatException(
                    "invalid record ${entry.id} (original file preserved): ${error.message}"
                )
            }
            if (entry.type == "vault" && !vaultIds.add(entry.vaultId)) {
                throw DatabaseFormatException("duplicate vault identifier (original file preserved)")
            }
            if (entry.id < 1 || entry.id >= VaultValidation.MAX_SAFE_INTEGER || !seen.add(entry.id)) {
                throw DatabaseFormatException(
                    "invalid or duplicate database ID ${entry.id} (original file preserved)"
                )
            }
            if (entry.id >= nextId) {
                throw DatabaseFormatException("database nextId must exceed all record IDs (original file preserved)")
            }
        }
        if (nextId > VaultValidation.MAX_SAFE_INTEGER) {
            throw DatabaseFormatException("database nextId exceeds the safe integer range (original file preserved)")
        }
        return DatabaseFile(nextId = nextId, entries = entries)
    }

    private fun parseEntry(obj: JsonObject): PasswordEntry {
        val unknown = obj.keys.firstOrNull { it !in entryFields }
        if (unknown != null) {
            throw DatabaseFormatException("cannot parse database (original file preserved): unknown field \"$unknown\"")
        }
        val children = when (val raw = obj["children"]) {
            null, is JsonNull -> null
            is JsonArray -> raw.map { decodeStoredChild(it) }
            else -> throw DatabaseFormatException("cannot parse database (original file preserved): invalid children")
        }
        return PasswordEntry(
            id = obj.structInteger("id"),
            name = obj.structString("name"),
            description = obj.structString("description"),
            password = obj.structString("password"),
            type = obj.structString("type"),
            vaultId = obj.structString("vaultId"),
            revision = obj.structInteger("revision"),
            children = children,
        )
    }

    /** Missing key or `null` means Go's zero value; anything non-integral fails. */
    private fun JsonObject.structInteger(key: String): Long {
        val raw = this[key] ?: return 0L
        if (raw is JsonNull) return 0L
        return raw.strictLongOrNull()
            ?: throw DatabaseFormatException(
                "cannot parse database (original file preserved): $key must be an integer"
            )
    }

    private fun decodeStoredChild(element: JsonElement): VaultChild {
        val obj = element as? JsonObject
            ?: throw DatabaseFormatException("cannot parse database (original file preserved): invalid child")
        if (obj.keys.any { it !in childFields }) {
            throw DatabaseFormatException("cannot parse database (original file preserved): unknown child field")
        }
        return VaultChild(
            id = obj.structString("id"),
            name = obj.structString("name"),
            description = obj.structString("description"),
            password = obj.structString("password"),
        )
    }

    /**
     * Go treats `null` for a struct string field as "leave the zero value", so a
     * missing key and an explicit null are both the empty string here. Any other
     * non-string value is a decode failure.
     */
    private fun JsonObject.structString(key: String): String {
        val raw = this[key] ?: return ""
        if (raw is JsonNull) return ""
        val primitive = raw as? JsonPrimitive
            ?: throw DatabaseFormatException("cannot parse database (original file preserved): $key must be a string")
        if (!primitive.isString) {
            throw DatabaseFormatException("cannot parse database (original file preserved): $key must be a string")
        }
        return primitive.content
    }

    /**
     * String field extraction for request bodies: `null` and every non-string
     * value are rejected, mirroring `json.Unmarshal(raw, &value) != nil` in
     * `decodePasswordUpdate`.
     */
    private fun JsonElement.asGoStringOrNull(): String? {
        val primitive = this as? JsonPrimitive ?: return null
        if (primitive is JsonNull || !primitive.isString) return null
        return primitive.content
    }
}
