
// crypto_worker.js

importScripts('sodium.js'); // Load sodium.js

let sodiumInstanceInternal = null;

const sodiumReadyPromiseInternal = (async () => {
    if (typeof sodium === 'undefined' || typeof sodium.ready !== 'object') {
        // Fallback: wait for global sodium to be defined by importScripts
        // This might happen if importScripts is not fully synchronous in all worker contexts
        // or if sodium.js itself has async parts before 'sodium.ready' is available.
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
    sodiumInstanceInternal = sodium; // Assign to the module-scoped variable
    console.log("Sodium is ready in worker.");
    self.postMessage({ status: 'success', action: 'worker_init_sodium_ready' });
    return sodiumInstanceInternal;
})().catch(e => {
    console.error("Sodium.js initialization failed in worker:", e);
    self.postMessage({ status: 'error', action: 'worker_init_sodium_failed', error: "Failed to initialize sodium.js. Crypto functions may fail." });
    sodiumInstanceInternal = null;
    throw e;
});


const IV_LENGTH = 12;
const KEY_LENGTH_BYTES = 32;
const TAG_LENGTH_BYTES = 16;
const PBKDF2_ITERATIONS = 100000;


const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function pbkdf2DeriveBaseKeyForHkdf(passwordBytes, saltBytes, iterations, keyLengthInBits) {
    const importedPasswordKey = await crypto.subtle.importKey(
        "raw",
        passwordBytes,
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: saltBytes,
            iterations: iterations,
            hash: "SHA-256",
        },
        importedPasswordKey,
        keyLengthInBits
    );
    const hkdfBaseKey = await crypto.subtle.importKey(
        "raw",
        derivedBits,
        { name: "HKDF" },
        false,
        ["deriveKey", "deriveBits"]
    );
    if (derivedBits instanceof ArrayBuffer) {
        new Uint8Array(derivedBits).fill(0);
    }
    return hkdfBaseKey;
}

async function hkdfDeriveKeyAndIv(baseHkdfKey, saltBytes, infoBytes, keyLen, ivLen) {
    const totalLengthBytes = keyLen + ivLen;
    const derivedBytesArrayBuffer = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes },
        baseHkdfKey,
        totalLengthBytes * 8
    );
    const derivedBytes = new Uint8Array(derivedBytesArrayBuffer);
    const key = derivedBytes.slice(0, keyLen);
    const iv = derivedBytes.slice(keyLen, totalLengthBytes);
    derivedBytes.fill(0);
    return { key, iv };
}

async function aesGcmLayerEncrypt(plaintext, keyBytes, ivBytes) {
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    const ciphertextBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivBytes, tagLength: TAG_LENGTH_BYTES * 8 },
        cryptoKey,
        plaintext
    );
    const result = new Uint8Array(IV_LENGTH + ciphertextBuffer.byteLength);
    result.set(ivBytes, 0);
    result.set(new Uint8Array(ciphertextBuffer), IV_LENGTH);
    return result;
}

async function aesGcmLayerDecrypt(dataWithIvAndTag, keyBytes) {
    const iv = dataWithIvAndTag.slice(0, IV_LENGTH);
    const ciphertextWithTag = dataWithIvAndTag.slice(IV_LENGTH);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintextBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, tagLength: TAG_LENGTH_BYTES * 8 },
        cryptoKey,
        ciphertextWithTag
    );
    return new Uint8Array(plaintextBuffer);
}

async function chacha20Poly1305LayerEncrypt(plaintextUint8Array, keyBytes, ivBytes) {
    const sodium = await sodiumReadyPromiseInternal;
    if (!sodium) throw new Error("Sodium.js not initialized for encryption.");

    const { ciphertext, mac } = sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(
        plaintextUint8Array,
        null, // no additional data for layer
        null, // nsec not used
        ivBytes,
        keyBytes
    );

    const result = new Uint8Array(IV_LENGTH + ciphertext.length + TAG_LENGTH_BYTES);
    result.set(ivBytes, 0);
    result.set(ciphertext, IV_LENGTH);
    result.set(mac, IV_LENGTH + ciphertext.length);
    return result;
}

