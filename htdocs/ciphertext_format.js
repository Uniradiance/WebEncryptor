// Storage validation only: authenticity can be checked only during decryption.
export function validateTextCiphertext(value) {
    if (value === '') return value; // An empty manager draft contains no secret.
    if (typeof value !== 'string' || value.length > 5592479) throw new Error('Expected a WE2 ciphertext, not plaintext.');
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== 'WE2') throw new Error('Expected a WE2 ciphertext, not plaintext.');
    const lengths = parts.slice(1).map(part => {
        try {
            const bytes = atob(part);
            if (btoa(bytes) !== part) throw new Error();
            return bytes.length;
        } catch { throw new Error('Invalid ciphertext Base64.'); }
    });
    if (lengths[0] !== 16 || lengths[1] !== 12 || lengths[2] < 1 || lengths[2] > 4194304 || lengths[3] !== 16) {
        throw new Error('Invalid ciphertext field lengths.');
    }
    return value;
}
