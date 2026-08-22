
// crypto_worker.js
// WebEncryptor v2 加密内核
//
// 方案 (三因子 + 单层 AEAD):
//   因子 A: 主口令 (password)
//   因子 B: 棋盘路径序列 (path, 来自 Interactive Color Grid 的点击顺序 + 颜色)
//   因子 C: 规则短语 (rulePhrase, 任意固定字符串, 不再是可执行代码)
//
//   1. 每次加密生成 16 字节随机盐 randomSalt, 随密文一起存储
//   2. saltMaterial = u32len(rulePhrase) ‖ rulePhrase ‖ u32len(path) ‖ path ‖ randomSalt
//   3. argonSalt    = BLAKE2b-128(saltMaterial)      (Argon2id 盐必须恰为 16 字节)
//   4. masterKey    = Argon2id(password, salt=argonSalt, ops=MODERATE, mem=MODERATE(256MiB), ALG=ARGON2ID13)
//   5. encKey       = HKDF-SHA256(IKM=masterKey, salt=randomSalt, info="WebEncryptor:enc:v1")
//   6. 单层 ChaCha20-Poly1305-IETF, AAD="WebEncryptor:v1", 随机 12 字节 IV
//   输出格式: WE1.<b64(盐)>.<b64(IV)>.<b64(密文)>.<b64(MAC)>
//
// 相比旧版 (多层 AES/ChaCha 套娃):
//   - 旧版攻击者每验证一次口令猜测只需 1 次 PBKDF2(10万次), 而合法用户要跑 (层数+1) 次;
//     新版把预算集中到一次 Argon2id (内存困难型 KDF), 攻击者每次猜测付出同样成本。
//   - 移除了 new Function 规则执行: 规则不再是 JS 代码, 消除了代码注入面以及
//     "注释格式导致口令静默失效" 的陷阱。
//   - 三个因子全部拼入 KDF 盐: 任一因子泄露, 其余因子仍然必须被猜中。
//
// 注意: WE1. 格式与旧版多层密文不兼容。旧密文需用旧版程序先解密, 再用本版重新加密。

importScripts('sodium.js'); // Load sodium.js

let sodiumInstance = null;

const sodiumReadyPromise = (async () => {
    if (typeof sodium === 'undefined' || typeof sodium.ready !== 'object') {
        // Fallback: wait for global sodium to be defined by importScripts
        await new Promise((resolveLoop, rejectLoop) => {
            let checks = 0;
            const interval = setInterval(() => {
                if (typeof sodium !== 'undefined' && typeof sodium.ready === 'object') {
                    clearInterval(interval);
                    resolveLoop();
                } else if (checks++ > 200) { // Timeout after 10 seconds
                    clearInterval(interval);
                    rejectLoop(new Error("sodium.js did not become available in time."));
                }
            }, 50);
        });
    }
    await sodium.ready;
    sodiumInstance = sodium; // Assign to the module-scoped variable
    self.postMessage({ status: 'success', action: 'worker_init_sodium_ready' });
    return sodiumInstance;
})().catch(e => {
    console.error("Sodium.js initialization failed in worker:", e);
    self.postMessage({ status: 'error', action: 'worker_init_sodium_failed', error: "Failed to initialize sodium.js. Crypto functions may fail." });
    sodiumInstance = null;
    throw e; // Propagate the error so the promise is rejected
});

// --- 常量 ---
const FORMAT_PREFIX = 'WE1.';          // 格式版本前缀
const SALT_LENGTH = 16;                // Argon2id 盐长度 (libsodium crypto_pwhash_SALTBYTES)
const IV_LENGTH = 12;                  // ChaCha20-Poly1305 IETF nonce 长度
const KEY_LENGTH = 32;                 // 256-bit
const TAG_LENGTH = 16;                 // 128-bit MAC
const HKDF_INFO = 'WebEncryptor:enc:v1';
const AAD = new TextEncoder().encode('WebEncryptor:v1');
const MAX_RULE_LENGTH = 2048;          // 规则短语长度上限 (字符)
const MAX_PATH_LENGTH = 65536;         // 棋盘路径字符串长度上限 (字符)
const MAX_PASSWORD_LENGTH = 4096;      // 口令长度上限 (字符)

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// --- 盐材料组装 (长度前缀消除拼接歧义, 可独立单测) ---
function buildSaltMaterial(rulePhraseStr, pathStr, randomSalt) {
    const ruleBytes = textEncoder.encode(rulePhraseStr);
    const pathBytes = textEncoder.encode(pathStr);
    const out = new Uint8Array(4 + ruleBytes.length + 4 + pathBytes.length + randomSalt.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, ruleBytes.length);
    out.set(ruleBytes, 4);
    view.setUint32(4 + ruleBytes.length, pathBytes.length);
    out.set(pathBytes, 8 + ruleBytes.length);
    out.set(randomSalt, 8 + ruleBytes.length + pathBytes.length);
    return out;
}

