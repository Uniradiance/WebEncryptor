

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js'; // Ensure .js extension
import { passwordService } from './password_service.js';

const getElement = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element with id ${id} not found.`);
    return el;
};

// Input/Output Elements
const plaintextInput = getElement('plaintext');
const passwordEncryptInput = getElement('passwordEncrypt');
const ruleEncryptInput = getElement('RuleEncrypt');
const ChessboardEncryptInput = getElement('ChessboardEncrypt');
const encryptButton = getElement('encryptButton');
const ciphertextOutput = getElement('ciphertextOutput');
const copyCiphertextButton = getElement('copyCiphertextButton');
const saveToManagerButton = getElement('saveToManagerButton');

const ciphertextInput = getElement('ciphertextInput');
const ruleDecryptInput = getElement('RuleDecrypt');
const ChessboardDecryptInput = getElement('ChessboardDecrypt');
const passwordDecryptInput = getElement('passwordDecrypt');
const decryptButton = getElement('decryptButton');
const plaintextOutput = getElement('plaintextOutput');

// Generate Passworld Elements
const showGeneratePasswordModalButton = document.getElementById('showGeneratePasswordModalButton');
const passwordGeneratorModal = document.getElementById('passwordGeneratorModal');
const closePasswordModalButton = document.getElementById('closePasswordModalButton');
const modalOptionButtons = document.querySelectorAll('.modal-option-button');
const pastePlaintextButton = document.getElementById('pastePlaintextButton');
const pasteCiphertextButton = document.getElementById('pasteCiphertextButton');

const passwordRetypeDialog = document.getElementById('passwordRetypeDialog');
const closePasswordRetypeButton = document.getElementById('closePasswordRetypeButton');
const passwordRetypeInput = document.getElementById('passwordRetypeInput');
const confirmPasswordRetypeButton = document.getElementById('confirmPasswordRetypeButton');

// UI State Elements
const loadingIndicator = getElement('loadingIndicator');
const errorDisplay = getElement('errorDisplay');
const progressBarContainer = getElement('progressBarContainer');
const progressBar = getElement('progressBar');
const progressText = getElement('progressText');

const tabs = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

// Menu
const moreOptionsBtn = document.getElementById('moreOptionsButton');
const moreOptionsMenu = document.getElementById('moreOptionsMenu');
const shutdownButton = document.getElementById('shutdownButton');

let cryptoWorker = null;

// Store React component refs
window.reactAppRefs = {
    encryptBoard: React.createRef(),
    decryptBoard: React.createRef()
};

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
    encryptButton.disabled = false;
    decryptButton.disabled = false;

    setTimeout(() => {
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
        setTimeout(() => {
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
    clearError();
    loadingIndicator.style.display = 'none'; // Hide loading indicator if it was shown
    progressBarContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.textContent = message;
    encryptButton.disabled = true;
    decryptButton.disabled = true;
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
        const encryptedData = data.result;
        ciphertextOutput.innerText = encryptedData; // Show encrypted data
        passwordRetypeDialog.style.display = 'flex';
    } else { // Encryption failed
        ciphertextOutput.innerText = '';
        resetUIState(`Encryption failed: ${data.error}`);
    }
}

function handleUserDecryptResponse(data) {
    if (data.status === 'success') {
        plaintextOutput.innerText = data.result;
        resetUIState();
    } else {
        plaintextOutput.innerText = '';
        resetUIState(`Decryption failed: ${data.error}`);
    }
}

function handleVerifyResponse(data) {
    if (data.status === 'success') {
        loadingIndicator.textContent = "Verification successful.";
        loadingIndicator.style.display = 'block';
        setTimeout(() => {
            if (loadingIndicator.textContent === "Verification successful.") {
                loadingIndicator.style.display = 'none';
            }
        }, 1500);
        resetUIState();
    } else { // Verification (decryption step inside worker) failed
        ciphertextOutput.innerText = '';
        resetUIState(`Auto-decryption validation failed during decryption: ${data.error}. Ciphertext not shown.`);
    }
}

function generateRandomPassword(length, includeSymbols = true) {
    // 定义字符集
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '^*_+-=.<>';

    // 组合基础字符集
    let charset = lowercase + uppercase + numbers;
    if (includeSymbols) charset += symbols;

    // 创建随机值数组
    const randomValues = new Uint32Array(length);
    crypto.getRandomValues(randomValues);

    // 生成密码
    let password = '';
    for (let i = 0; i < length; i++) {
        // 确保均匀分布：使用浮点数映射避免取模偏差
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
            if (e.data.status === 'progress') {
                loadingIndicator.style.display = 'none'; // Should be hidden by startProcessing
                progressBarContainer.style.display = 'block';
                const { currentStep, totalSteps, stepName } = e.data;
                if (typeof currentStep === 'number' && typeof totalSteps === 'number' && totalSteps > 0) {
                    const percentage = Math.max(0, Math.min(100, (currentStep / totalSteps) * 100));
                    progressBar.style.width = `${percentage}%`;
                    progressText.textContent = stepName ? `${stepName} (${currentStep}/${totalSteps})` : `Step ${currentStep} of ${totalSteps}`;
                }
                // Buttons are already disabled by startProcessing
                return;
            }

            // Non-progress messages
            try {
                switch (e.data.action) {
                    case 'encrypt':
                        handleEncryptResponse(e.data);
                        break;
                    case 'decrypt': // This is for user-initiated decryption
                        handleUserDecryptResponse(e.data);
                        break;
                    case 'verify': // This is the response from auto-validation decryption
                        handleVerifyResponse(e.data);
                        break;
                    case 'worker_init_sodium_ready':
                        break;
                    case 'worker_init_sodium_failed':
                        break;
                    default:
                        console.warn('Unknown worker action:', e.data.action, e.data);
                        resetUIState(`Received unknown action from worker: ${e.data.action}`);
                }
            } catch (error) {
                console.error('Error processing worker message:', error, e.data);
                resetUIState(`Client-side error processing worker response: ${error.message}`);
            }
        };

        cryptoWorker.onerror = (e) => {
            console.error('Worker critical error:', e);
            resetUIState(`Worker critical error: ${e.message}. Please refresh the page or check browser console.`);
            // Optionally, try to re-initialize or disable functionality
        };

        // Indicate worker is ready or initializing.
        // resetUIState will hide loadingIndicator eventually if no errors.
        loadingIndicator.textContent = "Worker initialized.";
        loadingIndicator.style.display = 'block';
        setTimeout(() => {
            if (loadingIndicator.textContent === "Worker initialized.") {
                loadingIndicator.style.display = 'none';
            }
        }, 1500);


    } else {
        displayError('Web Workers are not supported in your browser. This application cannot function.');
        encryptButton.disabled = true;
        decryptButton.disabled = true;
        loadingIndicator.style.display = 'none';
    }
}


encryptButton.addEventListener('click', () => {
    if (!cryptoWorker) {
        displayError("Crypto worker not initialized. Please refresh.");
        return;
    }
    const plaintext = plaintextInput.value;
    const password = passwordEncryptInput.value;
    const passwordTransformRuleJs = ruleEncryptInput.value;

    if (!plaintext || !password || !passwordTransformRuleJs) {
        displayError('All fields for encryption (Data, Password, Nesting Rule) on Encrypt tab are required.');
        return;
    }

    try {
        const path = getChessboardData('encryptBoard', 'full');
        const upper = getChessboardData('encryptBoard', 'half', true);
        const lower = getChessboardData('encryptBoard', 'half', false);

        startProcessing('Encrypting...');
        ciphertextOutput.innerText = ''; // Clear previous output

        cryptoWorker.postMessage({
            action: 'encrypt',
            plaintext,
            password,
            passwordTransformRuleJs,
            path,
            upper,
            lower,
        });
    } catch (err) {
        displayError(`Chessboard error for encryption: ${err.message}`);
    }
});

decryptButton.addEventListener('click', () => {
    if (!cryptoWorker) {
        displayError("Crypto worker not initialized. Please refresh.");
        return;
    }
    const ciphertext = ciphertextInput.value;
    const password = passwordDecryptInput.value;
    const passwordTransformRuleJs = ruleDecryptInput.value;


    if (!ciphertext || !password || !passwordTransformRuleJs) {
        displayError('All fields for decryption (Ciphertext, Password, Nesting Rule) on Decrypt tab are required.');
        return;
    }

    try {
        const path = getChessboardData('decryptBoard', 'full');
        const upper = getChessboardData('decryptBoard', 'half', true);
        const lower = getChessboardData('decryptBoard', 'half', false);

        startProcessing('Decrypting...');
        plaintextOutput.innerText = ''; // Clear previous output

        cryptoWorker.postMessage({
            action: 'decrypt',
            ciphertext,
            password,
            passwordTransformRuleJs,
            path,
            upper,
            lower,
        });
    } catch (err) {
        displayError(`Chessboard error for decryption: ${err.message}`);
    }
});

copyCiphertextButton.addEventListener('click', async () => {
    if (!ciphertextOutput.innerText) {
        displayError('No ciphertext to copy.');
        setTimeout(() => { if (errorDisplay.textContent === 'No ciphertext to copy.') clearError(); }, 2000);
        return;
    }
    try {
        await navigator.clipboard.writeText(ciphertextOutput.innerText);
        copyCiphertextButton.disabled = true;
        loadingIndicator.textContent = "The copy has been successful.";
        loadingIndicator.style.display = 'block';
        setTimeout(() => {
            if (loadingIndicator.textContent === "The copy has been successful.") {
                loadingIndicator.style.display = 'none';
            }
            copyCiphertextButton.disabled = false;
        }, 1500);
    } catch (err) {
        console.error('Failed to copy ciphertext: ', err);
        displayError('Failed to copy ciphertext. Check console for details.');
    }
});

saveToManagerButton.addEventListener('click', () => {
    const ciphertext = ciphertextOutput.innerText;
    if (!ciphertext) {
        displayError('No ciphertext to save.');
        setTimeout(() => { if (errorDisplay.textContent === 'No ciphertext to save.') clearError(); }, 2000);
        return;
    }

    try {
        const newPasswordEntry = {
            name: `Encrypted Data (${new Date().toLocaleDateString()})`,
            description: 'Saved from the Encrypt tab.',
            password: ciphertext
        };

        passwordService.addPassword(newPasswordEntry);

        loadingIndicator.textContent = "Saved to Password Manager!";
        loadingIndicator.style.display = 'block';
        setTimeout(() => {
            if (loadingIndicator.textContent === "Saved to Password Manager!") {
                loadingIndicator.style.display = 'none';
            }
        }, 2000);

    } catch (err) {
        console.error('Failed to save to Password Manager: ', err);
        displayError('Failed to save to Password Manager. Check console for details.');
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

confirmPasswordRetypeButton.addEventListener('click', () => {
    // 点击确认时执行验证逻辑
    try {
        // Parameters for verification from the DECRYPT tab
        passwordRetypeDialog.style.display = 'none';

        const encryptedData = ciphertextOutput.innerText;

        const passwordForVerify = passwordRetypeInput.value;
        const ruleForVerify = ruleEncryptInput.value;
        const pathForVerify = getChessboardData('decryptBoard', 'full');
        const upperForVerify = getChessboardData('decryptBoard', 'half', true);
        const lowerForVerify = getChessboardData('decryptBoard', 'half', false);

        if (!passwordForVerify || !ruleForVerify) {
            resetUIState('Encryption Succeeded. Auto-validation skipped: Missing Password or Nesting Rule on Decrypt tab.');
            return;
        }
        startProcessing('Validating encryption...');
        cryptoWorker.postMessage({
            action: 'verify',
            ciphertext: encryptedData,
            password: passwordForVerify,
            passwordTransformRuleJs: ruleForVerify,
            path: pathForVerify,
            upper: upperForVerify,
            lower: lowerForVerify
        });

        passwordRetypeInput.value = '';

    } catch (err) { // Error getting chessboard data for verification or other setup issues
        ciphertextOutput.innerText = encryptedData; // Show encrypted data if validation setup fails
        resetUIState(`Encryption Succeeded. Auto-validation skipped: ${err.message}. Ensure Decrypt tab is correctly configured.`);
    }
});

closePasswordRetypeButton.addEventListener('click', () => {
    passwordRetypeDialog.style.display = 'none';
    passwordRetypeInput.value = '';
    // isPasswordConfirmed remains false, user needs to re-trigger confirmation.
});

function switchToTab(tabId) {
    tabs.forEach(t => {
        if (t.dataset.tab === tabId) {
            t.classList.add('active');
        } else {
            t.classList.remove('active');
        }
    });

    tabContents.forEach(content => {
        if (content.id === tabId) {
            content.classList.add('active');
        } else {
            content.classList.remove('active');
        }
    });
    // Reset UI state when switching tabs
    resetUIState();
    ciphertextOutput.innerText = '';
    plaintextOutput.innerText = '';
}
// Expose it to global scope for other modules
window.switchToTab = switchToTab;


tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTabContentId = tab.getAttribute('data-tab');
        switchToTab(targetTabContentId);
    });
});

// Initialize React Components
const cell_encrypt_root = ReactDOM.createRoot(ChessboardEncryptInput);
const cell_decrypt_root = ReactDOM.createRoot(ChessboardDecryptInput);

// Pass refs to App component instances
const AppInstanceEncrypt = React.createElement(App);

cell_encrypt_root.render(AppInstanceEncrypt);
cell_decrypt_root.render(AppInstanceEncrypt);

// Initialize the worker last, after UI is set up
initializeWorker();