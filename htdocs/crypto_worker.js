// crypto_worker.js
// WebEncryptor crypto core
//
// Scheme (three factors + single-layer AEAD):
//   Factor A: master password
//   Factor B: color-grid path sequence (click order + colors)
//   Factor C: hand-drawn pattern direction sequence (chain code from the pad)
//
//   1. Every encryption generates a 16-byte random salt stored with the
//      ciphertext.
//   2. saltMaterial = u32len(rulePhrase) || rulePhrase || u32len(path) || path
//      || randomSalt
//   3. argonSalt    = BLAKE2b-128(saltMaterial)   (Argon2 needs exactly 16 B)
//   4. masterKey    = Argon2id(password, argonSalt, OPSLIMIT_MODERATE,
//                      MEMLIMIT_MODERATE (256 MiB), ARGON2ID13)
//   5. encKey       = HKDF-SHA256(IKM=masterKey, salt=randomSalt,
//                      info="WebEncryptor:enc:v2")
//   6. single-layer ChaCha20-Poly1305-IETF, AAD="WebEncryptor:v2", 12-byte IV
//   Output: WE2.<b64(salt)>.<b64(iv)>.<b64(ct)>.<b64(mac)>

importScripts("sodium.js");

let sodiumInstance = null;

const sodiumReadyPromise = (async () => {
  if (typeof sodium === "undefined" || typeof sodium.ready !== "object") {
    // ImportScripts is synchronous so the global sodium should already exist,
    // but keep a bounded fallback poll for exotic environments.
    await new Promise((resolve, reject) => {
      let checks = 0;
      const interval = setInterval(() => {
        if (typeof sodium !== "undefined" && typeof sodium.ready === "object") {
          clearInterval(interval);
          resolve();
        } else if (checks++ > 200) {
          clearInterval(interval);
          reject(new Error("sodium.js did not become available in time."));
        }
      }, 50);
    });
  }
  await sodium.ready;
  sodiumInstance = sodium;
  self.postMessage({ status: "success", action: "worker_init_sodium_ready" });
  return sodiumInstance;
})().catch((e) => {
  console.error("Sodium.js initialization failed in worker:", e);
  self.postMessage({
    status: "error",
    action: "worker_init_sodium_failed",
    error: "Failed to initialize sodium.js. Crypto functions may fail.",
  });
  sodiumInstance = null;
  return null;
});

// --- constants ---
const FORMAT_PREFIX = "WE2.";
const SALT_LENGTH = 16; // libsodium crypto_pwhash_SALTBYTES
const IV_LENGTH = 12; // ChaCha20-Poly1305 IETF nonce length
const KEY_LENGTH = 32; // 256-bit
const TAG_LENGTH = 16; // 128-bit MAC
const HKDF_INFO = "WebEncryptor:enc:v2";
const AAD = new TextEncoder().encode("WebEncryptor:v2");
const MAX_RULE_LENGTH = 2048; // chain-code length cap (chars)
const MAX_PATH_LENGTH = 65536; // color-grid path length cap (chars)
const MAX_PASSWORD_LENGTH = 4096; // password length cap (chars)
const MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024;
// Base64 expansion plus salt, nonce, tag and separators.
const MAX_CIPHERTEXT_LENGTH = 4 * Math.ceil(MAX_PLAINTEXT_BYTES / 3) + 71;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// --- salt material assembly (length-prefixed to remove ambiguity) ---
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

