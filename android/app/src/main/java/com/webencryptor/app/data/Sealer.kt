/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Confidentiality for data at rest.
 *
 * The desktop keeps `passwords.json` in the clear: entries are individually
 * encrypted, but account *names*, descriptions and the vault layout are readable
 * by anyone with the file. On a phone that file sits in the app sandbox next to a
 * much weaker threat model (rooted devices, adb backups, forensic tools), so the
 * whole document is sealed with a data key that is itself wrapped by the Android
 * Keystore (see `security/KeyVault.kt`).
 *
 * The sealed payload is still the exact `passwords.json` document, so removing
 * the seal yields a byte-identical desktop database — that is what the
 * compatibility tests assert.
 */
interface Sealer {
    fun seal(plaintext: ByteArray, associatedData: ByteArray): ByteArray
    fun unseal(sealed: ByteArray, associatedData: ByteArray): ByteArray
}

/**
 * AES-256-GCM with a random 12-byte nonce per write.
 *
 * Layout: `"WEDB1" | nonce(12) | ciphertext+tag(16)`. The file name is bound in
 * as associated data, so a sealed database cannot be swapped with another sealed
 * file from the same app.
 */
class AesGcmSealer(private val key: SecretKey) : Sealer {

    private val random = SecureRandom()

    override fun seal(plaintext: ByteArray, associatedData: ByteArray): ByteArray {
        val nonce = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(associatedData)
        val ciphertext = cipher.doFinal(plaintext)
        return MAGIC + nonce + ciphertext
    }

    override fun unseal(sealed: ByteArray, associatedData: ByteArray): ByteArray {
        if (sealed.size < MAGIC.size + NONCE_BYTES + TAG_BYTES) {
            throw IllegalArgumentException("sealed database is truncated")
        }
        if (!sealed.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) {
            throw IllegalArgumentException("sealed database has an unknown format marker")
        }
        val nonce = sealed.copyOfRange(MAGIC.size, MAGIC.size + NONCE_BYTES)
        val ciphertext = sealed.copyOfRange(MAGIC.size + NONCE_BYTES, sealed.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(ciphertext)
    }

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val TAG_BYTES = 16
        private const val NONCE_BYTES = 12
        private val MAGIC = "WEDB1".toByteArray(Charsets.US_ASCII)
    }
}
