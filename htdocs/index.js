
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js'; // Ensure .js extension
import { passwordService } from './password_service.js';
import { OperationState } from './operation_state.js';
import { createSignaturePad } from './SignaturePad.js';

const getElement = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element with id ${id} not found.`);
    return el;
};

// Shared Input/Output Elements (merged Encrypt/Decrypt page)
const plaintextInput = getElement('plaintext');
const passwordInput = getElement('passwordEncrypt');
const ChessboardInput = getElement('ChessboardEncrypt');
const actionButton = getElement('actionButton');
const cryptoOutput = getElement('cryptoOutput');
const cryptoOutputHeading = getElement('cryptoOutputHeading');
const copyCiphertextButton = getElement('copyCiphertextButton');
const saveToManagerButton = getElement('saveToManagerButton');

const ciphertextInput = getElement('ciphertextInput');
const encryptCard = getElement('encryptCard');
const decryptCard = getElement('decryptCard');

// Generate Password Elements
const showGeneratePasswordModalButton = document.getElementById('showGeneratePasswordModalButton');
const passwordGeneratorModal = document.getElementById('passwordGeneratorModal');
const closePasswordModalButton = document.getElementById('closePasswordModalButton');
const modalOptionButtons = document.querySelectorAll('.modal-option-button');
const pastePlaintextButton = document.getElementById('pastePlaintextButton');
const pasteCiphertextButton = document.getElementById('pasteCiphertextButton');

// Decryption Result Floating Window
const decryptResultDialog = getElement('decryptResultDialog');
const decryptResultText = getElement('decryptResultText');
const closeDecryptResultActionButton = getElement('closeDecryptResultActionButton');

// UI State Elements
const loadingIndicator = getElement('loadingIndicator');
const errorDisplay = getElement('errorDisplay');
const progressBarContainer = getElement('progressBarContainer');
const progressBar = getElement('progressBar');
const progressText = getElement('progressText');

const modeButtons = document.querySelectorAll('.mode-button');

// Menu
const moreOptionsBtn = document.getElementById('moreOptionsButton');
const moreOptionsMenu = document.getElementById('moreOptionsMenu');
const shutdownButton = document.getElementById('shutdownButton');

let cryptoWorker = null;
const operations = new OperationState();
let resultKind = null;
let uiTimers = [];
window.isCryptoBusy = () => operations.busy;

function cancelUITimers() {
    uiTimers.forEach(clearTimeout);
    uiTimers = [];
}
function later(fn, delay) {
    uiTimers.push(setTimeout(() => { if (!operations.busy) fn(); }, delay));
}
function syncBusyUI() {
    const busy = operations.busy;
    actionButton.disabled = busy || !operations.ready;
    modeButtons.forEach(btn => { btn.disabled = busy; });
    saveToManagerButton.disabled = busy || resultKind !== 'encrypt';
    copyCiphertextButton.disabled = busy || !resultKind;
    [passwordInput, plaintextInput, ciphertextInput, pastePlaintextButton,
        pasteCiphertextButton, showGeneratePasswordModalButton, shutdownButton].forEach(el => { el.disabled = busy; });
    window.reactAppRef.current?.setLocked?.(busy);
    sigPad.setLocked(busy);
    document.querySelectorAll('.use-for-decrypt-btn').forEach(btn => {
        btn.disabled = busy || btn.closest('.pm-card')?.dataset.pending === 'true';
    });
}

// Current operation mode: 'encrypt' | 'decrypt'
let currentMode = 'encrypt';

function displayError(message) {
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
    loadingIndicator.style.display = 'none'; // Ensure loading indicator is hidden on error
}

function clearError() {
    errorDisplay.textContent = '';
    errorDisplay.style.display = 'none';
}

function resetUIState(errorMessage = null, successMessage = null) {
    syncBusyUI();
    cancelUITimers();

    later(() => {
        loadingIndicator.style.display = 'none';
        progressBarContainer.style.display = 'none';
        progressBar.style.width = '0%';
        progressText.textContent = '';
    }, errorMessage ? 0 : 5000);

    if (errorMessage) {
        displayError(errorMessage);
    } else {
        clearError(); // Clear previous errors if no new one
    }

    if (successMessage) {
        // Display temporary success message if needed (e.g., for validation)
        progressText.textContent = successMessage;
        progressBarContainer.style.display = 'block'; // Show progress bar area for this message
        later(() => {
            if (progressText.textContent === successMessage) {
                progressText.textContent = '';
                // Only hide progress bar if it's not showing another message (e.g. error)
                if (errorDisplay.style.display === 'none') {
                    progressBarContainer.style.display = 'none';
                }
            }
        }, 2500);
    }
}

function startProcessing(message) {
    cancelUITimers();
    syncBusyUI();
    clearError();
    loadingIndicator.style.display = 'none'; // Hide loading indicator if it was shown
    progressBarContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.textContent = message;
    actionButton.disabled = true;
}

// Switch between the mutually exclusive input panes (Data to Encrypt / Ciphertext).
// Only visibility changes: textarea contents are preserved.
function setMode(mode) {
    if (operations.busy) return false;
    if (mode !== currentMode) { cryptoOutput.innerText = ''; resultKind = null; }
    currentMode = mode === 'decrypt' ? 'decrypt' : 'encrypt';
    const isEncrypt = currentMode === 'encrypt';

    modeButtons.forEach(btn => {
        const isActive = btn.dataset.mode === currentMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    encryptCard.classList.toggle('active', isEncrypt);
    decryptCard.classList.toggle('active', !isEncrypt);

    cryptoOutputHeading.textContent = isEncrypt ? 'Ciphertext (Base64):' : 'Decrypted Plaintext:';
    cryptoOutput.setAttribute('aria-label', isEncrypt ? 'Encrypted ciphertext in Base64' : 'Decrypted plaintext');
    actionButton.title = isEncrypt ? 'Encrypt Data' : 'Decrypt Data';
    actionButton.setAttribute('aria-label', isEncrypt ? 'Encrypt data' : 'Decrypt data');
    saveToManagerButton.style.display = isEncrypt ? '' : 'none';
    syncBusyUI();
    return true;
}

// Expose it to global scope for other modules (e.g. Password Manager "Use for Decryption")
window.switchCryptoMode = setMode;

modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        setMode(btn.dataset.mode);
    });
});

// Sub-tabs below the factors section: "Data Panel" ⇄ "Password Manager".
// The three secret factors stay visible while switching.
const tabs = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

function switchToTab(tabId) {
    tabs.forEach(t => {
        const isActive = t.dataset.tab === tabId;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    tabContents.forEach(content => {
        content.classList.toggle('active', content.id === tabId);
    });
    // Fresh manager data every time its tab is opened (e.g. saved from
    // another browser tab since the last visit).
    if (tabId === 'manager' && window.refreshPasswordList) {
        window.refreshPasswordList();
    }
    // Tabs never reset the active job, its progress, or its result.
}
// Expose it to global scope for other modules (e.g. the Password Manager
// "jump to Data Panel" flow).
window.switchToTab = switchToTab;

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        switchToTab(tab.getAttribute('data-tab'));
    });
});

// Smoothly scroll to a page section (used by the Password Manager when a
// card asks to "jump" to the Data Panel after switching to its tab).
window.scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};

// --- rule factor (factor C): hand-drawn pattern -> chain-code sequence ---
const signaturePadCrypto = getElement('signaturePadCrypto');
const sigPad = createSignaturePad(signaturePadCrypto);

function getRuleFactor(requireVerified = false) {
    if (requireVerified && !sigPad.isVerified()) {
        return { ok: false, error: 'Redraw your pattern and confirm the match before encrypting.' };
    }
    const seq = sigPad.getSequence();
    if (!seq) {
        return { ok: false, error: sigPad.getStatus() || 'Draw your pattern on the pad first (at least 10 segments).' };
    }
    return { value: seq, ok: true };
}

function getChessboardData(boardId, type, isUpperHalf = false) {
    if (!window.reactAppRef || !window.reactAppRef.current) {
        throw new Error(`React App Ref for board '${boardId}' not found or not mounted.`);
    }
    const boardComponent = window.reactAppRef.current;
    let result = null;

    if (type === 'full') {
        if (typeof boardComponent.getFullData !== 'function') {
            throw new Error(`getFullData method not found on board '${boardId}'.`);
        }
        result = boardComponent.getFullData();
    } else if (type === 'half') {
        if (typeof boardComponent.getHalfData !== 'function') {
            throw new Error(`getHalfData method not found on board '${boardId}'.`);
        }
        result = boardComponent.getHalfData(isUpperHalf);
    } else {
        throw new Error(`Invalid data type '${type}' requested for chessboard.`);
    }

    if (result == null) {
        throw new Error(`Chessboard data is empty or invalid for '${boardId}' (type: ${type}). Ensure pieces are placed correctly.`);
    }
    return result;
}


function handleEncryptResponse(data) {
    if (data.status === 'success') {
        cryptoOutput.innerText = data.result; // Show encrypted data
        resetUIState(null, 'Encryption successful.');
    } else { // Encryption failed
        cryptoOutput.innerText = '';
        resetUIState(`Encryption failed: ${data.error}`);
    }
}

// Who initiated the decryption: the crypto tab itself, or the Password
// Manager card's "Decrypt" button. The floating result window (modal) is only
// shown for the manager flow; the crypto tab shows the result inline.


function handleUserDecryptResponse(data, origin) {
    if (data.status === 'success') {
        cryptoOutput.innerText = data.result;
        resetUIState();
        if (origin === 'manager') {
            // Manager flow: pop up the floating window with the decrypted text only.
            showDecryptResult(data.result);
        } else {
            // Crypto tab flow: never show the floating window (close a leftover one).
            decryptResultDialog.style.display = 'none';
        }
    } else {
        cryptoOutput.innerText = '';
        resetUIState(`Decryption failed: ${data.error}`);
        // Errors are never shown in the floating window (close a leftover one).
        decryptResultDialog.style.display = 'none';
    }
}

// Show the decryption result in a floating window (reuses the modal styles
// previously used by the confirmation/verification step)
function showDecryptResult(text) {
    decryptResultText.innerText = text;
    decryptResultDialog.style.display = 'flex';
}

function generateRandomPassword(length, includeSymbols = true) {
    // character set
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '^*_+-=.<>';

    // combined base charset
    let charset = lowercase + uppercase + numbers;
    if (includeSymbols) charset += symbols;

    // random values
    const randomValues = new Uint32Array(length);
    crypto.getRandomValues(randomValues);

    // generate the password
    let password = '';
    for (let i = 0; i < length; i++) {
        // uniform distribution: float mapping avoids modulo bias
        const rand = randomValues[i] / (0xFFFFFFFF + 1);
        const index = Math.floor(rand * charset.length);
        password += charset[index];
    }

    return password;
}

function initializeWorker() {
    if (window.Worker) {
        cryptoWorker = new Worker('./crypto_worker.js'); // Ensure worker path is correct

        cryptoWorker.onmessage = (e) => {
            const data = e.data;
            if (data.action === 'worker_init_sodium_ready') {
                operations.ready = true;
                syncBusyUI();
                return;
            }
            if (data.action === 'worker_init_sodium_failed') {
                operations.ready = false;
                operations.finish();
                resetUIState(data.error);
                return;
            }
            if (!operations.accepts(data)) return; // stale/unrelated results
            if (data.status === 'progress') {
                const { currentStep, totalSteps, stepName } = data;
                progressBarContainer.style.display = 'block';
                progressBar.style.width = `${Math.min(100, currentStep / totalSteps * 100)}%`;
                progressText.textContent = `${stepName} (${currentStep}/${totalSteps})`;
                return;
            }
            const job = operations.finish();
            resultKind = data.status === 'success' ? job.action : null;
            try {
                if (job.action === 'encrypt') handleEncryptResponse(data);
                else handleUserDecryptResponse(data, job.origin);
            } catch (error) {
                resultKind = null;
                resetUIState(`Could not display result: ${error.message}`);
            }
            syncBusyUI();
        };
        cryptoWorker.onerror = (e) => {
            operations.ready = false;
            operations.finish();
            resultKind = null;
            resetUIState(`Crypto worker failed: ${e.message}. Refresh to retry.`);
        };

        // Indicate worker is ready or initializing.
        // resetUIState will hide loadingIndicator eventually if no errors.
        loadingIndicator.textContent = "Worker initialized.";
        loadingIndicator.style.display = 'block';
        later(() => {
            if (loadingIndicator.textContent === "Worker initialized.") {
                loadingIndicator.style.display = 'none';
            }
        }, 1500);


    } else {
        displayError('Web Workers are not supported in your browser. This application cannot function.');
        actionButton.disabled = true;
        loadingIndicator.style.display = 'none';
    }
}


function performOperation(action, origin = 'crypto') {
    if (operations.busy) return false;
    if (!cryptoWorker || !operations.ready) {
        displayError('Encryption is still initializing. Please wait.');
        return false;
    }
    const input = action === 'encrypt' ? plaintextInput.value : ciphertextInput.value;
    const password = passwordInput.value;
    if (!input || !password) {
        displayError('Enter the data and your password first.');
        return false;
    }
    const factor = getRuleFactor(action === 'encrypt');
    if (!factor.ok) { displayError(factor.error); return false; }
    try {
        const path = getChessboardData('cryptoBoard', 'full');
        if (!path) { displayError('Select cells to set your grid first.'); return false; }
        const job = operations.begin(action, origin);
        if (!job) return false;
        resultKind = null;
        cryptoOutput.innerText = '';
        decryptResultDialog.style.display = 'none';
        startProcessing(action === 'encrypt' ? 'Encrypting…' : 'Decrypting…');
        cryptoWorker.postMessage({ ...job,
            ...(action === 'encrypt' ? { plaintext: input } : { ciphertext: input }),
            password, rulePhrase: factor.value, path,
        });
        window.reactAppRef.current?.hide?.();
        return true;
    } catch (err) {
        operations.finish();
        resetUIState(`Could not start operation: ${err.message}`);
        return false;
    }
}
function performEncrypt() { return performOperation('encrypt'); }

actionButton.addEventListener('click', () => {
    if (currentMode === 'encrypt') {
        performEncrypt();
    } else {
        // The origin belongs to the request, so previous Manager operations
        // cannot route this result to the floating window.
        window.triggerDecrypt(false);
    }
});

// Expose it to global scope for other modules (e.g. Password Manager "Use for Decryption").
// Pass true when the Password Manager card starts the decryption: the decrypted
// text is then shown in the floating result window (modal); errors never pop up.
window.triggerDecrypt = (fromManager = false) => {
    return performOperation('decrypt', fromManager ? 'manager' : 'crypto');
};

copyCiphertextButton.addEventListener('click', async () => {
    if (operations.busy) return;
    if (!cryptoOutput.innerText) {
        displayError('No output to copy.');
        later(() => { if (errorDisplay.textContent === 'No output to copy.') clearError(); }, 2000);
        return;
    }
    try {
        await navigator.clipboard.writeText(cryptoOutput.innerText);
        copyCiphertextButton.disabled = true;
        loadingIndicator.textContent = "The copy has been successful.";
        loadingIndicator.style.display = 'block';
        later(() => {
            if (loadingIndicator.textContent === "The copy has been successful.") {
                loadingIndicator.style.display = 'none';
            }
            syncBusyUI();
        }, 1500);
    } catch (err) {
        console.error('Failed to copy output: ', err);
        displayError('Failed to copy output. Check console for details.');
    }
});

saveToManagerButton.addEventListener('click', async () => {
    const ciphertext = cryptoOutput.innerText;
    if (operations.busy) return;
    if (resultKind !== 'encrypt' || !ciphertext.startsWith('WE2.')) {
        displayError('No ciphertext to save.');
        later(() => { if (errorDisplay.textContent === 'No ciphertext to save.') clearError(); }, 2000);
        return;
    }

    operations.saving = true;
    clearError();
    cancelUITimers();
    syncBusyUI();
    try {
        const newPasswordEntry = {
            name: `Encrypted Data (${new Date().toLocaleDateString()})`,
            description: 'Saved from the Encrypt/Decrypt page.',
            password: ciphertext
        };

        await passwordService.addPassword(newPasswordEntry);
        // The Password Manager is a peer section on the same page now: refresh
        // its card list so the new entry shows up immediately.
        if (window.refreshPasswordList) window.refreshPasswordList();

        loadingIndicator.textContent = "Saved to Password Manager!";
        loadingIndicator.style.display = 'block';
        later(() => {
            if (loadingIndicator.textContent === "Saved to Password Manager!") {
                loadingIndicator.style.display = 'none';
            }
        }, 2000);

    } catch (err) {
        console.error('Failed to save to Password Manager: ', err);
        displayError(`Save was not confirmed: ${err.message}`);
        if (window.refreshPasswordList) window.refreshPasswordList();
    } finally {
        operations.saving = false;
        syncBusyUI();
    }
});

showGeneratePasswordModalButton.addEventListener('click', () => {
    passwordGeneratorModal.style.display = 'flex';
});

closePasswordModalButton.addEventListener('click', () => {
    passwordGeneratorModal.style.display = 'none';
});

window.addEventListener('click', (event) => {
    if (event.target === passwordGeneratorModal) {
        passwordGeneratorModal.style.display = 'none';
    }
    if (event.target === decryptResultDialog) {
        decryptResultDialog.style.display = 'none';
    }
    if (moreOptionsMenu.style.display === 'block') {
        moreOptionsMenu.style.display = 'none';
        moreOptionsBtn.setAttribute('aria-expanded', 'false');
    }
});

modalOptionButtons.forEach(button => {
    button.addEventListener('click', () => {
        const length = parseInt(button.dataset.length || "14", 10);
        plaintextInput.value = generateRandomPassword(length);
        passwordGeneratorModal.style.display = 'none';
        plaintextInput.focus(); // Focus on the input after setting password
    });
});

pastePlaintextButton.addEventListener('click', () => {
    getClipboardText().then(text => {
        if (text) {
            plaintextInput.value = text;
            plaintextInput.focus();
        }
    });
});

pasteCiphertextButton.addEventListener('click', () => {
    getClipboardText().then(text => {
        if (text) {
            ciphertextInput.value = text;
            ciphertextInput.focus();
        }
    });
});

moreOptionsBtn.addEventListener('click', (event) => {
    event.stopPropagation(); // Prevents the window click event from firing immediately
    const isExpanded = moreOptionsBtn.getAttribute('aria-expanded') === 'true';
    moreOptionsMenu.style.display = isExpanded ? 'none' : 'block';
    moreOptionsBtn.setAttribute('aria-expanded', !isExpanded);
});

// Shutdown functionality
shutdownButton.addEventListener('click', () => {
    // Hide the menu first
    moreOptionsMenu.style.display = 'none';
    moreOptionsBtn.setAttribute('aria-expanded', 'false');
    resetUIState('Warning: The server is currently shut down.')
    passwordService.shutdown();
});

async function getClipboardText() {
    try {
        if (!navigator.clipboard) {
            alert('Clipboard API not available in this browser or context (e.g. HTTP).');
            return;
        }
        const text = await navigator.clipboard.readText();
        if (text) {
            return text;
        } else {
            // alert('Clipboard is empty.'); // Optional: notify if clipboard is empty
        }
    } catch (err) {
        console.error('Failed to read clipboard contents: ', err);
        //  Error display logic is assumed to be handled elsewhere or can be added here
        displayError(`Could not paste from clipboard: ${err.message}. Make sure you've granted permission.`);
    }
}

// The single action button in the result window is a Close button: clicking it
// closes the dialog directly (the old ❌ corner button was removed).
closeDecryptResultActionButton.addEventListener('click', () => {
    decryptResultDialog.style.display = 'none';
});

// Initialize React Component (single shared chessboard)
const cell_root = ReactDOM.createRoot(ChessboardInput);
cell_root.render(React.createElement(App));

// Ensure UI reflects the initial mode (encrypt)
setMode('encrypt');

// Initialize the worker last, after UI is set up
syncBusyUI();
initializeWorker();
