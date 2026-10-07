/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

import com.webencryptor.app.data.GoJson.strictLongOrNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64

/**
 * Port of `vault.go` from the desktop server.
 *
 * Every limit, message and ordering rule is reproduced deliberately: the web
 * frontend inspects both status codes and message fragments (for example
 * `vault_manager.js` matches `already exists` to explain a refused restore), and
 * a vault written by the desktop server has to be accepted here bit for bit.
 * Where Go measures `len(string)` — UTF-8 bytes, not characters — this port
 * measures UTF-8 bytes too.
 */
object VaultValidation {

    const val MAX_VAULT_CHILDREN = 1000
    const val MAX_VAULT_ITEM_BYTES = 64 * 1024
    const val MAX_VAULT_ITEM_CIPHERTEXT = 4 * ((MAX_VAULT_ITEM_BYTES + 16 + 2) / 3) + 39 // 87443
    const val MAX_VAULT_BYTES = 24 * 1024 * 1024

    const val MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024
    const val MAX_PASSWORD_BYTES = 4 * ((MAX_PLAINTEXT_BYTES + 2) / 3) + 71 // 5592479
    const val MAX_NAME_BYTES = 4096
    const val MAX_DESCRIPTION_BYTES = 65536
    const val MAX_REQUEST_BYTES = 32 * 1024 * 1024

    const val MAX_SAFE_INTEGER = 1L shl 53

    private val uuidPattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    private val canonicalBase64 =
        Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

    /** `strings.Split` semantics, including trailing empty fields. */
    internal fun splitAll(value: String, delimiter: Char): List<String> {
        val parts = ArrayList<String>(4)
        var start = 0
        for (index in value.indices) {
            if (value[index] == delimiter) {
                parts.add(value.substring(start, index))
                start = index + 1
            }
        }
        parts.add(value.substring(start))
        return parts
    }

    internal fun utf8Length(value: String): Int = value.toByteArray(Charsets.UTF_8).size

    /**
     * `decodeBase64` in `vault.go`: standard alphabet, correct padding, canonical
     * trailing bits (enforced by re-encoding and comparing).
     */
    fun decodeCanonicalBase64OrNull(value: String): ByteArray? {
        if (!canonicalBase64.matches(value)) return null
        val decoded = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return if (Base64.getEncoder().encodeToString(decoded) == value) decoded else null
    }

