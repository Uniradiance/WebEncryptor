
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A service class to manage passwords by communicating with a backend API.
 * This encapsulates all logic for creating, reading, updating, and deleting passwords.
 */
class PasswordService {

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
        try {
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    ...(this._getToken() ? { 'X-Auth-Token': this._getToken() } : {}),
                },
                ...options,
            });

            // 401: missing or invalid token -> ask for it once (persisted in localStorage)
            if (response.status === 401 && !retried) {
                const token = prompt('The server requires an access token (X-Auth-Token).\nThe token is shown in the server console when it starts; this browser will remember it after you enter it:');
                if (token && token.trim()) {
                    this._setToken(token);
                    return this._fetch(url, options, true);
                }
                throw new Error('No access token provided; the API request was rejected (401). Check the server console for the --token value.');
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Could not read error response.');
                throw new Error(`API request to ${url} failed with status ${response.status}: ${errorText}`);
            }

            // For methods like DELETE, the server might return a 204 No Content.
            if (response.status === 204) {
                return null;
            }

            return await response.json();
        } catch (e) {
            console.error(`An error occurred in PasswordService during fetch to ${url}:`, e);
            // Re-throw the error so the calling UI layer can handle it.
            throw e;
        }
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
            body: JSON.stringify(passwordData),
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
            body: JSON.stringify(data),
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
