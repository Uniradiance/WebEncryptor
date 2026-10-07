/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File

/**
 * Directory `fsync` on Android. `commitDB` in `server.go` syncs the directory
 * after the rename so the *name* is durable and not just the content; Java NIO
 * cannot open a directory for that, so this drops down to `Os.fsync`.
 *
 * Best effort by design: if the filesystem refuses to sync a directory the
 * database itself is already durable, and failing the whole write would be worse
 * than the (already tiny) risk this closes.
 */
class AndroidDirSync : DirSync {
    override fun sync(directory: File) {
        var fd: java.io.FileDescriptor? = null
        try {
            fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
            Os.fsync(fd)
        } catch (_: ErrnoException) {
            // Not fatal: the rename itself is atomic on every Android filesystem.
        } catch (_: Throwable) {
            // Same.
        } finally {
            fd?.let { descriptor ->
                try {
                    Os.close(descriptor)
                } catch (_: Throwable) {
                    // ignore
                }
            }
        }
    }
}
