
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A service class to manage passwords by communicating with a backend API.
 * This encapsulates all logic for creating, reading, updating, and deleting passwords.
 */
export class PasswordService {
    constructor({ timeoutMs = 30000 } = {}) {
        this.timeoutMs = timeoutMs;
    }

    /**
     * Server API access token (persisted in localStorage).
     * Required when the server was started with --token; otherwise the API
     * returns 401.
     */
    _getToken() {
        return localStorage.getItem('webencryptor_token') || '';
    }

    _setToken(token) {
        if (token) localStorage.setItem('webencryptor_token', token.trim());
        else localStorage.removeItem('webencryptor_token');
    }

    /**
     * A private helper to handle fetch requests and error handling.
     * @param {string} url - The URL to fetch.
     * @param {object} options - The options for the fetch call.
     * @param {boolean} retried - Internal: whether a 401 retry was already attempted.
     * @returns {Promise<any>} The JSON response from the server.
     */
    async _fetch(url, options = {}, retried = false) {
        const controller = new AbortController();
        const callerSignal = options.signal;
        const cancel = () => controller.abort(callerSignal.reason);
        if (callerSignal?.aborted) cancel();
        else callerSignal?.addEventListener('abort', cancel, { once: true });
        let timer;
        let unauthorized = false;
        let result;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('The request timed out.'));
            }, this.timeoutMs);
        });
        try {
            // The deadline covers both response headers and reading the body.
            result = await Promise.race([deadline, (async () => {
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        ...options.headers,
                        ...(this._getToken() ? { 'X-Auth-Token': this._getToken() } : {}),
                    },
                });
                if (response.status === 401 && !retried) {
                    unauthorized = true;
                    return;
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API request failed (${response.status}): ${errorText}`);
                }
                if (response.status === 204) return null;
                return await response.json();
            })()]);
        } catch (e) {
            console.error(`An error occurred in PasswordService during fetch to ${url}:`, e);
            const mutation = options.method && options.method !== 'GET';
            throw new Error(`${e.message}${mutation ? ' The change may have reached the server. Refresh the list before retrying.' : ''}`);
        } finally {
            clearTimeout(timer);
            callerSignal?.removeEventListener('abort', cancel);
        }
        // User interaction and the authorized retry each get a fresh deadline.
        if (unauthorized) {
            const token = prompt('The server requires an access token (X-Auth-Token).\nEnter the token shown in the server console:');
            if (token?.trim()) {
                this._setToken(token);
                return this._fetch(url, options, true);
            }
            throw new Error('No access token provided; the API request was rejected (401).');
        }
        return result;
    }

    _entryBody(data) {
        const limits = { name: 4096, description: 65536, password: 4 * Math.ceil(4 * 1024 * 1024 / 3) + 71 };
        const encoder = new TextEncoder();
        for (const [field, value] of Object.entries(data)) {
            if (!Object.hasOwn(limits, field) || typeof value !== 'string') throw new Error(`${field} must be a string field.`);
            if (value.length > limits[field] || encoder.encode(value).byteLength > limits[field]) {
                throw new Error(`${field} exceeds ${limits[field]} UTF-8 bytes.`);
            }
        }
        const body = JSON.stringify(data);
        if (encoder.encode(body).byteLength > 32 * 1024 * 1024) {
            throw new Error('The JSON request exceeds 32 MiB.');
        }
        return body;
    }

    /**
     * Retrieves all password entries from the server.
     * @returns {Promise<Array<object>>} A promise that resolves to an array of password objects.
     */
    async getPasswords() {
        return this._fetch('/api/passwords');
    }

    /**
     * Adds a new password entry via the API.
     * @param {{name: string, description: string, password: string}} passwordData - The password object to add.
     * @returns {Promise<object>} A promise that resolves to the newly created password entry with a server-assigned ID.
     */
    async addPassword(passwordData) {
        return this._fetch('/api/passwords', {
            method: 'POST',
            body: this._entryBody(passwordData),
        });
    }

    /**
     * Updates an existing password entry via the API.
     * @param {object} updatedPasswordData - The password object with updated data, must include an ID.
     * @returns {Promise<boolean>} A promise that resolves to true if the update was successful.
     */
    async updatePassword(updatedPasswordData) {
        const { id, ...data } = updatedPasswordData;
        if (!id) {
            throw new Error("Cannot update password without an ID.");
        }
        await this._fetch(`/api/passwords/${id}`, {
            method: 'PUT',
            body: this._entryBody(data),
        });
        return true; // If _fetch doesn't throw, it was successful.
    }

    /**
     * Deletes a password entry by its ID via the API.
     * @param {number|string} passwordId - The ID of the password to delete.
     * @returns {Promise<boolean>} A promise that resolves to true if deletion was successful.
     */
    async deletePassword(passwordId) {
        await this._fetch(`/api/passwords/${passwordId}`, {
            method: 'DELETE',
        });
        return true; // If _fetch doesn't throw, it was successful.
    }

    /**
     * close server
     */
    async shutdown() {
        await this._fetch(`/api/shutdown`, {
            method: 'POST'
        });
    }
}

// Export a singleton instance so the rest of the app shares the same service.
export const passwordService = new PasswordService();