// --- three factors -> encryption key ---
async function deriveEncryptionKey(passwordStr, rulePhraseStr, pathStr, randomSalt) {
  const sodium = await sodiumReadyPromise;
  if (!sodium) throw new Error("Sodium.js not initialized.");

  const saltMaterial = buildSaltMaterial(rulePhraseStr, pathStr, randomSalt);
  // BLAKE2b compresses the material to the 16 bytes Argon2 requires
  const argonSalt = sodium.crypto_generichash(SALT_LENGTH, saltMaterial, null);
  saltMaterial.fill(0);

  let masterKey;
  try {
    masterKey = sodium.crypto_pwhash(
      KEY_LENGTH,
      textEncoder.encode(passwordStr),
      argonSalt,
      sodium.crypto_pwhash_OPSLIMIT_MODERATE, // 3 passes
      sodium.crypto_pwhash_MEMLIMIT_MODERATE, // 256 MiB
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } catch (e) {
    argonSalt.fill(0);
    throw new Error(`Argon2id key derivation failed: ${(e && e.message) || e}`);
  }
  argonSalt.fill(0);

  // HKDF for key separation/domain separation.
  let hkdfKey;
  try {
    hkdfKey = await crypto.subtle.importKey("raw", masterKey, { name: "HKDF" }, false, ["deriveBits"]);
  } finally {
    masterKey.fill(0);
  }
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: randomSalt, info: textEncoder.encode(HKDF_INFO) },
    hkdfKey,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

// --- encryption (single-layer ChaCha20-Poly1305) ---
async function encryptString(plaintextStr, passwordStr, rulePhraseStr, pathStr, requestId) {
  const sodium = await sodiumReadyPromise;
  if (!sodium) throw new Error("Sodium.js not initialized for encryption.");

  const plaintext = textEncoder.encode(plaintextStr);
  const randomSalt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(randomSalt);

  self.postMessage({
    status: "progress",
    action: "encrypt",
    requestId,
    currentStep: 1,
    totalSteps: 2,
    stepName: "Deriving key (Argon2id)",
  });
  const key = await deriveEncryptionKey(passwordStr, rulePhraseStr, pathStr, randomSalt);

  self.postMessage({
    status: "progress",
    action: "encrypt",
    requestId,
    currentStep: 2,
    totalSteps: 2,
    stepName: "Encrypting (ChaCha20-Poly1305)",
  });
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);
  const { ciphertext, mac } = sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(
    plaintext,
    AAD,
    null, // nsec unused
    iv,
    key,
  );

  const result =
    FORMAT_PREFIX +
    uint8ArrayToBase64(randomSalt) +
    "." +
    uint8ArrayToBase64(iv) +
    "." +
    uint8ArrayToBase64(ciphertext) +
    "." +
    uint8ArrayToBase64(mac);

  key.fill(0);
  iv.fill(0);
  return result;
}

// --- ciphertext parsing (strict validation) ---
function parseCiphertext(ciphertextStr) {
  if (typeof ciphertextStr !== "string" || !ciphertextStr.startsWith(FORMAT_PREFIX)) {
    throw new Error(
      "Unrecognized ciphertext format: expected WE2.<salt>.<iv>.<ct>.<mac>.",
    );
  }
  const parts = ciphertextStr.slice(FORMAT_PREFIX.length).split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed ciphertext: expected WE2.<salt>.<iv>.<ct>.<mac> with 4 fields.");
  }
  const salt = base64ToUint8Array(parts[0]);
  const iv = base64ToUint8Array(parts[1]);
  const ct = base64ToUint8Array(parts[2]);
  const mac = base64ToUint8Array(parts[3]);
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || mac.length !== TAG_LENGTH ||
      ct.length === 0 || ct.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Malformed ciphertext: invalid field lengths.");
  }
  return { salt, iv, ct, mac };
}

// --- decryption (single-layer ChaCha20-Poly1305) ---
async function decryptString(ciphertextStr, passwordStr, rulePhraseStr, pathStr, requestId, action = "decrypt") {
  const sodium = await sodiumReadyPromise;
  if (!sodium) throw new Error("Sodium.js not initialized for decryption.");

  const { salt, iv, ct, mac } = parseCiphertext(ciphertextStr);

  self.postMessage({
    status: "progress",
    action,
    requestId,
    currentStep: 1,
    totalSteps: 2,
    stepName: "Deriving key (Argon2id)",
  });
  const key = await deriveEncryptionKey(passwordStr, rulePhraseStr, pathStr, salt);

  self.postMessage({
    status: "progress",
    action,
    requestId,
    currentStep: 2,
    totalSteps: 2,
    stepName: "Decrypting (ChaCha20-Poly1305)",
  });
  let plaintext;
  try {
    plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
      null, ct, mac, AAD, iv, key,
    );
    if (plaintext === null) throw new Error('Authentication failed');
  } catch (err) {
    throw new Error('Password, pattern or grid does not match, or the ciphertext was damaged.');
  } finally {
    key.fill(0);
  }
  return textDecoder.decode(plaintext);
}

