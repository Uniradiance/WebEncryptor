/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.security

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import com.webencryptor.app.bridge.ClipboardPort

/**
 * Clipboard access for the web app.
 *
 * The plain `navigator.clipboard` API works in the asset secure context, but it
 * has two problems on a phone: Android 13+ shows a preview of the clipboard
 * content (a password in plain sight), and a copied password stays in the
 * clipboard history indefinitely. Both are handled here:
 *
 *  * the clip is marked `EXTRA_IS_SENSITIVE`, which suppresses the preview;
 *  * it is cleared after [clearDelayMs], and when the activity is destroyed.
 *
 * Marking every write as sensitive is deliberate — the app copies either an
 * account password, a plaintext draft, or a ciphertext, and there is no way to
 * tell them apart reliably from the shim. Losing the preview for a ciphertext is
 * a much smaller cost than leaking a password.
 */
class ClipboardGuard(
    private val context: Context,
    private val clearDelayMs: Long = DEFAULT_CLEAR_DELAY_MS,
) : ClipboardPort {

    private val handler = Handler(Looper.getMainLooper())
    private var lastWritten: String? = null

    private val manager: ClipboardManager? =
        context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

    private val clearTask = Runnable {
        if (clearIfOwned()) {
            onCleared?.invoke()
        }
    }

    /** Invoked (on the main thread) when a clip written by this app is cleared. */
    var onCleared: (() -> Unit)? = null

    override fun write(text: String, sensitive: Boolean) {
        val clipboard = manager ?: return
        val clip = ClipData.newPlainText(LABEL, text)
        if (sensitive) {
            // The literal value of ClipDescription.EXTRA_IS_SENSITIVE; using the
            // constant directly would require API 33 while the extra itself is
            // understood by the platform on older releases too (it is ignored).
            val extras = PersistableBundle()
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true)
            clip.description.extras = extras
        }
        try {
            clipboard.setPrimaryClip(clip)
        } catch (_: Throwable) {
            return
        }
        lastWritten = text
        handler.removeCallbacks(clearTask)
        if (clearDelayMs > 0) handler.postDelayed(clearTask, clearDelayMs)
    }

    override fun read(): String? {
        val clipboard = manager ?: return null
        val clip = try {
            clipboard.primaryClip
        } catch (_: Throwable) {
            return null
        }
        if (clip == null || clip.itemCount == 0) return null
        val text = try {
            clip.getItemAt(0).coerceToText(context)?.toString()
        } catch (_: Throwable) {
            null
        }
        return text
    }

    /** Clears the clipboard if (and only if) this app put the current value there. */
    fun clearIfOwned(): Boolean {
        val clipboard = manager ?: return false
        val owned = lastWritten
        if (owned == null) return false
        val current = try {
            clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
        } catch (_: Throwable) {
            null
        }
        handler.removeCallbacks(clearTask)
        lastWritten = null
        if (current != owned) return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                clipboard.clearPrimaryClip()
            } else {
                clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
            }
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun cancelPendingClear() {
        handler.removeCallbacks(clearTask)
    }

    companion object {
        private const val LABEL = "WebEncryptor"
        const val DEFAULT_CLEAR_DELAY_MS = 45_000L
    }
}
