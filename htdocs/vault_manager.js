import { passwordService } from './password_service.js';
import { VaultClient } from './vault_client.js';
import { vaultBody, MAX_VAULT_BYTES } from './vault_schema.js';

const el = id => document.getElementById(id);
const client = new VaultClient();
const accountFields = ['name', 'url', 'username', 'password', 'notes'];
let vaults = [], independent = [], selected = null, current = null, accounts = [];
let creating = false, creation = null, busy = false, stale = false, epoch = 0, refreshSerial = 0;
let editingId = null, dirty = false, accessMode = null, timer = null;
const IDLE_MS = 5 * 60 * 1000;

function status(message, error = false) {
    el('vault-status').textContent = message;
    el('vault-status').dataset.error = String(error);
}
function factors() {
    const needed = creating || !!selected || accessMode;
    window.setVaultFactorContext?.(!!needed && (!current || !!accessMode),
        accessMode === 'change' ? 'Set new unlock credentials. Redraw your pattern to verify it.' :
        accessMode === 'import' ? 'Enter the independent item’s original credentials.' :
        creating ? 'Choose the credentials for your new vault. Redraw your pattern to verify it.' :
        'Enter this vault’s password, pattern and color grid to unlock.');
}
function syncControls() {
    for (const control of el('vault').querySelectorAll('button, input, textarea, select')) {
        // Shared factor widgets manage their own validity and busy states.
        if (control.closest('#secretFactors')) continue;
        control.disabled = busy && control.id !== 'vault-lock';
    }
    if (stale) {
        for (const id of ['account-save', 'vault-add', 'vault-import', 'vault-change', 'vault-delete', 'vault-delete-locked', 'vault-access-submit']) el(id).disabled = true;
        for (const form of ['vault-change-form', 'vault-import-form']) el(form).querySelector('[type="submit"]').disabled = true;
    }
    window.setVaultBusy?.(busy);
}
function resetEditor() {
    el('vault-editor').reset();
    el('vault-editor').hidden = true;
    el('account-password').type = 'password';
    el('account-reveal').textContent = 'Show';
    el('account-reveal').setAttribute('aria-pressed', 'false');
    editingId = null; dirty = false;
}
function renderState() {
    el('vault-welcome').hidden = !!current || !!selected || creating;
    el('vault-access').hidden = !!current || (!selected && !creating);
    el('vault-workspace').hidden = !current;
    el('vault-create-fields').hidden = !creating;
    el('vault-delete-locked').hidden = creating || !selected;
    el('vault-access-title').textContent = creating ? 'Create a password vault' : `Unlock ${selected?.name || 'vault'}`;
    el('vault-access-submit').textContent = creating ? 'Create vault' : 'Unlock';
    el('vault-access-hint').textContent = creating
        ? 'Use a memorable password, pattern and grid. You will need all three to reopen this vault.'
        : 'Your vault stays encrypted until you unlock it with its three credentials.';
    el('vault-change-form').hidden = accessMode !== 'change';
    el('vault-import-form').hidden = accessMode !== 'import';
    if (current) {
        el('vault-title').textContent = current.name;
        el('vault-count').textContent = `${accounts.length} account${accounts.length === 1 ? '' : 's'} · Unlocked`;
    }
    factors(); syncControls();
}
function renderPicker() {
    const select = el('vault-select');
    select.replaceChildren(new Option('Choose a vault', ''));
    for (const vault of vaults) select.add(new Option(vault.name || 'Unnamed vault', String(vault.id)));
    select.value = String(current?.id || selected?.id || '');
}
function renderAccounts() {
    const query = el('vault-search').value.trim().toLocaleLowerCase();
    const list = el('vault-accounts');
    list.replaceChildren();
    const visible = accounts.filter(({ account }) => [account.name, account.username, account.url]
        .some(value => value.toLocaleLowerCase().includes(query)));
    for (const item of visible) {
        const row = document.createElement('article'); row.className = 'vault-account'; row.dataset.id = item.id;
        const info = document.createElement('div'); info.className = 'vault-account-info';
        const title = document.createElement('h3'); title.textContent = item.account.name;
        const summary = document.createElement('p');
        summary.textContent = [item.account.username, item.account.url].filter(Boolean).join(' · ') || 'Saved account';
        info.append(title, summary);
        const actions = document.createElement('div'); actions.className = 'vault-actions';
        const add = (label, fn, danger = false) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = `vault-button${danger ? ' danger' : ''}`;
            button.textContent = label; button.addEventListener('click', fn); actions.append(button);
        };
        add('Copy password', () => copyPassword(item.id));
        add('Edit', () => openEditor(item.id));
        add('Delete', () => removeAccount(item.id), true);
        row.append(info, actions); list.append(row);
    }
    if (!visible.length) {
        const empty = document.createElement('p'); empty.className = 'vault-empty';
        empty.textContent = query ? 'No matching accounts.' : 'No accounts yet. Add your first account.';
        list.append(empty);
    }
    renderState();
}
function armIdle() {
    clearTimeout(timer);
    if (current) timer = setTimeout(() => lock('Vault locked after 5 minutes of inactivity.'), IDLE_MS);
}
function lock(message = 'Vault locked.') {
    epoch++; refreshSerial++;
    client.lock(); clearTimeout(timer); timer = null;
    current = null; accounts = []; creation = null; dirty = false; busy = false; stale = false;
    creating = false; accessMode = null;
    el('vault-accounts').replaceChildren(); el('vault-search').value = '';
    el('vault-title').textContent = ''; el('vault-count').textContent = '';
    for (const id of ['vault-editor', 'vault-change-form', 'vault-import-form', 'vault-access']) el(id).reset();
    resetEditor();
    window.setVaultBusy?.(false);
    if (!window.isCryptoBusy?.()) window.clearSecretFactors?.();
    renderPicker(); renderState(); status(message);
}
function canDiscard() {
    return !dirty || confirm('Discard this unsaved account draft? Copy the draft first if you need to keep it.');
}
async function run(message, action) {
    if (busy || window.isCryptoBusy?.()) { status('Wait for the current operation to finish.', true); return; }
    const token = epoch;
    refreshSerial++; // Ignore list requests started before this mutation/unlock.
    busy = true; status(message); syncControls();
    try {
        await action(token);
    } catch (error) {
        if (epoch !== token) return;
        if (!client.worker && current) {
            lock(error.message);
        } else {
            status(error.message, true);
        }
    } finally {
        if (epoch === token) { busy = false; syncControls(); armIdle(); }
    }
}
function noteWriteFailure(error) {
    if (!error.status || error.status >= 500 || error.status === 409) {
        stale = true;
        error.message += current
            ? ' Copy any unsaved draft, then lock and reopen to load the saved version.'
            : ' Click Refresh to check whether creation reached the server.';
    }
    throw error;
}
async function persist(candidate, token) {
    let saved;
    try { saved = await passwordService.saveVault(candidate); }
    catch (error) { if (epoch === token) noteWriteFailure(error); throw error; }
    if (epoch !== token) return null;
    saved.children ||= [];
    current = saved; selected = saved; stale = false;
    vaults = [...vaults.filter(vault => vault.id !== saved.id), saved];
    renderPicker();
    return saved;
}
async function refreshVaults() {
    if (busy) return;
    const serial = ++refreshSerial, token = epoch;
    status('Loading vaults…');
    try {
        const entries = await passwordService.getPasswords();
        if (serial !== refreshSerial || epoch !== token) return;
        vaults = entries.filter(item => item.type === 'vault').map(item => ({ ...item, children: item.children || [] }));
        independent = entries.filter(item => item.type !== 'vault' && item.password.startsWith('WE2.'));
        if (current) {
            const latest = vaults.find(item => item.id === current.id);
            if (!latest || latest.revision !== current.revision) {
                stale = true;
                status('This vault changed elsewhere. Copy any unsaved draft, then lock and reopen it.', true);
            } else status('Vault list refreshed.');
        } else if (creation) {
            const recovered = vaults.find(item => item.vaultId === creation.vaultId);
            if (recovered) {
                selected = recovered; creation = null; creating = false; stale = false;
                client.lock();
                status('Creation reached the server. Unlock the saved vault to continue.');
            } else { stale = false; status('The new vault is not on the server. You can retry creation with the same encrypted key.'); }
        } else {
            selected = vaults.find(item => item.id === selected?.id) || null;
            status(vaults.length ? 'Choose a vault to unlock.' : 'No vaults yet. Create one to get started.');
        }
        renderPicker(); renderState();
    } catch (error) { if (serial === refreshSerial && epoch === token) status(error.message, true); }
}
function beginCreate() {
    if (busy || window.isCryptoBusy?.() || !canDiscard()) return;
    lock('Set your vault name and the three unlock credentials.');
    selected = null; creating = true; renderPicker(); renderState();
    el('vault-name').focus();
}
function readAccount() {
    return Object.fromEntries(accountFields.map(field => [field, el(`account-${field}`).value]));
}
function openEditor(id = null) {
    if (!current || busy || stale || !canDiscard()) return;
    resetEditor(); accessMode = null;
    editingId = id;
    const account = accounts.find(item => item.id === id)?.account;
    for (const field of accountFields) el(`account-${field}`).value = account?.[field] || '';
    el('vault-editor-title').textContent = id ? 'Edit account' : 'Add account';
    el('vault-editor').hidden = false; renderState(); el('account-name').focus();
}
async function copyPassword(id) {
    if (!current || busy) return;
    const item = accounts.find(item => item.id === id);
    if (!item) return;
    const token = epoch;
    try { await navigator.clipboard.writeText(item.account.password); if (token === epoch) status('Password copied.'); }
    catch { if (token === epoch) status('Could not copy. Edit the account to select its password.', true); }
}
function removeAccount(id) {
    if (!current || stale || busy || !canDiscard()) return;
    const item = accounts.find(item => item.id === id);
    if (!item || !confirm(`Delete “${item.account.name}” from this vault?`)) return;
    run('Saving account deletion…', async token => {
        if (!await persist({ ...current, children: current.children.filter(child => child.id !== id) }, token)) return;
        accounts = accounts.filter(item => item.id !== id);
        resetEditor(); renderAccounts(); status('Account deleted.');
    });
}

