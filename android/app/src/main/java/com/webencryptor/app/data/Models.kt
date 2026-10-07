/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

/**
 * One encrypted child item of a password vault.
 *
 * This is a direct port of `VaultChild` in the desktop server's `vault.go`:
 * `id` is a UUIDv4, the human readable fields are always empty on the wire and
 * `password` carries an opaque `WVI1` envelope. The server never sees plaintext
 * account data, and neither does this port.
 */
data class VaultChild(
    val id: String,
    val name: String = "",
    val description: String = "",
    val password: String = "",
)

/**
 * One record in the password database.
 *
 * Mirrors `PasswordEntry` in `server.go`, including the `omitempty` behaviour of
 * the Go struct, which is modelled by the "zero value means absent" convention
 * (empty string / `0` / `null`) used by [toJsonObject] and by the validation in
 * [VaultValidation]. Keeping that convention is what makes the JSON produced by
 * this port byte-identical to the desktop server's.
 */
data class PasswordEntry(
    /**
     * 64-bit to match the desktop's Go `int` (and JavaScript's safe-integer
     * range): ids above 2^31 must not be rejected on import.
     */
    val id: Long,
    val name: String = "",
    val description: String = "",
    val password: String = "",
    /** `""` means "absent", exactly like Go's `omitempty` on a string field. */
    val type: String = "",
    /** `""` means "absent". */
    val vaultId: String = "",
    /** `0` means "absent". */
    val revision: Long = 0L,
    /**
     * `null` means "absent"; an empty list means the JSON contained `[]`. The
     * distinction is load bearing: `validateStoredEntry` rejects an empty list
     * on an ordinary record but accepts it on a vault.
     */
    val children: List<VaultChild>? = null,
) {
    val isVault: Boolean get() = type == "vault"
}

/**
 * The on-disk database document: `passwords.json` on the desktop, the sealed
 * payload of `passwords.json.enc` on Android.
 */
data class DatabaseFile(
    val nextId: Long,
    val entries: List<PasswordEntry>,
)