// --- 三因子 → 加密密钥 ---
async function deriveEncryptionKey(passwordStr, rulePhraseStr, pathStr, randomSalt) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized.");

    const saltMaterial = buildSaltMaterial(rulePhraseStr, pathStr, randomSalt);
    // BLAKE2b 单向压缩为 Argon2id 需要的 16 字节盐 (盐无需保密, 只需唯一)
    const argonSalt = sodium.crypto_generichash(SALT_LENGTH, saltMaterial, null);
    saltMaterial.fill(0);

    let masterKey;
    try {
        masterKey = sodium.crypto_pwhash(
            KEY_LENGTH,
            textEncoder.encode(passwordStr),
            argonSalt,
            sodium.crypto_pwhash_OPSLIMIT_MODERATE,   // 3 passes
            sodium.crypto_pwhash_MEMLIMIT_MODERATE,   // 256 MiB
            sodium.crypto_pwhash_ALG_ARGON2ID13
        );
    } catch (e) {
        argonSalt.fill(0);
        throw new Error(`Argon2id 密钥派生失败: ${(e && e.message) || e}`);
    }
    argonSalt.fill(0);

    // HKDF 做密钥分离/域分离 (为将来派生 "auth:v1" 等子密钥留好位置)
    const hkdfKey = await crypto.subtle.importKey("raw", masterKey, { name: "HKDF" }, false, ["deriveBits"]);
    masterKey.fill(0); // 尽力清零 (JS 内存管理下仅为心理安慰)
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: randomSalt, info: textEncoder.encode(HKDF_INFO) },
        hkdfKey,
        KEY_LENGTH * 8
    );
    return new Uint8Array(bits);
}

// --- 加密 (单层 ChaCha20-Poly1305) ---
async function encryptString(plaintextStr, passwordStr, rulePhraseStr, pathStr) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for encryption.");

    const plaintext = textEncoder.encode(plaintextStr);
    const randomSalt = new Uint8Array(SALT_LENGTH);
    crypto.getRandomValues(randomSalt);

    self.postMessage({ status: 'progress', action: 'encrypt', currentStep: 1, totalSteps: 2, stepName: '派生密钥 (Argon2id)' });
    const key = await deriveEncryptionKey(passwordStr, rulePhraseStr, pathStr, randomSalt);

    self.postMessage({ status: 'progress', action: 'encrypt', currentStep: 2, totalSteps: 2, stepName: '加密 (ChaCha20-Poly1305)' });
    const iv = new Uint8Array(IV_LENGTH);
    crypto.getRandomValues(iv);
    const { ciphertext, mac } = sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(
        plaintext,
        AAD,
        null, // nsec not used
        iv,
        key
    );

    const result = FORMAT_PREFIX
        + uint8ArrayToBase64(randomSalt) + '.'
        + uint8ArrayToBase64(iv) + '.'
        + uint8ArrayToBase64(ciphertext) + '.'
        + uint8ArrayToBase64(mac);

    key.fill(0); iv.fill(0); // 尽力清零
    return result;
}

// --- 密文解析 (严格校验) ---
function parseCiphertext(ciphertextStr) {
    if (typeof ciphertextStr !== 'string' || !ciphertextStr.startsWith(FORMAT_PREFIX)) {
        throw new Error('无法识别的密文格式: 不是本软件 v1 (WE1.) 格式。旧版多层加密的密文与本版不兼容, 需用旧版先解密。');
    }
    const parts = ciphertextStr.slice(FORMAT_PREFIX.length).split('.');
    if (parts.length !== 4) {
        throw new Error('密文格式错误: 应为 WE1.<盐>.<IV>.<密文>.<MAC> 共 4 段。');
    }
    const salt = base64ToUint8Array(parts[0]);
    const iv = base64ToUint8Array(parts[1]);
    const ct = base64ToUint8Array(parts[2]);
    const mac = base64ToUint8Array(parts[3]);
    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || mac.length !== TAG_LENGTH || ct.length === 0) {
        throw new Error('密文格式错误: 字段长度不合法。');
    }
    return { salt, iv, ct, mac };
}

