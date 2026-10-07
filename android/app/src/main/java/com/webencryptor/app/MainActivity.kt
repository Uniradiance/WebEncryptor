/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app

import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import com.webencryptor.app.api.ApiRouter
import com.webencryptor.app.bridge.PlatformBridge
import com.webencryptor.app.data.AndroidDirSync
import com.webencryptor.app.data.AesGcmSealer
import com.webencryptor.app.data.FileStorage
import com.webencryptor.app.data.PasswordStore
import com.webencryptor.app.security.ClipboardGuard
import com.webencryptor.app.security.KeyVault
import com.webencryptor.app.ui.FileExchange
import com.webencryptor.app.ui.JsDialogHandler
import java.io.File

/**
 * The single activity of the port: a WebView host plus the storage bridge.
 *
 * Lifecycle decisions worth knowing about:
 *
 *  * **`FLAG_SECURE` is on for the whole app.** It keeps vault names out of the
 *    recents thumbnail and blocks screenshots; the JavaScript dialogs create
 *    their own windows and set the flag again (see [JsDialogHandler]).
 *  * **Backgrounding locks the vault immediately** (acceptance #4). Relying on the
 *    page's `pagehide` or its five-minute `setTimeout` is not enough: a frozen
 *    renderer stops running timers, so a phone handed to someone else could still
 *    be showing an unlocked vault. The page is told to lock via
 *    `window.__WE_APP__.lock()`.
 *  * **A system picker is not "leaving the app".** While the Storage Access
 *    Framework or the file chooser is open, `onStop` fires but the lock is
 *    deferred until the picker returns, otherwise choosing a backup file would
 *    cancel the very operation that opened it.
 *  * **The clipboard is not cleared on `onStop`.** Copying a password and then
 *    switching to the app that needs it is the primary workflow; the timed clear
 *    in [ClipboardGuard] is what limits exposure instead.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var content: FrameLayout
    private lateinit var dialogs: JsDialogHandler
    private lateinit var fileExchange: FileExchange
    private lateinit var clipboard: ClipboardGuard
    private lateinit var host: WebAppHost
    private lateinit var bridge: PlatformBridge

    private var store: PasswordStore? = null
    private var externalUiDepth = 0
    private var lockOnReturn = false

    private val log: (String) -> Unit = { message -> if (BuildConfig.DEBUG) Log.d(TAG, message) else Log.i(TAG, message) }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Screenshots, screen recordings and the recents thumbnail are all
        // suppressed for the whole app.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        // targetSdk 35 is edge-to-edge on Android 15+: the window is drawn behind
        // the system bars, so the WebView is padded with the real insets instead of
        // patching the (frozen) web CSS with safe-area rules.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        content = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }
        setContentView(content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.updatePadding(
                left = bars.left,
                top = bars.top,
                right = bars.right,
                bottom = maxOf(bars.bottom, ime.bottom),
            )
            insets
        }

        dialogs = JsDialogHandler(this, log)
        fileExchange = FileExchange(
            activity = this,
            log = log,
            onExternalUiStarted = { externalUiDepth++ },
            onExternalUiFinished = {
                externalUiDepth = maxOf(0, externalUiDepth - 1)
            },
        )
        clipboard = ClipboardGuard(this)

        val opened = openStore()
        if (opened == null) return // a fatal dialog is already on screen

        bridge = PlatformBridge(
            router = ApiRouter(opened, log),
            clipboard = clipboard,
            fileExporter = fileExchange,
            log = log,
            onShutdownRequested = {
                runOnUiThread {
                    Toast.makeText(this, R.string.toast_shutdown_noop, Toast.LENGTH_LONG).show()
                }
            },
            onPageReady = { ready -> log("Page ready: ${ready.platform}") },
        )

        host = WebAppHost(
            activity = this,
            bridge = bridge,
            fileExchange = fileExchange,
            dialogs = dialogs,
            log = log,
            onRenderProcessGone = { reason -> runOnUiThread { showRendererGoneDialog(reason) } },
            onLoadError = { message -> runOnUiThread { showLoadError(message) } },
        )
        content.addView(
            host.webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        if (!host.install()) {
            showWebViewUpgradeDialog(host.supportReport())
            return
        }
        host.load()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    host.requestBack { decision ->
                        if (decision.handled) return@requestBack
                        confirmExit(decision.dirty)
                    }
                }
            },
        )
    }

    override fun onStart() {
        super.onStart()
        if (lockOnReturn && ::host.isInitialized) {
            lockOnReturn = false
            host.lockVault()
        }
    }

    override fun onStop() {
        super.onStop()
        // `host` does not exist when the storage layer failed to open (the activity
        // is only showing an explanation at that point).
        if (!::host.isInitialized) return
        if (externalUiDepth > 0) {
            // A system picker is on top of us; lock as soon as we are back.
            lockOnReturn = true
        } else {
            host.lockVault()
        }
    }

    override fun onDestroy() {
        dialogs.dismissAll()
        fileExchange.cancelPending()
        clipboard.clearIfOwned()
        clipboard.cancelPendingClear()
        if (::bridge.isInitialized) bridge.shutdown()
        if (::host.isInitialized) host.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /**
     * Opens the sealed database. Returns `null` and shows a blocking explanation
     * when the platform key or the stored document is unusable — in both cases the
     * last good file is preserved and nothing is overwritten without the user
     * explicitly asking for it.
     */
    private fun openStore(): PasswordStore? {
        val directory = File(filesDir, "we").apply { mkdirs() }
        val sealer = try {
            AesGcmSealer(KeyVault.dataKey(this))
        } catch (error: KeyVault.KeyUnavailableException) {
            log("Keystore unavailable: ${error.message}")
            showStorageFailureDialog(
                getString(R.string.storage_key_failure_message, directory.absolutePath),
            )
            return null
        }

        val candidate = PasswordStore(
            storage = FileStorage(directory, AndroidDirSync()),
            sealer = sealer,
            log = log,
        )
        store = candidate
        when (val result = candidate.load()) {
            is PasswordStore.LoadResult.Loaded -> log("Database ready (${result.records} records).")
            is PasswordStore.LoadResult.Migrated -> log("Imported ${result.records} records from plaintext.")
            PasswordStore.LoadResult.Empty -> log("Fresh install: no database yet.")
            is PasswordStore.LoadResult.Corrupt -> {
                log("Database unusable: ${result.message}")
                showStorageFailureDialog(result.message)
                return null
            }
        }
        return candidate
    }

    // ------------------------------------------------------------------
    // Dialogs
    // ------------------------------------------------------------------

    private fun alert(): AlertDialog.Builder = AlertDialog.Builder(this).setCancelable(false)

    private fun show(dialog: AlertDialog, onCancel: (() -> Unit)? = null) {
        if (onCancel != null) dialog.setOnCancelListener { onCancel() }
        dialog.show()
        // Dialogs are separate windows: FLAG_SECURE has to be set per window.
        dialog.window?.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
    }

    private fun showWebViewUpgradeDialog(report: WebAppHost.SupportReport) {
        val shown = report.versionName ?: getString(R.string.webview_missing_package)
        show(
            alert()
                .setTitle(R.string.webview_upgrade_title)
                .setMessage(getString(R.string.webview_upgrade_message, shown))
                .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
                .create(),
            onCancel = { finish() },
        )
    }

    private fun showStorageFailureDialog(message: String) {
        show(
            alert()
                .setTitle(R.string.storage_failure_title)
                .setMessage(message)
                .setPositiveButton(R.string.storage_quarantine) { _, _ ->
                    store?.quarantine()
                    recreate()
                }
                .setNegativeButton(R.string.exit_confirm) { _, _ -> finish() }
                .create(),
            onCancel = { finish() },
        )
    }

    private fun showRendererGoneDialog(reason: String) {
        show(
            alert()
                .setTitle(R.string.render_gone_title)
                .setMessage(getString(R.string.render_gone_message) + "\n\n(" + reason + ")")
                .setPositiveButton(R.string.render_gone_reload) { _, _ -> rebuildWebView() }
                .setNegativeButton(R.string.render_gone_close) { _, _ -> finish() }
                .create(),
            onCancel = { finish() },
        )
    }

    private fun showLoadError(message: String) {
        show(
            alert()
                .setTitle(R.string.load_error_title)
                .setMessage(getString(R.string.load_error_message, message))
                .setPositiveButton(R.string.render_gone_reload) { _, _ -> host.reload() }
                .setNegativeButton(R.string.render_gone_close) { _, _ -> finish() }
                .create(),
            onCancel = { finish() },
        )
    }

    private fun rebuildWebView() {
        val view = host.recreate()
        content.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        if (host.install()) host.load() else showWebViewUpgradeDialog(host.supportReport())
    }

    private fun confirmExit(hasDraft: Boolean) {
        show(
            alert()
                .setTitle(R.string.exit_title)
                .setMessage(if (hasDraft) R.string.exit_message_dirty else R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm) { _, _ -> finish() }
                .setNegativeButton(R.string.exit_cancel, null)
                .create()
        )
    }

    companion object {
        private const val TAG = "WebEncryptor"
        private const val BACKGROUND = 0xFFF4F7F9.toInt()
    }
}
