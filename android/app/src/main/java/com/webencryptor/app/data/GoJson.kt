/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Serialises [JsonElement] trees exactly the way Go's `encoding/json` does.
 *
 * Why not use a JSON library's own writer? Because acceptance criterion #1 of the
 * port is format compatibility: an Android-written `passwords.json` (once
 * unsealed) and an Android API response must be byte-identical to what
 * `server.go` produces, so a database or export can move between the desktop and
 * the phone without any conversion step. Two Go-specific behaviours have to be
 * reproduced:
 *
 *  * [compact] mirrors `json.Marshal` / `json.Encoder`: no insignificant
 *    whitespace, `:` without a following space, and **HTML escaping enabled**
 *    (`<`, `>`, `&` become `\u003c`, `\u003e`, `\u0026`, and U+2028/U+2029 are
 *    escaped too).
 *  * [indented] mirrors `json.MarshalIndent` with a four-space indent: an empty
 *    object/array stays on one line (`{}` / `[]`), while every element of a
 *    non-empty container goes on its own line with a `": "` separator.
 *
 * Control characters follow Go's table: only `\n`, `\r`, `\t`, `\\` and `\"`
 * have short forms, everything else below U+0020 is `\u00xx` in lower-case hex.
 *
 * Parsing is delegated to kotlinx-serialization ([parseObject]); only writing is
 * hand-rolled.
 */
object GoJson {

    /** Shared strict parser: no comments, no trailing commas, EOF checked. */
    @OptIn(ExperimentalSerializationApi::class)
    val parser: Json = Json {
        isLenient = false
        allowTrailingComma = false
        allowSpecialFloatingPointValues = false
        ignoreUnknownKeys = false
        explicitNulls = true
    }

    // ------------------------------------------------------------------
    // Parsing
    // ------------------------------------------------------------------

    /**
     * Parses [text] as a single JSON object. Returns `null` when the text is not
     * exactly one JSON object; the caller turns that into the same 400 the Go
     * server produces (`Expected one JSON object.`).
     *
     * `Json.parseToJsonElement` rejects trailing content (`expectEof`) and runs
     * with the strict configuration above, matching Go's `json.Unmarshal`.
     */
    fun parseObjectOrNull(text: String): JsonObject? = try {
        parser.parseToJsonElement(text) as? JsonObject
    } catch (_: Throwable) {
        null
    }

    private val integerLiteral = Regex("^-?(?:0|[1-9][0-9]*)$")

    /**
     * Integer extraction with Go's rules: JSON strings are rejected even when
     * they look numeric, and only plain integer literals are accepted (`1e2` and
     * `1.0` fail to unmarshal into a Go `int`/`uint64`). Returns `null` for
     * anything Go would refuse.
     */
    fun JsonElement.strictLongOrNull(): Long? {
        val primitive = this as? JsonPrimitive ?: return null
        if (primitive.isString) return null
        val text = primitive.content
        if (!integerLiteral.matches(text)) return null
        return text.toLongOrNull()
    }

    // ------------------------------------------------------------------
    // Writing
    // ------------------------------------------------------------------

    fun compact(element: JsonElement): String = StringBuilder().also { writeCompact(it, element) }.toString()

    /** `json.Marshal` byte length, used by the 24 MiB vault limit in `vault.go`. */
    fun compactByteLength(element: JsonElement): Int = compact(element).toByteArray(Charsets.UTF_8).size

    fun indented(element: JsonElement, indentUnit: String = "    "): String =
        StringBuilder().also { writeIndented(it, element, 0, indentUnit) }.toString()

    private fun writeCompact(sb: StringBuilder, element: JsonElement) {
        when (element) {
            is JsonNull -> sb.append("null")
            is JsonPrimitive -> {
                if (element.isString) writeString(sb, element.content) else sb.append(element.content)
            }
            is JsonObject -> {
                sb.append('{')
                var first = true
                for ((key, value) in element) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, key)
                    sb.append(':')
                    writeCompact(sb, value)
                }
                sb.append('}')
            }
            is JsonArray -> {
                sb.append('[')
                element.forEachIndexed { index, value ->
                    if (index > 0) sb.append(',')
                    writeCompact(sb, value)
                }
                sb.append(']')
            }
        }
    }

    private fun writeIndented(sb: StringBuilder, element: JsonElement, level: Int, unit: String) {
        when (element) {
            is JsonObject -> if (element.isEmpty()) {
                sb.append("{}")
            } else {
                val inner = unit.repeat(level + 1)
                sb.append("{\n")
                var first = true
                for ((key, value) in element) {
                    if (!first) sb.append(",\n")
                    first = false
                    sb.append(inner)
                    writeString(sb, key)
                    sb.append(": ")
                    writeIndented(sb, value, level + 1, unit)
                }
                sb.append('\n').append(unit.repeat(level)).append('}')
            }
            is JsonArray -> if (element.isEmpty()) {
                sb.append("[]")
            } else {
                val inner = unit.repeat(level + 1)
                sb.append("[\n")
                element.forEachIndexed { index, value ->
                    if (index > 0) sb.append(",\n")
                    sb.append(inner)
                    writeIndented(sb, value, level + 1, unit)
                }
                sb.append('\n').append(unit.repeat(level)).append(']')
            }
            is JsonNull -> sb.append("null")
            is JsonPrimitive -> if (element.isString) writeString(sb, element.content) else sb.append(element.content)
        }
    }

    /** Go's `encodeState.string` with `SetEscapeHTML(true)` (the default). */
    private fun writeString(sb: StringBuilder, value: String) {
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '<' -> sb.append("\\u003c")
                '>' -> sb.append("\\u003e")
                '&' -> sb.append("\\u0026")
                '\u2028' -> sb.append("\\u2028")
                '\u2029' -> sb.append("\\u2029")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
    }

    // ------------------------------------------------------------------
    // Element builders (field order = Go struct field order)
    // ------------------------------------------------------------------

    fun childToJson(child: VaultChild): JsonObject = JsonObject(
        linkedMapOf(
            "id" to JsonPrimitive(child.id),
            "name" to JsonPrimitive(child.name),
            "description" to JsonPrimitive(child.description),
            "password" to JsonPrimitive(child.password),
        )
    )

    fun entryToJson(entry: PasswordEntry): JsonObject {
        val map = linkedMapOf<String, JsonElement>(
            "id" to JsonPrimitive(entry.id),
            "name" to JsonPrimitive(entry.name),
            "description" to JsonPrimitive(entry.description),
            "password" to JsonPrimitive(entry.password),
        )
        // `omitempty`: empty string, zero number and empty slice are all omitted.
        if (entry.type.isNotEmpty()) map["type"] = JsonPrimitive(entry.type)
        if (entry.vaultId.isNotEmpty()) map["vaultId"] = JsonPrimitive(entry.vaultId)
        if (entry.revision != 0L) map["revision"] = JsonPrimitive(entry.revision)
        val children = entry.children
        if (!children.isNullOrEmpty()) map["children"] = JsonArray(children.map { childToJson(it) })
        return JsonObject(map)
    }

    fun entriesToJson(entries: List<PasswordEntry>): JsonArray = JsonArray(entries.map { entryToJson(it) })

    fun databaseToJson(file: DatabaseFile): JsonObject = JsonObject(
        linkedMapOf(
            "nextId" to JsonPrimitive(file.nextId),
            "entries" to entriesToJson(file.entries),
        )
    )
}
