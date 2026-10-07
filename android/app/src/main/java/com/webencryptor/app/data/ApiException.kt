/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

/**
 * Errors surfaced by the storage layer, each carrying the HTTP status the
 * desktop server would have answered with (`server.go` / `vault.go`). The bridge
 * forwards the status verbatim, so `htdocs/password_service.js` and
 * `htdocs/vault_manager.js` observe exactly the same behaviour they observe
 * against the Go server — including the 409/500 branch that keeps an unsaved
 * draft on screen.
 */
sealed class ApiException(message: String, val status: Int) : Exception(message) {

    /** 400: malformed body, bad field, or a failed vault invariant. */
    class BadRequest(message: String) : ApiException(message, 400)

    /** 404: no record with that id (`Not Found` for a non-numeric id). */
    class NotFound(message: String) : ApiException(message, 404)

    /** 409: vault revision mismatch (`If-Match` / `revision`). */
    class Conflict(message: String) : ApiException(message, 409)

    /** 405: method not allowed for a known path. */
    class MethodNotAllowed : ApiException("Method Not Allowed", 405)

    /** 413: a field or the whole request exceeded its documented limit. */
    class TooLarge(message: String) : ApiException(message, 413)

    /** 500: the write could not be confirmed on disk. */
    class ServerError(message: String) : ApiException(message, 500)
}

/**
 * `errVaultConflict` from `vault.go`. Kept as a distinct type because the Go
 * server maps it to 409 while every other vault validation failure maps to 400.
 */
class VaultConflictException :
    ApiException(
        "This vault changed in another session. Your draft is retained. " +
            "Lock and reopen the vault before retrying.",
        409,
    )

/**
 * A failure to persist the database. The message matches `databaseError` in
 * `server.go` so the web UI shows its "refresh before retrying" guidance.
 */
class StorageFailureException(cause: Throwable?) :
    ApiException("Could not confirm saving to disk. Refresh the list before retrying.", 500)
