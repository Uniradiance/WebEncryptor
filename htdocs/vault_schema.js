export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_VAULT_BYTES = 24 * 1024 * 1024;
export const MAX_ITEM_CIPHERTEXT = 87443;

export function validateVault(vault) {
    const allowed = ['type', 'vaultId', 'revision', 'name', 'description', 'password', 'children'];
    if (!vault || Object.keys(vault).some(key => !allowed.includes(key)) || vault.type !== 'vault' ||
        !UUID.test(vault.vaultId) || !Number.isSafeInteger(vault.revision) || vault.revision < 0 ||
        typeof vault.name !== 'string' || !vault.name.trim() || typeof vault.description !== 'string' ||
        typeof vault.password !== 'string' || !vault.password.startsWith('WVK1.') || vault.password.length > 2048 ||
        !Array.isArray(vault.children) || vault.children.length > 1000) throw new Error('Invalid vault structure.');
    const encoder = new TextEncoder();
    if (encoder.encode(vault.name).length > 4096 || encoder.encode(vault.description).length > 65536) throw new Error('Vault label is too long.');
    const ids = new Set();
    for (const child of vault.children) {
        if (!child || Object.keys(child).sort().join(',') !== 'description,id,name,password' ||
            !UUID.test(child.id) || ids.has(child.id) || child.name !== '' || child.description !== '' ||
            typeof child.password !== 'string' || !child.password.startsWith('WVI1.') || child.password.length > MAX_ITEM_CIPHERTEXT) {
            throw new Error('Invalid or duplicate encrypted child.');
        }
        ids.add(child.id);
    }
    if (encoder.encode(JSON.stringify(vault)).length > MAX_VAULT_BYTES - 64) throw new Error('Vault exceeds the 24 MiB limit.');
    return vault;
}

export function vaultBody(vault) {
    return validateVault({ type: vault.type, vaultId: vault.vaultId, revision: vault.revision,
        name: vault.name, description: vault.description, password: vault.password, children: vault.children || [] });
}
