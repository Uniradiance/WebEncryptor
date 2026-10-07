// Loaded only inside crypto_worker.js. Raw vault keys never cross postMessage.
const VAULT_ITEM_BYTES = 64 * 1024;
const VAULT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WRAP_INFO = 'WebEncryptor:vault:wrap:v1';
let activeVaultKey = null;
let activeVaultId = null;

function vaultId(value) {
  if (typeof value !== 'string' || !VAULT_UUID.test(value)) throw new Error('Invalid vault or item identifier.');
  return value;
}
function vaultFactors(data) {
  if (typeof data.password !== 'string' || !data.password || data.password.length > MAX_PASSWORD_LENGTH ||
      typeof data.rulePhrase !== 'string' || !/^[0-7]{1,64}$/.test(data.rulePhrase) ||
      typeof data.path !== 'string' || !data.path.trim() || data.path.length > MAX_PATH_LENGTH) {
    throw new Error('Enter your password, draw the pattern and select the color grid.');
  }
  return [data.password, data.rulePhrase, data.path.trim()];
}
function vaultBase64(value) {
  const bytes = base64ToUint8Array(value);
  if (uint8ArrayToBase64(bytes) !== value) throw new Error('Invalid canonical Base64.');
  return bytes;
}
function vaultAAD(id, itemId) {
  return textEncoder.encode(JSON.stringify(['WebEncryptor:vault:item:v1', id, itemId]));
}
function clearVaultKey() {
  activeVaultKey?.fill(0);
  activeVaultKey = null;
  activeVaultId = null;
}
async function wrapVaultKey(key, id, data) {
  const sodium = await sodiumReadyPromise;
  const factors = vaultFactors(data);
  const header = uint8ArrayToBase64(textEncoder.encode(JSON.stringify({
    v: 1, vaultId: id, kdf: 'argon2id', ops: 3, mem: 268435456, factors: 2,
  })));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const protectionKey = await deriveEncryptionKey(...factors, salt, WRAP_INFO);
  try {
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(key,
      textEncoder.encode(`WebEncryptor:vault:wrap:v1.${header}`), null, nonce, protectionKey);
    return ['WVK1', header, uint8ArrayToBase64(salt), uint8ArrayToBase64(nonce), uint8ArrayToBase64(ct)].join('.');
  } finally { protectionKey.fill(0); }
}
async function unwrapVaultKey(envelope, id, data) {
  const sodium = await sodiumReadyPromise;
  const factors = vaultFactors(data);
  if (typeof envelope !== 'string' || envelope.length > 2048) throw new Error('Invalid encrypted vault key.');
  const p = envelope.split('.');
  if (p.length !== 5 || p[0] !== 'WVK1') throw new Error('Expected a WVK1 encrypted vault key.');
  const header = JSON.parse(textDecoder.decode(vaultBase64(p[1])));
  if (!header || Object.keys(header).sort().join(',') !== 'factors,kdf,mem,ops,v,vaultId' ||
      header.v !== 1 || header.vaultId !== id || header.kdf !== 'argon2id' ||
      header.ops !== 3 || header.mem !== 268435456 || header.factors !== 2) {
    throw new Error('Unsupported or mismatched vault key parameters.');
  }
  const [salt, nonce, ct] = p.slice(2).map(vaultBase64);
  if (salt.length !== 16 || nonce.length !== 24 || ct.length !== 48) throw new Error('Invalid vault key envelope lengths.');
  const protectionKey = await deriveEncryptionKey(...factors, salt, WRAP_INFO);
  try {
    const key = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct,
      textEncoder.encode(`WebEncryptor:vault:wrap:v1.${p[1]}`), nonce, protectionKey);
    if (!key || key.length !== 32) throw new Error('Invalid vault key.');
    return key;
  } catch { throw new Error('Password, pattern or grid does not match, or the vault key was damaged.'); }
  finally { protectionKey.fill(0); }
}
async function vaultItemKey(key, id, itemId) {
  const hkdf = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256',
    salt: new Uint8Array(32), info: vaultAAD(id, itemId)}, hkdf, 256));
}
function validateVaultAccount(account) {
  const fields = ['name', 'url', 'username', 'password', 'notes'];
  if (!account || typeof account !== 'object' || Array.isArray(account) ||
      Object.keys(account).length !== fields.length || fields.some(field => typeof account[field] !== 'string') ||
      !account.name.trim() || textEncoder.encode(JSON.stringify(account)).length > VAULT_ITEM_BYTES) {
    throw new Error('Enter an account name. Account fields must be text and total at most 64 KiB.');
  }
  return account;
}
async function encryptVaultAccount(key, id, itemId, account) {
  const sodium = await sodiumReadyPromise;
  const plaintext = textEncoder.encode(JSON.stringify(validateVaultAccount(account)));
  const subkey = await vaultItemKey(key, id, vaultId(itemId));
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, vaultAAD(id, itemId), null, nonce, subkey);
    return { id: itemId, name: '', description: '', password: `WVI1.${uint8ArrayToBase64(nonce)}.${uint8ArrayToBase64(ct)}` };
  } finally { subkey.fill(0); plaintext.fill(0); }
}
async function decryptVaultAccount(key, id, child) {
  const sodium = await sodiumReadyPromise;
  if (!child || typeof child.password !== 'string' || child.password.length > 87443 ||
      child.name !== '' || child.description !== '') throw new Error('Invalid encrypted vault item.');
  const itemId = vaultId(child.id);
  const p = child.password.split('.');
  if (p.length !== 3 || p[0] !== 'WVI1') throw new Error('Expected a WVI1 encrypted item.');
  const nonce = vaultBase64(p[1]), ct = vaultBase64(p[2]);
  if (nonce.length !== 24 || ct.length <= 16 || ct.length > VAULT_ITEM_BYTES + 16) throw new Error('Invalid encrypted item lengths.');
  const subkey = await vaultItemKey(key, id, itemId);
  let plaintext;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, vaultAAD(id, itemId), nonce, subkey);
    return { id: itemId, account: validateVaultAccount(JSON.parse(textDecoder.decode(plaintext))) };
  } catch { throw new Error('A vault item was damaged or moved from another account or vault.'); }
  finally { subkey.fill(0); plaintext?.fill(0); }
}
async function handleVaultAction(data) {
  if (data.action === 'vault_lock') { clearVaultKey(); return true; }
  const id = vaultId(data.vaultId);
  if (data.action === 'vault_create') {
    const key = crypto.getRandomValues(new Uint8Array(32));
    try {
      const password = await wrapVaultKey(key, id, data);
      clearVaultKey(); activeVaultKey = key; activeVaultId = id;
      return { vaultId: id, password };
    } catch (err) { key.fill(0); throw err; }
  }
  if (data.action === 'vault_unlock') {
    clearVaultKey();
    const key = await unwrapVaultKey(data.wrappedKey, id, data);
    try {
      if (!Array.isArray(data.children) || data.children.length > 1000) throw new Error('Invalid vault children.');
      const seen = new Set(), items = [];
      for (const child of data.children) {
        if (seen.has(child.id)) throw new Error('Duplicate vault item identifier.');
        seen.add(child.id);
        items.push(await decryptVaultAccount(key, id, child));
      }
      activeVaultKey = key; activeVaultId = id;
      return items;
    } catch (err) { key.fill(0); throw err; }
  }
  if (!activeVaultKey || activeVaultId !== id) throw new Error('Unlock this vault first.');
  if (data.action === 'vault_rewrap') {
    // Rewrapping the same key lets an old envelope + old credentials decrypt
    // future items. Rotate the data key and every child as one saved revision.
    if (!Array.isArray(data.children) || data.children.length > 1000) throw new Error('Invalid vault children.');
    const key = crypto.getRandomValues(new Uint8Array(32));
    try {
      const password = await wrapVaultKey(key, id, data);
      const seen = new Set(), children = [];
      for (const child of data.children) {
        if (seen.has(child.id)) throw new Error('Duplicate vault item identifier.');
        seen.add(child.id);
        const item = await decryptVaultAccount(activeVaultKey, id, child);
        children.push(await encryptVaultAccount(key, id, item.id, item.account));
      }
      clearVaultKey(); activeVaultKey = key; activeVaultId = id;
      return { password, children };
    } catch (err) { key.fill(0); throw err; }
  }
  if (data.action === 'vault_encrypt') return encryptVaultAccount(activeVaultKey, id, data.itemId, data.account);
  if (data.action === 'vault_decrypt') return decryptVaultAccount(activeVaultKey, id, data.child);
  if (data.action === 'vault_import') {
    const factors = vaultFactors(data);
    if (typeof data.ciphertext !== 'string' || data.ciphertext.length > MAX_CIPHERTEXT_LENGTH) throw new Error('Invalid independent ciphertext.');
    const plaintext = await decryptString(data.ciphertext, ...factors, data.requestId);
    return encryptVaultAccount(activeVaultKey, id, data.itemId,
      { name: data.name, url: '', username: '', password: plaintext, notes: data.notes || '' });
  }
  throw new Error('Unknown vault operation.');
}