// --- worker message entry ---
async function handleMessage(e) {
  let responsePayload;
  const data = e.data || {};
  const action = data.action;
  const requestId = data.requestId;
  const plaintext = data.plaintext;
  const ciphertext = data.ciphertext;
  const password = data.password;
  // pattern sequence and grid path are key factors: trim whitespace so that a
  // stray space cannot silently break decryption
  const rulePhrase = typeof data.rulePhrase === "string" ? data.rulePhrase.trim() : data.rulePhrase;
  const path = typeof data.path === "string" ? data.path.trim() : data.path;

  try {
    const sodium = await sodiumReadyPromise;
    if (!sodium) throw new Error("Sodium.js failed to initialize. Cannot perform crypto operations.");

    if ((action === "encrypt" || action === "decrypt" || action === "verify") &&
        (typeof rulePhrase !== 'string' || !/^[0-7]{1,64}$/.test(rulePhrase))) {
      throw new Error('Draw a valid pattern.');
    }
    if (action === "encrypt" || action === "decrypt" || action === "verify") {
      if (typeof password !== 'string' || typeof path !== 'string' ||
          typeof (action === 'encrypt' ? plaintext : ciphertext) !== 'string') {
        throw new Error('Data, password and grid must be strings.');
      }
    }
    if (action === "encrypt") {
      if (!plaintext || !password || !rulePhrase || !path) {
        throw new Error("Missing encryption parameters: plaintext, password, pattern and grid are all required.");
      }
      if (plaintext.length > MAX_PLAINTEXT_BYTES || textEncoder.encode(plaintext).byteLength > MAX_PLAINTEXT_BYTES) {
        throw new Error(`Plaintext too long: <= ${MAX_PLAINTEXT_BYTES} UTF-8 bytes (4 MiB).`);
      }
      if (password.length > MAX_PASSWORD_LENGTH || rulePhrase.length > MAX_RULE_LENGTH || path.length > MAX_PATH_LENGTH) {
        throw new Error(`Input too long: password <= ${MAX_PASSWORD_LENGTH}, pattern <= ${MAX_RULE_LENGTH}, grid <= ${MAX_PATH_LENGTH} characters.`);
      }
      const result = await encryptString(plaintext, password, rulePhrase, path, requestId);
      responsePayload = { status: "success", action, requestId, result };
    } else if (action === "decrypt" || action === "verify") {
      if (!ciphertext || !password || !rulePhrase || !path) {
        throw new Error("Missing decryption parameters: ciphertext, password, pattern and grid are all required.");
      }
      if (ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
        throw new Error(`Ciphertext too long: <= ${MAX_CIPHERTEXT_LENGTH} characters.`);
      }
      if (password.length > MAX_PASSWORD_LENGTH || rulePhrase.length > MAX_RULE_LENGTH || path.length > MAX_PATH_LENGTH) {
        throw new Error(`Input too long: password <= ${MAX_PASSWORD_LENGTH}, pattern <= ${MAX_RULE_LENGTH}, grid <= ${MAX_PATH_LENGTH} characters.`);
      }
      const result = await decryptString(ciphertext, password, rulePhrase, path, requestId, action);
      responsePayload = { status: "success", action, requestId, result };
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error(`Worker error during ${action || "unknown_action"}:`, err);
    const errorMessage = err && typeof err.message === "string" ? err.message : "An unknown error occurred in the worker.";
    responsePayload = { status: "error", requestId, action: action || "unknown_action", error: errorMessage };
  }
  self.postMessage(responsePayload);
}
// Web Crypto awaits can yield: serialize requests to bound KDF memory and
// keep progress/completion grouped even for direct Worker callers.
let queue = Promise.resolve();
self.onmessage = (e) => {
  queue = queue.then(() => handleMessage(e));
  return queue;
};

// --- base64 utilities (chunked: linear in size, avoids giant intermediate strings) ---
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
    const len = uint8Array.byteLength;
    const CHUNK = 0x8000; // 32 KiB: keeps batch size within call-stack limits
    const bytes = uint8Array;
    let binaryString = "";
    for (let i = 0; i < len; i += CHUNK) {
      const end = Math.min(i + CHUNK, len);
      binaryString += String.fromCharCode.apply(null, bytes.subarray(i, end));
    }
    return btoa(binaryString);
  } catch (e) {
    console.error("uint8ArrayToBase64 error:", e.message);
    throw new Error("Failed to convert Uint8Array to Base64 string.");
  }
}
