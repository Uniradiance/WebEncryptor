/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The data key that seals the password database.
 *
 * A random 256-bit data key is generated once and wrapped by an AES key that
 * lives in the Android Keystore and never leaves it. The wrapped key is stored in
 * app-private preferences; the seal itself is AES-GCM (see `data/Sealer.kt`).
 *
 * Why not encrypt the database directly with the Keystore key? Because the
 * Keystore performs every operation through a slow binder call and cannot do
 * streaming work; a wrapped data key lets the JVM's AES-GCM do the bulk
 * encryption while the secret at rest still never leaves the TEE/StrongBox-backed
 * Keystore.
 *
 * Failure policy: if the wrapping key cannot be used (for example the Keystore
 * entry was destroyed), this throws rather than silently generating a new key —
 * a new key would make every existing vault permanently unreadable, so the
 * caller must surface the problem and leave the sealed file untouched.
 */
object KeyVault {

    private const val KEYSTORE = "AndroidKeyStore"
    private const val WRAPPING_ALIAS = "webencryptor.dek.wrap.v1"
    private const val PREFERENCES = "webencryptor_keys"
    private const val PREFERENCE_KEY = "wrapped_dek_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
    private const val NONCE_BYTES = 12
    private const val DATA_KEY_BYTES = 32

    class KeyUnavailableException(message: String, cause: Throwable?) : Exception(message, cause)

    /** Returns the app's data key, creating and wrapping it on first use. */
    fun dataKey(context: Context): SecretKey {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val wrappingKey = try {
            wrappingKey()
        } catch (error: Throwable) {
            throw KeyUnavailableException("The Android Keystore key is unavailable.", error)
        }
        val stored = preferences.getString(PREFERENCE_KEY, null)
        if (stored != null) {
            val blob = try {
                Base64.getDecoder().decode(stored)
            } catch (error: IllegalArgumentException) {
                throw KeyUnavailableException("The wrapped data key is corrupt.", error)
            }
            if (blob.size <= NONCE_BYTES) {
                throw KeyUnavailableException("The wrapped data key is truncated.", null)
            }
            val plaintext = try {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    wrappingKey,
                    GCMParameterSpec(TAG_BITS, blob, 0, NONCE_BYTES),
                )
                cipher.doFinal(blob, NONCE_BYTES, blob.size - NONCE_BYTES)
            } catch (error: Throwable) {
                throw KeyUnavailableException(
                    "The stored data key could not be unwrapped; the encrypted database is preserved.",
                    error,
                )
            }
            return SecretKeySpec(plaintext, "AES")
        }

        val dataKey = ByteArray(DATA_KEY_BYTES).also { SecureRandom().nextBytes(it) }
        val wrapped = try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
            val nonce = cipher.iv
            nonce + cipher.doFinal(dataKey)
        } catch (error: Throwable) {
            throw KeyUnavailableException("The data key could not be wrapped.", error)
        }
        // commit() and not apply(): the key must be on disk before the sealed
        // database that depends on it is written.
        val committed = preferences.edit().putString(PREFERENCE_KEY, Base64.getEncoder().encodeToString(wrapped)).commit()
        if (!committed) {
            throw KeyUnavailableException("The wrapped data key could not be persisted.", null)
        }
        return SecretKeySpec(dataKey, "AES")
    }

    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(WRAPPING_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                WRAPPING_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                // No user-authentication binding: the vault has its own
                // three-factor unlock, and an auth-bound key would lock the user
                // out of their own data after a biometric re-enrolment.
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }
}
