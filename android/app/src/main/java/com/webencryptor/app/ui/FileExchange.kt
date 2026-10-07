/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.webencryptor.app.bridge.FileExportPort
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.CancellationException

/**
 * The two places where the web app reaches outside its sandbox:
 *
 *  * **Export** — `vault_manager.js` builds a `Blob` and clicks `<a download>`.
 *    Android WebView never calls `onDownloadStart` for `blob:` URLs, so the shim
 *    hands the bytes over the bridge and they are written through the Storage
 *    Access Framework (`ACTION_CREATE_DOCUMENT`), which also gives the user a
 *    real "where do you want this?" step that a silent download folder would not.
 *  * **Import** — `index.html` has `<input type="file" id="vault-restore-file">`,
 *    which needs `WebChromeClient.onShowFileChooser`.
 *
 * Both flows set [onExternalUiStarted] / [onExternalUiFinished] so the host can
 * tell "the user is in a system picker" apart from "the user left the app" — the
 * difference between deferring the lock and locking immediately.
 */
class FileExchange(
    private val activity: AppCompatActivity,
    private val log: (String) -> Unit = {},
    private val onExternalUiStarted: () -> Unit = {},
    private val onExternalUiFinished: () -> Unit = {},
) : FileExportPort {

    private class PendingExport(
        val name: String,
        val mime: String,
        val bytes: ByteArray,
        val onResult: (Throwable?) -> Unit,
    )

    private val pendingExport = AtomicReference<PendingExport?>(null)
    private val pendingChooser = AtomicReference<ValueCallback<Array<Uri>>?>(null)
    private val io = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "webencryptor-export").apply { isDaemon = true }
    }

    private val exportLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val pending = pendingExport.getAndSet(null)
            onExternalUiFinished()
            if (pending == null) return@registerForActivityResult
            val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
            if (uri == null) {
                pending.onResult(CancellationException("the export was cancelled"))
                return@registerForActivityResult
            }
            io.execute {
                try {
                    writeTo(uri, pending.bytes)
                    pending.onResult(null)
                } catch (error: Throwable) {
                    log("Backup export failed: ${error.message}")
                    pending.onResult(error)
                }
            }
        }

    private val chooserLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = pendingChooser.getAndSet(null)
            onExternalUiFinished()
            if (callback == null) return@registerForActivityResult
            val uris = if (result.resultCode == Activity.RESULT_OK) {
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            } else {
                null
            }
            callback.onReceiveValue(uris)
        }

    override fun export(name: String, mime: String, bytes: ByteArray, onResult: (Throwable?) -> Unit) {
        // `export` is called from the bridge thread; launching an Activity must
        // happen on the main thread.
        activity.runOnUiThread {
            if (activity.isFinishing) {
                onResult(CancellationException("the activity is finishing"))
                return@runOnUiThread
            }
            if (pendingExport.get() != null) {
                onResult(IllegalStateException("another export is already waiting for a destination"))
                return@runOnUiThread
            }
            pendingExport.set(PendingExport(name, mime, bytes, onResult))
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mime.ifBlank { "application/octet-stream" }
                putExtra(Intent.EXTRA_TITLE, name)
            }
            onExternalUiStarted()
            try {
                exportLauncher.launch(intent)
            } catch (error: ActivityNotFoundException) {
                pendingExport.set(null)
                onExternalUiFinished()
                onResult(error)
            }
        }
    }

    /** Wired to `WebChromeClient.onShowFileChooser`. */
    fun showFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        pendingChooser.getAndSet(null)?.onReceiveValue(null)
        val intent = try {
            params.createIntent()
        } catch (error: Throwable) {
            log("Could not build a file chooser intent: ${error.message}")
            callback.onReceiveValue(null)
            return false
        }
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        pendingChooser.set(callback)
        onExternalUiStarted()
        return try {
            chooserLauncher.launch(intent)
            true
        } catch (error: ActivityNotFoundException) {
            pendingChooser.set(null)
            onExternalUiFinished()
            callback.onReceiveValue(null)
            false
        }
    }

    /** Called from `Activity.onDestroy` so the page is never left waiting. */
    fun cancelPending() {
        pendingExport.getAndSet(null)?.onResult(CancellationException("the activity is finishing"))
        pendingChooser.getAndSet(null)?.onReceiveValue(null)
        io.shutdownNow()
    }

    fun hasPendingExternalUi(): Boolean = pendingExport.get() != null || pendingChooser.get() != null

    private fun writeTo(uri: Uri, bytes: ByteArray) {
        val resolver = activity.contentResolver
        val stream = resolver.openOutputStream(uri, "wt")
            ?: throw IOException("the chosen location could not be opened for writing")
        stream.use {
            it.write(bytes)
            it.flush()
        }
    }
}