async function chacha20Poly1305LayerDecrypt(dataWithIvCipherTag, keyBytes) {
    const sodium = await sodiumReadyPromiseInternal;
    if (!sodium) throw new Error("Sodium.js not initialized for decryption.");

    const iv = dataWithIvCipherTag.slice(0, IV_LENGTH);
    const ciphertextPart = dataWithIvCipherTag.slice(IV_LENGTH, dataWithIvCipherTag.length - TAG_LENGTH_BYTES);
    const tagPart = dataWithIvCipherTag.slice(dataWithIvCipherTag.length - TAG_LENGTH_BYTES);

    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
        null, // nsec not used
        ciphertextPart,
        tagPart,
        null, // no additional data for layer
        iv,
        keyBytes
    );
    if (!plaintext) { // Sodium's decrypt_detached returns null on verification failure
        throw new Error("ChaCha20-Poly1305 layer decryption failed: Authentication tag mismatch or other error.");
    }
    return plaintext;
}

async function finalChacha20Poly1305Encrypt(plaintextUint8Array, keyBytes, ivBytes) {
    const sodium = await sodiumReadyPromiseInternal;
    if (!sodium) throw new Error("Sodium.js not initialized for final encryption.");

    const { ciphertext, mac } = sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(
        plaintextUint8Array,
        new Uint8Array(0), // AAD is empty for final layer as per original
        null, // nsec not used
        ivBytes,
        keyBytes
    );
    // Replicate the original dot-separated base64 format
    return uint8ArrayToB64(ivBytes) + "." + uint8ArrayToB64(ciphertext) + "." + uint8ArrayToB64(mac);
}

async function initialChacha20Poly1305Decrypt(base64CiphertextWithDots, keyBytes) {
    const sodium = await sodiumReadyPromiseInternal;
    if (!sodium) throw new Error("Sodium.js not initialized for initial decryption.");

    const parts = base64CiphertextWithDots.split('.');
    if (parts.length !== 3) {
        throw new Error("Initial decryption failed: Invalid ciphertext format.");
    }
    const iv = b64ToUint8Array(parts[0]);
    const ciphertext = b64ToUint8Array(parts[1]);
    const mac = b64ToUint8Array(parts[2]);

    if (iv.length !== IV_LENGTH || mac.length !== TAG_LENGTH_BYTES) {
        throw new Error("Initial decryption failed: Invalid IV or MAC length after decoding.");
    }

    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
        null, // nsec not used
        ciphertext,
        mac,
        new Uint8Array(0), // AAD is empty
        iv,
        keyBytes
    );

    if (plaintext === null) { // Sodium returns null on decryption/verification failure
        throw new Error("Final ChaCha20-Poly1305 decryption failed: Authentication tag mismatch or other error.");
    }
    return plaintext; // This is Uint8Array
}


function generateRules(trajectoryA) {
    try {
        const numA = BigInt(trajectoryA);
        if (numA < 0) throw new Error("Nesting rule must be a non-negative integer.");
        if (trajectoryA.length > 1000) throw new Error("Nesting rule number is too large (max 1000 digits).");
        const binaryA = numA.toString(2);
        if (binaryA.length > 100) throw new Error("Resulting binary for rules is too long (max 100 layers defined by rules).");
        return binaryA.split('');
    } catch (e) {
        throw new Error(`Invalid Nesting Rule A: ${e.message || "Not a valid large integer string."}`);
    }
}

// applyUserFunction remains unchanged as it's about general JS execution

