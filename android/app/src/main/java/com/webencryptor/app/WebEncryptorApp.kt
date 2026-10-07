/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate

/**
 * The web frontend declares `color-scheme: light` and ships no dark palette, so
 * the app is pinned to light mode. Combined with
 * `WebSettingsCompat.setAlgorithmicDarkeningAllowed(false)` in [WebAppHost] this
 * keeps the rendered interface identical on a device configured for dark theme.
 */
class WebEncryptorApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO)
    }
}