el('vault-access').addEventListener('submit', event => {
    event.preventDefault();
    if (stale) return;
    let credentials;
    try { credentials = window.getSecretFactors(creating); }
    catch (error) { status(error.message, true); return; }
    if (creating && !el('vault-name').value.trim()) { status('Enter a vault name.', true); return; }
    run(creating ? 'Creating vault…' : 'Unlocking vault…', async token => {
        if (creating) {
            if (!creation) {
                const vaultId = crypto.randomUUID();
                const encrypted = await client.request('vault_create', { vaultId, ...credentials });
                if (epoch !== token) return;
                creation = { type: 'vault', ...encrypted, revision: 0, name: el('vault-name').value.trim(),
                    description: el('vault-description').value, children: [] };
            }
            if (!await persist(creation, token)) return;
            creation = null; creating = false; accounts = [];
        } else {
            // Re-read before unlocking: a stale list must not activate old credentials/data.
            const entries = await passwordService.getPasswords();
            if (epoch !== token) return;
            const fresh = entries.find(item => item.id === selected.id && item.type === 'vault');
            if (!fresh) throw new Error('This vault was deleted. Refresh the vault list.');
            const items = await client.request('vault_unlock', { vaultId: fresh.vaultId,
                wrappedKey: fresh.password, children: fresh.children || [], ...credentials });
            if (epoch !== token) return;
            current = { ...fresh, children: fresh.children || [] }; selected = current; accounts = items;
        }
        window.clearSecretFactors(); renderAccounts(); status('Vault unlocked.'); armIdle();
    });
});
el('vault-editor').addEventListener('input', () => { dirty = true; armIdle(); });
el('vault-editor').addEventListener('submit', event => {
    event.preventDefault(); if (!current || stale) return;
    const account = readAccount(), id = editingId || crypto.randomUUID();
    run('Encrypting and saving account…', async token => {
        const child = await client.request('vault_encrypt', { vaultId: current.vaultId, itemId: id, account });
        if (epoch !== token) return;
        const children = [...current.children];
        const index = children.findIndex(item => item.id === id);
        if (index < 0) children.push(child); else children[index] = child;
        if (!await persist({ ...current, children }, token)) return;
        accounts = [...accounts.filter(item => item.id !== id), { id, account }];
        resetEditor(); renderAccounts(); status('Account saved.');
    });
});
el('vault-change').addEventListener('click', () => {
    if (!current || busy || stale || !canDiscard()) return;
    resetEditor(); accessMode = 'change'; window.clearSecretFactors();
    el('vault-change-name').value = current.name; el('vault-change-description').value = current.description;
    renderState(); status('Set the new credentials above, then save.');
});
el('vault-change-form').addEventListener('submit', event => {
    event.preventDefault(); if (!current || stale) return;
    let credentials;
    try { credentials = window.getSecretFactors(true); } catch (error) { status(error.message, true); return; }
    run('Saving new unlock settings…', async token => {
        const password = await client.request('vault_rewrap', { vaultId: current.vaultId, ...credentials });
        if (epoch !== token) return;
        if (!await persist({ ...current, password, name: el('vault-change-name').value.trim(), description: el('vault-change-description').value }, token)) return;
        accessMode = null; window.clearSecretFactors(); renderState(); status('Unlock settings saved.');
    });
});
el('vault-import').addEventListener('click', () => {
    if (!current || busy || stale || !canDiscard()) return;
    resetEditor(); accessMode = 'import'; window.clearSecretFactors();
    const select = el('vault-import-select'); select.replaceChildren();
    for (const item of independent) select.add(new Option(item.name || 'Independent item', String(item.id)));
    renderState(); status(independent.length ? 'Enter the selected item’s original credentials above.' : 'No WE2 independent items available. Save one in Text Encryption first.');
});
el('vault-import-form').addEventListener('submit', event => {
    event.preventDefault(); if (!current || stale) return;
    const original = independent.find(item => String(item.id) === el('vault-import-select').value);
    if (!original) return;
    let credentials;
    try { credentials = window.getSecretFactors(false); } catch (error) { status(error.message, true); return; }
    run('Decrypting and importing account…', async token => {
        const child = await client.request('vault_import', { vaultId: current.vaultId, itemId: crypto.randomUUID(),
            ciphertext: original.password, name: original.name || 'Imported account', notes: original.description, ...credentials });
        if (epoch !== token) return;
        const item = await client.request('vault_decrypt', { vaultId: current.vaultId, child });
        if (epoch !== token || !await persist({ ...current, children: [...current.children, child] }, token)) return;
        accounts.push(item); accessMode = null; window.clearSecretFactors(); renderAccounts(); status('Imported. The original independent item is retained.');
    });
});
function deleteVault() {
    const vault = current || selected;
    if (!vault || busy || stale || !canDiscard() || !confirm(`Delete vault “${vault.name}” and ALL ${vault.children?.length || 0} accounts? Save an encrypted backup first if you need it.`)) return;
    run('Deleting vault…', async token => {
        try { await passwordService.deleteVault(vault); }
        catch (error) { if (epoch === token) noteWriteFailure(error); throw error; }
        if (epoch !== token) return;
        vaults = vaults.filter(item => item.id !== vault.id); selected = null;
        lock('Vault and its accounts deleted.');
    });
}
el('vault-delete').addEventListener('click', deleteVault);
el('vault-delete-locked').addEventListener('click', deleteVault);
el('vault-select').addEventListener('change', () => {
    const id = Number(el('vault-select').value);
    if (!canDiscard()) { renderPicker(); return; }
    lock(); selected = vaults.find(vault => vault.id === id) || null;
    renderPicker(); renderState(); status(selected ? 'Enter the three credentials above to unlock.' : 'Choose or create a vault.');
});
el('vault-new').addEventListener('click', beginCreate);
el('vault-welcome-create').addEventListener('click', beginCreate);
el('vault-refresh').addEventListener('click', refreshVaults);
el('vault-lock').addEventListener('click', () => { if (canDiscard()) lock(); });
el('vault-access-cancel').addEventListener('click', () => { selected = null; lock('Choose or create a vault.'); });
el('vault-add').addEventListener('click', () => openEditor());
el('account-cancel').addEventListener('click', () => { if (canDiscard()) resetEditor(); });
el('vault-search').addEventListener('input', renderAccounts);
el('account-reveal').addEventListener('click', () => {
    const reveal = el('account-password').type === 'password';
    el('account-password').type = reveal ? 'text' : 'password';
    el('account-reveal').textContent = reveal ? 'Hide' : 'Show';
    el('account-reveal').setAttribute('aria-pressed', String(reveal));
});
el('account-generate').addEventListener('click', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_+=';
    let password = '';
    const limit = 256 - 256 % alphabet.length;
    while (password.length < 20) {
        for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
            if (byte < limit) password += alphabet[byte % alphabet.length];
            if (password.length === 20) break;
        }
    }
    el('account-password').value = password; dirty = true; status('A 20-character password was generated. Save the account to keep it.');
});
el('account-draft-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(readAccount(), null, 2)); status('Plaintext account draft copied.'); }
    catch { status('Could not copy the draft. Select and copy the account fields manually.', true); }
});
for (const id of ['vault-change-cancel', 'vault-import-cancel']) el(id).addEventListener('click', () => {
    accessMode = null; window.clearSecretFactors(); renderState();
});
el('vault-backup').addEventListener('click', () => {
    if (!current || busy) return;
    const blob = new Blob([JSON.stringify({ nextId: current.id + 1, entries: [current] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `vault-${current.vaultId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); status('Encrypted vault backup downloaded.');
});
el('vault-restore').addEventListener('click', () => { if (!busy && !window.isCryptoBusy?.() && canDiscard()) el('vault-restore-file').click(); });
el('vault-restore-file').addEventListener('change', () => {
    const file = el('vault-restore-file').files[0];
    if (!file) return;
    run('Restoring encrypted backup…', async token => {
        try {
            if (file.size > MAX_VAULT_BYTES * 2) throw new Error('Backup is too large.');
            const parsed = JSON.parse(await file.text());
            if (epoch !== token) return;
            if (!Array.isArray(parsed.entries) || parsed.entries.length !== 1 || parsed.entries[0].type !== 'vault') throw new Error('Choose a backup exported with Encrypted backup.');
            const restored = vaultBody({ ...parsed.entries[0], revision: 0 });
            const saved = await passwordService.saveVault(restored);
            if (epoch !== token) return;
            vaults = [...vaults, { ...saved, children: saved.children || [] }];
            lock(); selected = vaults.find(vault => vault.id === saved.id);
            renderPicker(); renderState(); status('Encrypted backup restored. Enter its original credentials to unlock.');
        } catch (error) {
            if (epoch === token && error.status === 400 && error.message.includes('already exists')) {
                status('This vault already exists. Refresh and open it; restoration does not overwrite an existing vault.', true);
            } else throw error;
        } finally { el('vault-restore-file').value = ''; }
    });
});
window.addEventListener('workspacechange', ({ detail }) => { factors(); if (detail === 'vault' && !busy) refreshVaults(); });
for (const event of ['pointerdown', 'keydown', 'input']) document.addEventListener(event, armIdle, { passive: true });
window.addEventListener('pagehide', () => lock());
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
renderState(); refreshVaults();