async function deriveLayerSpecificMaterial(originalPasswordStr, path, upper, lower) {
    const originalPasswordBytes = textEncoder.encode(originalPasswordStr);
    let tempOriginalPasswordBytesView = originalPasswordBytes.slice();

    const pbkdf2OutputKeyLengthBits = 256;

    // Assuming applyUserFunction for salt/info generation is stable or not the focus of this change
    const layerPbkdfSalt = textEncoder.encode(path);
    const layerHkdfSalt = textEncoder.encode(upper);
    const layerHkdfInfo = textEncoder.encode(lower);


    const baseHkdfKeyForLayer = await pbkdf2DeriveBaseKeyForHkdf(
        tempOriginalPasswordBytesView,
        layerPbkdfSalt,
        PBKDF2_ITERATIONS,
        pbkdf2OutputKeyLengthBits
    );

    if (tempOriginalPasswordBytesView.fill) tempOriginalPasswordBytesView.fill(0);

    return await hkdfDeriveKeyAndIv(
        baseHkdfKeyForLayer,
        layerHkdfSalt,
        layerHkdfInfo,
        KEY_LENGTH_BYTES,
        IV_LENGTH
    );
}

function encryptString(str, funcStr, index) {
    // 将字符串转换为 Uint8Array（UTF-8 编码）
    const encoder = new TextEncoder();
    const uint8Array = encoder.encode(str);

    try {
        const wrappedFuncStr = `"use strict"; return data.map(byte => ${funcStr});`;
        const userFunc = new Function('data', 'i', wrappedFuncStr);
        let result = userFunc(uint8Array, index);

        // 将处理后的 Uint8Array 转换为 Latin1 编码的字符串
        const binaryString = String.fromCharCode.apply(null, result);
        // 编码成 Base64
        const base64String = btoa(binaryString);

        return base64String;
    } catch (e) {
        console.error("Error in user-defined password obfuscation function at round " + index + ":", e);
        throw new Error(`Password Obfuscation function error (round ${index}): ${e.message}`);
    }
}

async function layeredEncrypt(plaintextStr, passwordStr, RuleA, path, upper, lower) {
    const sodium = await sodiumReadyPromiseInternal;
    if (!sodium) throw new Error("Sodium not initialized for encryption.");

    let currentData = textEncoder.encode(plaintextStr);
    const nestingRuleArr = textEncoder.encode(RuleA);
    const rules = generateRules(nestingRuleArr.reduce((acc, value) => acc + value, 0));

    let currentProgress = 0;
    const totalProgressSteps = rules.length + 1;

    for (let i = 0; i < rules.length; i++) {
        const encrypted = encryptString(passwordStr, RuleA, i);
        const { key, iv } = await deriveLayerSpecificMaterial(encrypted, path, upper, lower);

        if (rules[i] === '0') {
            currentData = await aesGcmLayerEncrypt(currentData, key, iv);
        } else {
            currentData = await chacha20Poly1305LayerEncrypt(currentData, key, iv);
        }
        currentProgress++;
        self.postMessage({ status: 'progress', action: 'encrypt', currentStep: currentProgress, totalSteps: totalProgressSteps });
    }

    const encrypted = encryptString(passwordStr, RuleA, rules.length);
    const { key, iv } = await deriveLayerSpecificMaterial(encrypted, path, upper, lower);
    const finalResultBase64 = await finalChacha20Poly1305Encrypt(currentData, key, iv);

    currentProgress++;
    self.postMessage({ status: 'progress', action: 'encrypt', currentStep: Math.min(currentProgress, totalProgressSteps), totalSteps: totalProgressSteps });

    if (currentData && typeof currentData.fill === 'function') {
        const originalPlaintextBytes = textEncoder.encode(plaintextStr);
        let isOriginalData = currentData.length === originalPlaintextBytes.length && currentData.every((val, index) => val === originalPlaintextBytes[index]);
        if (!isOriginalData) {
            currentData.fill(0);
        }
    }

    return finalResultBase64;
}

