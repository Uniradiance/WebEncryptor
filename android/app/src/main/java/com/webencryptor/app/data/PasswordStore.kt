/*
 * Copyright 2025 WebEncryptor contributors
 * SPDX-License-Identifier: Apache-2.0
 */
package com.webencryptor.app.data

/**
 * The database itself: the port of the `server` struct's storage half
 * (`loadDB`, `commitDB`, `cloneEntries`) from `server.go`.
 *
 * Differences from the desktop, all deliberate:
 *
 *  * The document is sealed before it reaches the filesystem ([Sealer]).
 *  * A database that cannot be parsed does **not** abort the process the way
 *    `log.Fatalf` does on the desktop. The last good file is preserved, every
 *    write is refused (`StorageFailureException`) so nothing can overwrite it,
 *    and the UI offers to move the damaged file aside — the user decides, the app
 *    never deletes data on its own.
 *  * A plaintext `passwords.json` left in the data directory (for example pushed
 *    with `adb push` while migrating from the desktop) is imported once and then
 *    removed, after the sealed copy is durable.
 */
class PasswordStore(
    private val storage: Storage,
    private val sealer: Sealer,
    private val dbName: String = DEFAULT_DB_NAME,
    private val plaintextName: String = LEGACY_PLAINTEXT_NAME,
    private val log: (String) -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
) {

    sealed class LoadResult {
        /** No database yet: the desktop behaves the same way and creates it on first write. */
        data object Empty : LoadResult()

        data class Loaded(val records: Int) : LoadResult()

        /** A desktop `passwords.json` was found, validated, sealed and removed. */
        data class Migrated(val records: Int) : LoadResult()

        /** The stored document is unusable; nothing may be written until the user decides. */
        data class Corrupt(val message: String, val quarantined: String?) : LoadResult()
    }

    /**
     * A locked view of the database. Mutations happen on a detached snapshot and
     * are published only after the file rename succeeded — the same ordering as
     * `commitDB`, which is what makes a crash mid-write harmless.
     */
    inner class Session internal constructor() {
        val entries: List<PasswordEntry> get() = db

        val currentNextId: Long get() = nextId

        /** `cloneEntries`: detached snapshots so readers never share nested lists. */
        fun snapshot(): List<PasswordEntry> = cloneEntries(db)

        fun commit(nextEntries: List<PasswordEntry>) = this@PasswordStore.commit(nextEntries)
    }

    private val mutex = Any()
    private var db: List<PasswordEntry> = emptyList()
    private var nextId: Long = 1L
    private var loadFailure: DatabaseFormatException? = null

    /** Non-null while the on-disk document is unusable. */
    val failureReason: String? get() = loadFailure?.message

    fun load(): LoadResult = synchronized(mutex) {
        loadFailure = null
        val sealed = storage.readBytes(dbName)
        if (sealed != null) {
            val text = try {
                String(sealer.unseal(sealed, ASSOCIATED_DATA), Charsets.UTF_8)
            } catch (error: Throwable) {
                val failure = DatabaseFormatException(
                    "cannot unseal database $dbName (original file preserved): ${error.message}"
                )
                loadFailure = failure
                return@synchronized LoadResult.Corrupt(failure.message.orEmpty(), quarantined = null)
            }
            return@synchronized adopt(text, plaintext = false)
        }

        val legacy = storage.readBytes(plaintextName)
        if (legacy != null) {
            log("Found a plaintext $plaintextName; importing it into the sealed database.")
            val outcome = adopt(String(legacy, Charsets.UTF_8), plaintext = true)
            if (outcome is LoadResult.Migrated) {
                // Only now that the sealed copy is durable is the plaintext removed.
                if (!storage.delete(plaintextName)) {
                    log("Warning: could not remove the imported $plaintextName.")
                }
            }
            return@synchronized outcome
        }

        db = emptyList()
        nextId = 1L
        log("No database yet; starting empty (file is created by the first write).")
        LoadResult.Empty
    }

    private fun adopt(text: String, plaintext: Boolean): LoadResult {
        return try {
            val file = EntryCodec.parseDatabase(dbName, text)
            db = file.entries
            nextId = file.nextId
            if (plaintext) {
                commit(db)
                log("Imported ${db.size} records from the plaintext database.")
                LoadResult.Migrated(db.size)
            } else {
                log("Loaded ${db.size} records from $dbName.")
                LoadResult.Loaded(db.size)
            }
        } catch (error: DatabaseFormatException) {
            db = emptyList()
            nextId = 1L
            loadFailure = error
            LoadResult.Corrupt(error.message.orEmpty(), quarantined = null)
        }
    }

    /**
     * Moves the unusable document aside (`<name>.corrupt-<timestamp>`) and starts
     * from an empty database. Returns the new file name, or `null` when there was
     * nothing to move.
     */
    fun quarantine(): String? = synchronized(mutex) {
        val stamp = clock()
        var moved: String? = null
        for (name in listOf(dbName, plaintextName)) {
            if (!storage.exists(name)) continue
            var candidate = "$name.corrupt-$stamp"
            var counter = 1
            while (storage.exists(candidate)) candidate = "$name.corrupt-$stamp-${counter++}"
            if (storage.rename(name, candidate)) {
                moved = moved ?: candidate
                log("Damaged database preserved as $candidate.")
            }
        }
        db = emptyList()
        nextId = 1L
        loadFailure = null
        moved
    }

    /** Runs [block] with the database locked and commits whatever it returns. */
    fun <T> transact(block: (Session) -> T): T = synchronized(mutex) { block(Session()) }

    /**
     * `commitDB`: allocate the next id, serialise, write atomically, **then**
     * publish to memory. A failure leaves the previous state intact.
     */
    private fun commit(next: List<PasswordEntry>) {
        loadFailure?.let {
            throw StorageFailureException(
                IllegalStateException("the stored database is unreadable and was not overwritten: ${it.message}")
            )
        }
        var allocated = nextId
        for (entry in next) {
            if (entry.id >= allocated) allocated = entry.id + 1
        }
        val sealed = try {
            val document = GoJson.indented(GoJson.databaseToJson(DatabaseFile(allocated, next)))
            sealer.seal(document.toByteArray(Charsets.UTF_8), ASSOCIATED_DATA)
        } catch (error: Throwable) {
            // A seal failure (for example the platform key became unusable) must not
            // be reported as a write that might have happened.
            throw StorageFailureException(error)
        }
        try {
            storage.writeAtomicBytes(dbName, sealed)
        } catch (error: Throwable) {
            throw StorageFailureException(error)
        }
        db = next
        nextId = allocated
        log("Database saved ($allocated next id, ${next.size} records).")
    }

    /** `cloneEntries`: survives failed-write rollback and keeps readers detached. */
    private fun cloneEntries(entries: List<PasswordEntry>): List<PasswordEntry> =
        entries.map { entry ->
            if (entry.children == null) entry else entry.copy(children = ArrayList(entry.children))
        }

    companion object {
        const val DEFAULT_DB_NAME = "passwords.json.enc"
        const val LEGACY_PLAINTEXT_NAME = "passwords.json"

        /** Binds a sealed file to its purpose; never changed without a format bump. */
        private val ASSOCIATED_DATA = "webencryptor/passwords.json/v1".toByteArray(Charsets.US_ASCII)
    }
}
