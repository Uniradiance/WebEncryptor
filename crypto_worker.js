
// crypto_worker.js

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
    console.log("Sodium is ready in worker.");
    self.postMessage({ status: 'success', action: 'worker_init_sodium_ready' });
    return sodiumInstance;
})().catch(e => {
    console.error("Sodium.js initialization failed in worker:", e);
    self.postMessage({ status: 'error', action: 'worker_init_sodium_failed', error: "Failed to initialize sodium.js. Crypto functions may fail." });
    sodiumInstance = null;
    throw e; // Propagate the error so the promise is rejected
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
    // Securely clear sensitive data
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
    // Securely clear sensitive data
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
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for encryption.");

    const { ciphertext, mac } = sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(
        plaintextUint8Array,
        null, // no additional data (AAD) for this layer
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
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for decryption.");

    const iv = dataWithIvCipherTag.slice(0, IV_LENGTH);
    const ciphertextPart = dataWithIvCipherTag.slice(IV_LENGTH, dataWithIvCipherTag.length - TAG_LENGTH_BYTES);
    const tagPart = dataWithIvCipherTag.slice(dataWithIvCipherTag.length - TAG_LENGTH_BYTES);

    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
        null, // nsec not used
        ciphertextPart,
        tagPart,
        null, // no additional data (AAD) for this layer
        iv,
        keyBytes
    );
    if (!plaintext) { // Sodium's decrypt_detached returns null on verification failure
        throw new Error("ChaCha20-Poly1305 layer decryption failed: Authentication tag mismatch or other error.");
    }
    return plaintext;
}

async function finalChacha20Poly1305Encrypt(plaintextUint8Array, keyBytes, ivBytes) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for final encryption.");

    const { ciphertext, mac } = sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(
        plaintextUint8Array,
        new Uint8Array(0), // AAD is empty for the final layer
        null, // nsec not used
        ivBytes,
        keyBytes
    );
    // Output format: base64(iv).base64(ciphertext).base64(mac)
    return uint8ArrayToBase64(ivBytes) + "." + uint8ArrayToBase64(ciphertext) + "." + uint8ArrayToBase64(mac);
}

async function initialChacha20Poly1305Decrypt(base64CiphertextWithDots, keyBytes) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for initial decryption.");

    const parts = base64CiphertextWithDots.split('.');
    if (parts.length !== 3) {
        throw new Error("Initial decryption failed: Invalid ciphertext format (expected 3 base64 parts separated by dots).");
    }
    const iv = base64ToUint8Array(parts[0]);
    const ciphertext = base64ToUint8Array(parts[1]);
    const mac = base64ToUint8Array(parts[2]);

    if (iv.length !== IV_LENGTH || mac.length !== TAG_LENGTH_BYTES) {
        throw new Error("Initial decryption failed: Invalid IV or MAC length after base64 decoding.");
    }

    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
        null, // nsec not used
        ciphertext,
        mac,
        new Uint8Array(0), // AAD is empty for the final layer
        iv,
        keyBytes
    );

    if (plaintext === null) { // Sodium returns null on decryption/verification failure
        throw new Error("Final ChaCha20-Poly1305 decryption failed: Authentication tag mismatch or other error.");
    }
    return plaintext; // This is Uint8Array
}

/**
 * Generates a binary rule sequence ('0' or '1's) from a seed number string.
 * '0' might represent AES, '1' might represent ChaCha20.
 * @param {string} seedNumberStr - The seed number as a string.
 * @returns {string[]} Array of '0's and '1's.
 */
function generateLayeringRules(seedNumberStr) {
    try {
        const seedBigInt = BigInt(seedNumberStr);
        if (seedBigInt < 0) throw new Error("Layer sequence seed must be a non-negative integer.");
        if (seedNumberStr.length > 1000) throw new Error("Layer sequence seed number string is too large (max 1000 digits).");

        const binarySequence = seedBigInt.toString(2);
        if (binarySequence.length > 100) throw new Error("Resulting binary sequence for rules is too long (max 100 layers defined by rules).");
        return binarySequence.split('');
    } catch (e) {
        throw new Error(`Invalid Layer Sequence Seed: ${e.message || "Not a valid large integer string."}`);
    }
}