// --- 解密 (单层 ChaCha20-Poly1305) ---
async function decryptString(ciphertextStr, passwordStr, rulePhraseStr, pathStr) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for decryption.");

    const { salt, iv, ct, mac } = parseCiphertext(ciphertextStr);

    self.postMessage({ status: 'progress', action: 'decrypt', currentStep: 1, totalSteps: 2, stepName: '派生密钥 (Argon2id)' });
    const key = await deriveEncryptionKey(passwordStr, rulePhraseStr, pathStr, salt);

    self.postMessage({ status: 'progress', action: 'decrypt', currentStep: 2, totalSteps: 2, stepName: '解密 (ChaCha20-Poly1305)' });
    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
        null, // nsec not used
        ct,
        mac,
        AAD,
        iv,
        key
    );
    key.fill(0); // 尽力清零

    if (plaintext === null) { // Sodium returns null on decryption/verification failure
        throw new Error('解密失败: 口令、规则短语或棋盘不匹配, 或密文已被篡改。');
    }
    return textDecoder.decode(plaintext);
}

// --- Worker 消息入口 ---
self.onmessage = async (e) => {
    let responsePayload;
    const data = e.data || {};
    const action = data.action;
    const plaintext = data.plaintext;
    const ciphertext = data.ciphertext;
    const password = data.password;
    // 规则短语与棋盘作为密钥因子: 去除首尾空白, 避免"多打一个空格导致解密失败"
    const rulePhrase = typeof data.rulePhrase === 'string' ? data.rulePhrase.trim() : data.rulePhrase;
    const path = typeof data.path === 'string' ? data.path.trim() : data.path;

    try {
        const sodium = await sodiumReadyPromise; // Ensure sodium is ready before proceeding
        if (!sodium) {
            throw new Error("Sodium.js failed to initialize. Cannot perform crypto operations.");
        }

        if (action === 'encrypt') {
            if (!plaintext || !password || !rulePhrase || !path) {
                throw new Error("加密参数缺失: 明文、口令、规则短语、棋盘均不能为空。");
            }
            if (password.length > MAX_PASSWORD_LENGTH || rulePhrase.length > MAX_RULE_LENGTH || path.length > MAX_PATH_LENGTH) {
                throw new Error(`输入过长: 口令≤${MAX_PASSWORD_LENGTH}, 规则短语≤${MAX_RULE_LENGTH}, 棋盘≤${MAX_PATH_LENGTH} 字符。`);
            }
            const result = await encryptString(plaintext, password, rulePhrase, path);
            responsePayload = { status: 'success', action, result };
        } else if (action === 'decrypt' || action === 'verify') {
            if (!ciphertext || !password || !rulePhrase || !path) {
                throw new Error("解密参数缺失: 密文、口令、规则短语、棋盘均不能为空。");
            }
            if (password.length > MAX_PASSWORD_LENGTH || rulePhrase.length > MAX_RULE_LENGTH || path.length > MAX_PATH_LENGTH) {
                throw new Error(`输入过长: 口令≤${MAX_PASSWORD_LENGTH}, 规则短语≤${MAX_RULE_LENGTH}, 棋盘≤${MAX_PATH_LENGTH} 字符。`);
            }
            const result = await decryptString(ciphertext, password, rulePhrase, path);
            responsePayload = { status: 'success', action, result };
        } else {
            throw new Error(`Unknown action: ${action}`);
        }
    } catch (err) {
        console.error(`Worker error during ${action || 'unknown_action'}:`, err);
        const errorMessage = (err && typeof err.message === 'string') ? err.message : 'An unknown error occurred in the worker.';
        responsePayload = { status: 'error', action: action || 'unknown_action', error: errorMessage };
    }
    self.postMessage(responsePayload);
};

// --- Base64 Utilities ---
function base64ToUint8Array(base64Str) {
    try {
        const binaryString = atob(base64Str);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    } catch (e) {
        console.error("base64ToUint8Array error:", e.message);
        throw new Error("Invalid Base64 string provided for conversion to Uint8Array.");
    }
}

function uint8ArrayToBase64(uint8Array) {
    try {
        let binaryString = '';
        const len = uint8Array.byteLength;
        for (let i = 0; i < len; i++) {
            binaryString += String.fromCharCode(uint8Array[i]);
        }
        return btoa(binaryString);
    } catch (e) {
        console.error("uint8ArrayToBase64 error:", e.message);
        throw new Error("Failed to convert Uint8Array to Base64 string.");
    }
}
