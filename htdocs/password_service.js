
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
     * 服务器 API 访问令牌 (localStorage 持久化)。
     * 服务器以 --token 启动时需要, 否则 API 会返回 401。
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

            // 401: 令牌缺失或错误 → 提示输入一次 (保存在 localStorage)
            if (response.status === 401 && !retried) {
                const token = prompt('服务器要求访问令牌 (X-Auth-Token)。\n启动服务器时控制台会显示令牌; 输入后本浏览器会记住它:');
                if (token && token.trim()) {
                    this._setToken(token);
                    return this._fetch(url, options, true);
                }
                throw new Error('未提供访问令牌, API 请求被拒绝 (401)。请在服务器控制台查看 --token 值。');
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