async function deriveLayerSpecificMaterial(originalPasswordStr, pathStr, upperStr, lowerStr) {
    const originalPasswordBytes = textEncoder.encode(originalPasswordStr);
    // Create a mutable copy for potential in-place operations or zeroing
    let tempOriginalPasswordBytesView = originalPasswordBytes.slice();

    const pbkdf2OutputKeyLengthBits = 256;

    const layerPbkdfSalt = textEncoder.encode(pathStr);
    const layerHkdfSalt = textEncoder.encode(upperStr);
    const layerHkdfInfo = textEncoder.encode(lowerStr);

    const baseHkdfKeyForLayer = await pbkdf2DeriveBaseKeyForHkdf(
        tempOriginalPasswordBytesView,
        layerPbkdfSalt,
        PBKDF2_ITERATIONS,
        pbkdf2OutputKeyLengthBits
    );

    // Securely clear the temporary password view
    if (tempOriginalPasswordBytesView.fill) tempOriginalPasswordBytesView.fill(0);

    return await hkdfDeriveKeyAndIv(
        baseHkdfKeyForLayer,
        layerHkdfSalt,
        layerHkdfInfo,
        KEY_LENGTH_BYTES,
        IV_LENGTH
    );
}

/**
 * Transforms the password for a specific encryption layer using a JS rule.
 * This is a form of password obfuscation.
 * @param {string} passwordStr - The current password string.
 * @param {string} transformRuleJs - JS code string defining the transformation.
 * @param {number} roundIndex - The current layer/round index.
 * @returns {string} Base64 encoded transformed password.
 */
function transformPasswordForLayer(passwordStr, transformRuleJs, roundIndex) {
    const passwordBytes = textEncoder.encode(passwordStr);

    try {
        // transformRuleJs is expected to be a JS expression string like "byte => (byte + i) % 256"
        const wrappedFuncStr = `"use strict"; return data.map((byte, idx) => ${transformRuleJs});`;
        const userFunc = new Function('data', 'i', wrappedFuncStr); // 'i' here is the roundIndex
        const transformedBytes = userFunc(passwordBytes, roundIndex);

        if (!transformedBytes || typeof transformedBytes.map !== 'function' || !(transformedBytes instanceof Uint8Array || Array.isArray(transformedBytes))) {
            throw new Error("Password transformation function did not return a valid array/Uint8Array.");
        }
        // Ensure result is Uint8Array for String.fromCharCode.apply
        const finalBytes = Uint8Array.from(transformedBytes);

        const binaryString = String.fromCharCode.apply(null, finalBytes);
        return btoa(binaryString); // Base64 encode
    } catch (e) {
        console.error(`Error in password transformation rule at round ${roundIndex}:`, e);
        throw new Error(`Password Transformation Rule error (round ${roundIndex}): ${e.message}`);
    }
}

async function layeredEncrypt(plaintextStr, passwordStr, passwordTransformRuleJs, pathStr, upperStr, lowerStr) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for layered encryption.");

    let currentData = textEncoder.encode(plaintextStr);

    // Derive the layer sequence (e.g., '01011') from the passwordTransformRuleJs string
    const ruleBytes = textEncoder.encode(passwordTransformRuleJs);
    const layerSequenceSeedNumber = ruleBytes.reduce((acc, byteValue) => acc + byteValue, 0);
    const layerRules = generateLayeringRules(String(layerSequenceSeedNumber));

    const totalProgressSteps = layerRules.length + 1; // +1 for the final ChaCha layer

    for (let i = 0; i < layerRules.length; i++) {
        const transformedPassword = transformPasswordForLayer(passwordStr, passwordTransformRuleJs, i);
        const { key, iv } = await deriveLayerSpecificMaterial(transformedPassword, pathStr, upperStr, lowerStr);

        if (layerRules[i] === '0') { // Assuming '0' for AES
            currentData = await aesGcmLayerEncrypt(currentData, key, iv);
        } else { // Assuming '1' for ChaCha20-Poly1305
            currentData = await chacha20Poly1305LayerEncrypt(currentData, key, iv);
        }
        // Zero out key and iv after use if they are Uint8Array views and not needed anymore.
        // However, they are re-derived in the next iteration, so this might be optional.
        // key.fill(0); iv.fill(0); 
        self.postMessage({ status: 'progress', action: 'encrypt', currentStep: i + 1, totalSteps: totalProgressSteps });
    }

    // Final layer uses ChaCha20-Poly1305
    const finalTransformedPassword = transformPasswordForLayer(passwordStr, passwordTransformRuleJs, layerRules.length);
    const { key: finalKey, iv: finalIv } = await deriveLayerSpecificMaterial(finalTransformedPassword, pathStr, upperStr, lowerStr);
    const finalResultBase64 = await finalChacha20Poly1305Encrypt(currentData, finalKey, finalIv);
    // finalKey.fill(0); finalIv.fill(0);

    self.postMessage({ status: 'progress', action: 'encrypt', currentStep: totalProgressSteps, totalSteps: totalProgressSteps });

    // Securely clear intermediate data if it's not the original plaintext
    // (The original plaintextStr is not modified, currentData holds intermediate ciphertexts)
    const originalPlaintextBytes = textEncoder.encode(plaintextStr);
     if (currentData.length !== originalPlaintextBytes.length || !currentData.every((val, index) => val === originalPlaintextBytes[index])) {
        if (typeof currentData.fill === 'function') {
            currentData.fill(0);
        }
    }
    return finalResultBase64;
}

