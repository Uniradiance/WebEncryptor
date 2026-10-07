/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.ui

import android.os.Build
import android.view.WindowManager
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.widget.EditText
import android.widget.FrameLayout
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/**
 * Native rendering of the web app's `alert` / `confirm` / `prompt` calls.
 *
 * This is not cosmetic. AOSP's `WebChromeClient` javadoc is explicit that without
 * an override the dialogs are *silently suppressed and the script continues*, and
 * that the platform's default dialogs do **not** inherit `FLAG_SECURE`. For a
 * password manager both are unacceptable: `vault_manager.js` relies on `confirm()`
 * to gate destructive actions (discard a draft, delete a vault and every account
 * in it), and a dialog showing vault names must not be capturable.
 *
 * Every dialog therefore gets `FLAG_SECURE` on its own window, and every
 * [JsResult] is settled exactly once — including when the activity goes away
 * while a dialog is open, which would otherwise leave the page's JavaScript
 * blocked forever.
 */
class JsDialogHandler(
    private val activity: AppCompatActivity,
    private val log: (String) -> Unit = {},
) {

    private val open = LinkedHashMap<JsResult, AlertDialog>()
    private val settled: MutableSet<JsResult> =
        Collections.newSetFromMap(ConcurrentHashMap<JsResult, Boolean>())

    fun onAlert(message: String, result: JsResult): Boolean {
        if (!canShow(result)) return true
        val dialog = builder()
            .setMessage(message)
            .setPositiveButton(android.R.string.ok) { _, _ -> settle(result) { it.confirm() } }
            .create()
        present(dialog, result)
        return true
    }

    fun onConfirm(message: String, result: JsResult): Boolean {
        if (!canShow(result)) return true
        val dialog = builder()
            .setMessage(message)
            .setPositiveButton(android.R.string.ok) { _, _ -> settle(result) { it.confirm() } }
            .setNegativeButton(android.R.string.cancel) { _, _ -> settle(result) { it.cancel() } }
            .create()
        present(dialog, result)
        return true
    }

    fun onPrompt(message: String, defaultValue: String, result: JsPromptResult): Boolean {
        if (!canShow(result)) return true
        val input = EditText(activity).apply {
            setText(defaultValue)
            setSelection(text?.length ?: 0)
            setSingleLine()
        }
        val container = FrameLayout(activity).apply {
            val padding = (activity.resources.displayMetrics.density * 20).toInt()
            setPadding(padding, padding / 2, padding, 0)
            addView(input)
        }
        val dialog = builder()
            .setMessage(message)
            .setView(container)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                settle(result) { it.confirm(input.text?.toString().orEmpty()) }
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> settle(result) { it.cancel() } }
            .create()
        present(dialog, result)
        return true
    }

    /**
     * Cancels outstanding dialogs. Called from `Activity.onDestroy`: a JsResult
     * that is never settled keeps the renderer's JavaScript thread blocked and
     * leaks the callback with it.
     */
    fun dismissAll() {
        val entries = open.entries.toList()
        open.clear()
        for ((result, dialog) in entries) {
            try {
                dialog.dismiss()
            } catch (_: Throwable) {
                // The window may already be gone.
            }
            safeCancel(result)
        }
    }

    fun hasOpenDialogs(): Boolean = open.isNotEmpty()

    // ------------------------------------------------------------------

    private fun builder(): AlertDialog.Builder = AlertDialog.Builder(activity).setCancelable(false)

    private fun <T : JsResult> canShow(result: T): Boolean {
        if (activity.isFinishing || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed)) {
            // Nowhere to show it: unblock the page instead of hanging it.
            safeCancel(result)
            return false
        }
        return true
    }

    private fun <T : JsResult> present(dialog: AlertDialog, result: T) {
        dialog.setOnCancelListener { safeCancel(result) }
        dialog.setOnDismissListener {
            open.remove(result)
            // Dismissed by the system (configuration change, teardown): the
            // JsResult still has to be settled.
            if (!settled.contains(result)) safeCancel(result)
        }
        open[result] = dialog
        try {
            dialog.show()
            // The platform's default JS dialogs do not inherit FLAG_SECURE; these
            // are separate windows, so the flag is set on each one.
            dialog.window?.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE,
            )
        } catch (error: Throwable) {
            log("Could not show a JavaScript dialog: ${error.message}")
            open.remove(result)
            safeCancel(result)
        }
    }

    private fun <T : JsResult> settle(result: T, action: (T) -> Unit) {
        if (!settled.add(result)) return
        open.remove(result)
        try {
            action(result)
        } catch (error: Throwable) {
            log("Could not settle a JavaScript dialog: ${error.message}")
        }
    }

    private fun <T : JsResult> safeCancel(result: T) {
        if (!settled.add(result)) return
        try {
            result.cancel()
        } catch (_: Throwable) {
            // Already settled by the platform.
        }
    }
}
