/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Raw, durable byte storage. Kept behind an interface so the whole data layer can
 * be exercised on the JVM (see `src/test`) without an Android device, and so the
 * durability strategy stays visible in one place.
 */
interface Storage {
    fun readBytes(name: String): ByteArray?
    fun writeAtomicBytes(name: String, bytes: ByteArray)
    fun exists(name: String): Boolean
    fun delete(name: String): Boolean
    fun rename(from: String, to: String): Boolean
}

/**
 * `fsync` on a directory. `commitDB` in `server.go` syncs the directory *after*
 * the rename so the new name is durable, not just the new content. Android needs
 * `android.system.Os` for that (Java NIO cannot open a directory), so the
 * platform implementation lives in [AndroidDirSync] and tests use [NoopDirSync].
 */
fun interface DirSync {
    fun sync(directory: File)
}

object NoopDirSync : DirSync {
    override fun sync(directory: File) = Unit
}

class FileStorage(
    private val root: File,
    private val dirSync: DirSync = NoopDirSync,
) : Storage {

    override fun readBytes(name: String): ByteArray? {
        val file = File(root, name)
        return if (file.isFile) file.readBytes() else null
    }

    override fun exists(name: String): Boolean = File(root, name).exists()

    override fun delete(name: String): Boolean = File(root, name).delete()

    override fun rename(from: String, to: String): Boolean = File(root, from).renameTo(File(root, to))

    /**
     * `os.CreateTemp` + write + `f.Sync` + `os.Rename` + directory sync, exactly
     * as `commitDB` does it: the target file is either the old content or the new
     * content, never a truncated mixture.
     */
    override fun writeAtomicBytes(name: String, bytes: ByteArray) {
        if (!root.isDirectory && !root.mkdirs()) {
            throw IOException("Cannot create data directory ${root.absolutePath}")
        }
        val target = File(root, name)
        val temp = File.createTempFile(".${name.trimEnd('.', '-')}-", ".tmp", root)
        try {
            FileOutputStream(temp).use { out ->
                out.write(bytes)
                out.flush()
                out.fd.sync()
            }
            if (!temp.renameTo(target)) {
                throw IOException("Cannot rename ${temp.name} to ${target.name}")
            }
        } finally {
            // No-op once the rename succeeded.
            temp.delete()
        }
        dirSync.sync(root)
    }
}