async function layeredDecrypt(base64Ciphertext, passwordStr, RuleA, path, upper, lower) {
    const sodium = await sodiumReadyPromiseInternal;
    if (!sodium) throw new Error("Sodium not initialized for decryption.");

    const nestingRuleArr = textEncoder.encode(RuleA);
    const rules = generateRules(nestingRuleArr.reduce((acc, value) => acc + value, 0));

    const encrypted = encryptString(passwordStr, RuleA, rules.length);
    const { key } = await deriveLayerSpecificMaterial(encrypted, path, upper, lower); // IV from final layer not directly used by initialChacha20Poly1305Decrypt as it's in the ciphertext string

    let currentProgress = 0;
    const totalProgressSteps = rules.length + 1;

    let currentData = await initialChacha20Poly1305Decrypt(base64Ciphertext, key);

    currentProgress++;
    self.postMessage({ status: 'progress', action: 'decrypt', currentStep: currentProgress, totalSteps: totalProgressSteps });

    for (let i = rules.length - 1; i >= 0; i--) {
        const encrypted = encryptString(passwordStr, RuleA, i);
        const { key: layerKey, iv: layerIv } = await deriveLayerSpecificMaterial(encrypted, path, upper, lower); // IV needed for layer decryption
        if (rules[i] === '0') {
            currentData = await aesGcmLayerDecrypt(currentData, layerKey);
        } else {
            currentData = await chacha20Poly1305LayerDecrypt(currentData, layerKey); // layerKey and implicit IV from data
        }
        currentProgress++;
        self.postMessage({ status: 'progress', action: 'decrypt', currentStep: currentProgress, totalSteps: totalProgressSteps });
    }

    try {
        return textDecoder.decode(currentData);
    } finally {
        if (currentData && typeof currentData.fill === 'function') currentData.fill(0);
    }
}

self.onmessage = async (e) => {
    let response;
    const { action, plaintext, ciphertext, password, nestingRuleA, path, upper, lower } = e.data;

    try {
        const sodium = await sodiumReadyPromiseInternal;
        if (!sodium) {
            throw new Error("Sodium.js failed to initialize. Cannot perform crypto operations.");
        }

        if (action === 'encrypt') {
            if (!plaintext || !password || !nestingRuleA || !path || !upper || !lower) {
                throw new Error("Missing parameters for encryption: Data, Password, Nesting Rule, and Obfuscation Function are required.");
            }
            const result = await layeredEncrypt(plaintext, password, nestingRuleA, path, upper, lower);
            response = { status: 'success', action, result };
        } else if (action === 'decrypt') {
            if (!ciphertext || !password || !nestingRuleA || !path || !upper || !lower) {
                throw new Error("Missing parameters for decryption.");
            }
            const result = await layeredDecrypt(ciphertext, password, nestingRuleA, path, upper, lower);
            response = { status: 'success', action, result };
        } else {
            throw new Error(`Unknown action: ${action}`);
        }
    } catch (err) {
        console.error(`Worker error during ${action}:`, err);
        const errorMessage = (err && typeof err.message === 'string') ? err.message : 'An unknown error occurred';
        response = { status: 'error', action: action || 'unknown', error: errorMessage };
    }
    self.postMessage(response);
};

// Base64 to Uint8Array and vice-versa (worker context, so no DOM)
// These are standard Base64, compatible with sodium.to_base64(..., sodium.base64_variants.ORIGINAL)
// and sodium.from_base64(..., sodium.base64_variants.ORIGINAL)
// For simplicity and minimal change, keeping these helpers if they are correct.
// sodium.js itself uses atob/btoa for its base64 helpers if TextEncoder/Decoder are not available for all paths.
function b64ToUint8Array(b64) {
    try {
        const byteString = atob(b64);
        const len = byteString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = byteString.charCodeAt(i);
        }
        return bytes;
    } catch (e) {
        console.error("b64ToUint8Array error:", e);
        throw new Error("Invalid Base64 string for Uint8Array conversion.");
    }
}

function uint8ArrayToB64(arr) {
    try {
        let binary = '';
        const len = arr.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(arr[i]);
        }
        return btoa(binary);
    } catch (e) {
        console.error("uint8ArrayToB64 error:", e);
        throw new Error("Failed to convert Uint8Array to Base64.");
    }
}