    /** `validateWrappedKey`: the `WVK1` envelope's structural and KDF checks. */
    fun validateWrappedKey(value: String, vaultId: String) {
        if (value.length > 2048) throw ApiException.BadRequest("encrypted vault key is too large")
        val parts = splitAll(value, '.')
        if (parts.size != 5 || parts[0] != "WVK1") {
            throw ApiException.BadRequest("expected a WVK1 encrypted vault key")
        }
        val headerBytes = decodeCanonicalBase64OrNull(parts[1])
            ?: throw ApiException.BadRequest("invalid canonical Base64")
        val header = GoJson.parseObjectOrNull(String(headerBytes, Charsets.UTF_8))
            ?: throw ApiException.BadRequest("invalid or unsupported vault key parameters")
        val allowed = setOf("v", "vaultId", "kdf", "ops", "mem", "factors")
        if (header.keys.any { it !in allowed }) {
            throw ApiException.BadRequest("invalid or unsupported vault key parameters")
        }
        fun jsonString(key: String): String? =
            (header[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        val version = header["v"]?.strictLongOrNull()
        val countedVaultId = jsonString("vaultId")
        val kdf = jsonString("kdf")
        val ops = header["ops"]?.strictLongOrNull()
        val mem = header["mem"]?.strictLongOrNull()
        val factors = header["factors"]?.strictLongOrNull()
        if (version != 1L || countedVaultId != vaultId || kdf != "argon2id" ||
            ops != 3L || mem != 268435456L || factors != 2L
        ) {
            throw ApiException.BadRequest("invalid or unsupported vault key parameters")
        }
        val sizes = intArrayOf(16, 24, 48)
        for (index in sizes.indices) {
            val decoded = decodeCanonicalBase64OrNull(parts[index + 2])
            if (decoded == null || decoded.size != sizes[index]) {
                throw ApiException.BadRequest("invalid vault key envelope lengths")
            }
        }
    }

    /** Check newly supplied text records; legacy files remain readable. */
    fun validateTextCiphertext(value: String) {
        if (value.isEmpty()) return
        val parts = splitAll(value, '.')
        if (value.length > MAX_PASSWORD_BYTES || parts.size != 5 || parts[0] != "WE2") {
            throw ApiException.BadRequest("expected a WE2 ciphertext, not plaintext")
        }
        for ((index, size) in intArrayOf(16, 12, -1, 16).withIndex()) {
            val bytes = decodeCanonicalBase64OrNull(parts[index + 1])
            if (bytes == null || (size >= 0 && bytes.size != size) ||
                (size < 0 && (bytes.isEmpty() || bytes.size > MAX_PLAINTEXT_BYTES))) {
                throw ApiException.BadRequest("invalid ciphertext field lengths or Base64")
            }
        }
    }

    /** `validateChildren`: encrypted items only, no plaintext names, no nesting. */
    fun validateChildren(children: List<VaultChild>) {
        if (children.size > MAX_VAULT_CHILDREN) {
            throw ApiException.BadRequest("a vault supports at most $MAX_VAULT_CHILDREN items")
        }
        val seen = HashSet<String>(children.size)
        for (child in children) {
            if (!uuidPattern.matches(child.id) || !seen.add(child.id)) {
                throw ApiException.BadRequest("invalid or duplicate child UUID")
            }
            if (child.name.isNotEmpty() || child.description.isNotEmpty()) {
                throw ApiException.BadRequest("child names and descriptions must be inside the ciphertext")
            }
            val parts = splitAll(child.password, '.')
            if (child.password.length > MAX_VAULT_ITEM_CIPHERTEXT || parts.size != 3 || parts[0] != "WVI1") {
                throw ApiException.BadRequest("invalid encrypted vault item")
            }
            val nonce = decodeCanonicalBase64OrNull(parts[1])
            if (nonce == null || nonce.size != 24) {
                throw ApiException.BadRequest("invalid item nonce")
            }
            val ciphertext = decodeCanonicalBase64OrNull(parts[2])
            if (ciphertext == null || ciphertext.size <= 16 || ciphertext.size > MAX_VAULT_ITEM_BYTES + 16) {
                throw ApiException.BadRequest("invalid item ciphertext length")
            }
        }
    }

    /** `validateStoredEntry`: what may be persisted, as opposed to what may arrive. */
    fun validateStoredEntry(entry: PasswordEntry) {
        if (utf8Length(entry.name) > MAX_NAME_BYTES ||
            utf8Length(entry.description) > MAX_DESCRIPTION_BYTES ||
            utf8Length(entry.password) > MAX_PASSWORD_BYTES
        ) {
            throw ApiException.BadRequest("record exceeds field limits")
        }
        if (entry.type.isEmpty() || entry.type == "text") {
            if (entry.vaultId.isNotEmpty() || entry.revision != 0L || entry.children != null) {
                throw ApiException.BadRequest("ordinary records cannot have vault fields")
            }
            return
        }
        if (entry.type != "vault" || !uuidPattern.matches(entry.vaultId) ||
            entry.revision < 1 || entry.revision >= MAX_SAFE_INTEGER
        ) {
            throw ApiException.BadRequest("invalid vault type, identifier or revision")
        }
        if (entry.name.trim().isEmpty()) {
            throw ApiException.BadRequest("vault name cannot be empty")
        }
        validateWrappedKey(entry.password, entry.vaultId)
        validateChildren(entry.children ?: emptyList())
        if (GoJson.compactByteLength(GoJson.entryToJson(entry)) > MAX_VAULT_BYTES) {
            throw ApiException.BadRequest("vault exceeds the 24 MiB limit")
        }
    }

    /**
     * `createVaultFields`: builds the record to insert, or validates a plain
     * record. Returns the entry that should be appended to the database.
     */
    fun createVaultFields(entry: PasswordEntry, update: PasswordUpdate, entries: List<PasswordEntry>): PasswordEntry {
        var candidate = entry
        update.type?.let { candidate = candidate.copy(type = it) }
        if (candidate.type != "vault") {
            if (update.vaultId != null || update.children != null || update.revision != null) {
                throw ApiException.BadRequest("vault fields require type vault")
            }
            validateStoredEntry(candidate)
            validateTextCiphertext(candidate.password)
            return candidate
        }
        if (update.vaultId == null || update.children == null || update.password == null ||
            (update.revision != null && update.revision != 0L)
        ) {
            throw ApiException.BadRequest(
                "new vault requires vaultId, encrypted key, children and revision 0"
            )
        }
        candidate = candidate.copy(
            vaultId = update.vaultId,
            revision = 1,
            children = ArrayList(update.children),
        )
        for (existing in entries) {
            if (existing.vaultId == candidate.vaultId) {
                throw ApiException.BadRequest("vault identifier already exists; refresh before retrying creation")
            }
        }
        validateStoredEntry(candidate)
        return candidate
    }

    /**
     * `updateVaultFields`: returns the replacement record. Plain records only
     * have their label fields replaced by the caller; vaults are rewritten whole
     * and their revision is bumped.
     */
    fun updateVaultFields(current: PasswordEntry, update: PasswordUpdate): PasswordEntry {
        if (current.type != "vault") {
            if (update.vaultId != null || update.children != null || update.revision != null ||
                (update.type != null && update.type != current.type)
            ) {
                throw ApiException.BadRequest("record type cannot change; create a new vault")
            }
            update.password?.let { validateTextCiphertext(it) }
            return current
        }
        if (update.revision == null || update.revision != current.revision) {
            throw VaultConflictException()
        }
        if (current.revision >= MAX_SAFE_INTEGER - 1) {
            throw ApiException.BadRequest("vault revision space exhausted")
        }
        if (update.type != "vault" || update.vaultId != current.vaultId || update.children == null ||
            update.password == null || update.name == null || update.description == null
        ) {
            throw ApiException.BadRequest(
                "vault updates must contain the complete vault with an unchanged identifier"
            )
        }
        val candidate = current.copy(
            name = update.name,
            description = update.description,
            password = update.password,
            children = ArrayList(update.children),
            revision = current.revision + 1,
        )
        validateStoredEntry(candidate)
        return candidate
    }
}