async function layeredDecrypt(base64Ciphertext, passwordStr, passwordTransformRuleJs, pathStr, upperStr, lowerStr) {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js not initialized for layered decryption.");

    // Derive the layer sequence (e.g., '01011') from the passwordTransformRuleJs string
    const ruleBytes = textEncoder.encode(passwordTransformRuleJs);
    const layerSequenceSeedNumber = ruleBytes.reduce((acc, byteValue) => acc + byteValue, 0);
    const layerRules = generateLayeringRules(String(layerSequenceSeedNumber));
    
    const totalProgressSteps = layerRules.length + 1; // +1 for the initial ChaCha layer

    // Initial layer uses ChaCha20-Poly1305
    const initialTransformedPassword = transformPasswordForLayer(passwordStr, passwordTransformRuleJs, layerRules.length);
    // IV for initialChacha20Poly1305Decrypt is part of base64CiphertextWithDots
    const { key: initialKey } = await deriveLayerSpecificMaterial(initialTransformedPassword, pathStr, upperStr, lowerStr);
    let currentData = await initialChacha20Poly1305Decrypt(base64Ciphertext, initialKey);
    // initialKey.fill(0);

    self.postMessage({ status: 'progress', action: 'decrypt', currentStep: 1, totalSteps: totalProgressSteps });

    try {
        for (let i = layerRules.length - 1; i >= 0; i--) {
            const transformedPassword = transformPasswordForLayer(passwordStr, passwordTransformRuleJs, i);
            const { key: layerKey, iv: layerIv } = await deriveLayerSpecificMaterial(transformedPassword, pathStr, upperStr, lowerStr);

            if (layerRules[i] === '0') { // Assuming '0' for AES
                currentData = await aesGcmLayerDecrypt(currentData, layerKey);
            } else { // Assuming '1' for ChaCha20-Poly1305
                currentData = await chacha20Poly1305LayerDecrypt(currentData, layerKey);
            }
            // layerKey.fill(0); layerIv.fill(0); // Optional: zero out after use
            self.postMessage({ status: 'progress', action: 'decrypt', currentStep: layerRules.length - i + 1, totalSteps: totalProgressSteps });
        }
        return textDecoder.decode(currentData);
    } finally {
        // Securely clear the final plaintext bytes or intermediate decrypted data
        if (currentData && typeof currentData.fill === 'function') {
            currentData.fill(0);
        }
    }
}

self.onmessage = async (e) => {
    let responsePayload;
    const { action, plaintext, ciphertext, password, passwordTransformRuleJs, path, upper, lower } = e.data;

    try {
        const sodium = await sodiumReadyPromise; // Ensure sodium is ready before proceeding
        if (!sodium) {
            throw new Error("Sodium.js failed to initialize. Cannot perform crypto operations.");
        }

        if (action === 'encrypt') {
            if (!plaintext || !password || !passwordTransformRuleJs || !path || !upper || !lower) {
                throw new Error("Missing parameters for encryption: plaintext, password, passwordTransformRuleJs, path, upper, and lower are required.");
            }
            const result = await layeredEncrypt(plaintext, password, passwordTransformRuleJs, path, upper, lower);
            responsePayload = { status: 'success', action, result };
        } else if (action === 'decrypt' | action === 'verify') {
            if (!ciphertext || !password || !passwordTransformRuleJs || !path || !upper || !lower) {
                throw new Error("Missing parameters for decryption: ciphertext, password, passwordTransformRuleJs, path, upper, and lower are required.");
            }
            const result = await layeredDecrypt(ciphertext, password, passwordTransformRuleJs, path, upper, lower);
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