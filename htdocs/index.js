

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js'; // Ensure .js extension
import { passwordService } from './password_service.js';

const getElement = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element with id ${id} not found.`);
    return el;
};

// Shared Input/Output Elements (merged Encrypt/Decrypt page)
const plaintextInput = getElement('plaintext');
const passwordInput = getElement('passwordEncrypt');
const ruleInput = getElement('RuleEncrypt');
const ChessboardInput = getElement('ChessboardEncrypt');
const actionButton = getElement('actionButton');
const cryptoOutput = getElement('cryptoOutput');
const cryptoOutputHeading = getElement('cryptoOutputHeading');
const copyCiphertextButton = getElement('copyCiphertextButton');
const saveToManagerButton = getElement('saveToManagerButton');
const toggleRuleButton = getElement('toggleRuleEncrypt');

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
const closeDecryptResultButton = getElement('closeDecryptResultButton');
const decryptResultText = getElement('decryptResultText');
const copyDecryptResultButton = getElement('copyDecryptResultButton');

// UI State Elements
const loadingIndicator = getElement('loadingIndicator');
const errorDisplay = getElement('errorDisplay');
const progressBarContainer = getElement('progressBarContainer');
const progressBar = getElement('progressBar');
const progressText = getElement('progressText');

const tabs = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');
const modeButtons = document.querySelectorAll('.mode-button');

// Menu
const moreOptionsBtn = document.getElementById('moreOptionsButton');
const moreOptionsMenu = document.getElementById('moreOptionsMenu');
const shutdownButton = document.getElementById('shutdownButton');

let cryptoWorker = null;

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
    actionButton.disabled = false;

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
    actionButton.disabled = true;
}

// Switch between the mutually exclusive input panes (Data to Encrypt / Ciphertext).
// Only visibility changes: textarea contents are preserved.
function setMode(mode) {
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
}

// Expose it to global scope for other modules (e.g. Password Manager "Use for Decryption")
window.switchCryptoMode = setMode;

modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        setMode(btn.dataset.mode);
    });
});

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
        resetUIState(null, 'Encryption successful.'); // No confirmation/verification step
    } else { // Encryption failed
        cryptoOutput.innerText = '';
        resetUIState(`Encryption failed: ${data.error}`);
    }
}

function handleUserDecryptResponse(data) {
    if (data.status === 'success') {
        cryptoOutput.innerText = data.result;
        resetUIState();
        showDecryptResult(data.result);
    } else {
        cryptoOutput.innerText = '';
        resetUIState(`Decryption failed: ${data.error}`);
    }
}

// Show the decryption result in a floating window (reuses the modal styles
// previously used by the confirmation/verification step)
function showDecryptResult(text) {
    decryptResultText.innerText = text;
    decryptResultDialog.style.display = 'flex';
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
                // Button is already disabled by startProcessing
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
        actionButton.disabled = true;
        loadingIndicator.style.display = 'none';
    }
}


function performEncrypt() {
    if (!cryptoWorker) {
        displayError("Crypto worker not initialized. Please refresh.");
        return;
    }
    const plaintext = plaintextInput.value;
    const password = passwordInput.value;
    const rulePhrase = ruleInput.value;

    if (!plaintext || !password || !rulePhrase) {
        displayError('All fields for encryption (Data, Password, Rule Phrase) are required.');
        return;
    }

    try {
        const path = getChessboardData('cryptoBoard', 'full');
        startProcessing('Encrypting...');
        cryptoOutput.innerText = ''; // Clear previous output
        cryptoWorker.postMessage({
            action: 'encrypt',
            plaintext,
            password,
            rulePhrase,
            path,
        });
        window.reactAppRef.current.shuffleCellColors();
    } catch (err) {
        displayError(`Chessboard error for encryption: ${err.message}`);
    }
}

function performDecrypt() {
    if (!cryptoWorker) {
        displayError("Crypto worker not initialized. Please refresh.");
        return;
    }
    const ciphertext = ciphertextInput.value;
    const password = passwordInput.value;
    const rulePhrase = ruleInput.value;

    if (!ciphertext || !password || !rulePhrase) {
        displayError('All fields for decryption (Ciphertext, Password, Rule Phrase) are required.');
        return;
    }

    try {
        const path = getChessboardData('cryptoBoard', 'full');
        startProcessing('Decrypting...');
        cryptoOutput.innerText = ''; // Clear previous output
        cryptoWorker.postMessage({
            action: 'decrypt',
            ciphertext,
            password,
            rulePhrase,
            path,
        });
        window.reactAppRef.current.shuffleCellColors();
    } catch (err) {
        displayError(`Chessboard error for decryption: ${err.message}`);
    }
}

actionButton.addEventListener('click', () => {
    if (currentMode === 'encrypt') {
        performEncrypt();
    } else {
        performDecrypt();
    }
});

// Expose it to global scope for other modules (e.g. Password Manager "Use for Decryption")
window.triggerDecrypt = performDecrypt;

copyCiphertextButton.addEventListener('click', async () => {
    if (!cryptoOutput.innerText) {
        displayError('No output to copy.');
        setTimeout(() => { if (errorDisplay.textContent === 'No output to copy.') clearError(); }, 2000);
        return;
    }
    try {
        await navigator.clipboard.writeText(cryptoOutput.innerText);
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
        console.error('Failed to copy output: ', err);
        displayError('Failed to copy output. Check console for details.');
    }
});

saveToManagerButton.addEventListener('click', () => {
    const ciphertext = cryptoOutput.innerText;
    if (!ciphertext) {
        displayError('No ciphertext to save.');
        setTimeout(() => { if (errorDisplay.textContent === 'No ciphertext to save.') clearError(); }, 2000);
        return;
    }

    try {
        const newPasswordEntry = {
            name: `Encrypted Data (${new Date().toLocaleDateString()})`,
            description: 'Saved from the Encrypt/Decrypt page.',
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

closeDecryptResultButton.addEventListener('click', () => {
    decryptResultDialog.style.display = 'none';
});

copyDecryptResultButton.addEventListener('click', async () => {
    const text = decryptResultText.innerText;
    if (!text) {
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        const originalLabel = copyDecryptResultButton.textContent;
        copyDecryptResultButton.textContent = 'Copied!';
        setTimeout(() => {
            copyDecryptResultButton.textContent = originalLabel;
        }, 1500);
    } catch (err) {
        console.error('Failed to copy decryption result: ', err);
        displayError('Failed to copy decryption result. Check console for details.');
    }
});

showPassword(toggleRuleButton, ruleInput);

function showPassword(eyeIcon, Input) {
    // 鼠标按下时显示密码
    eyeIcon.addEventListener('mouseup', () => {
        Input.type = 'text';
        Input.focus();
    });

    // 触摸开始时显示密码 (移动设备)
    eyeIcon.addEventListener('touchend', () => {
        Input.type = 'text';
        Input.focus();
    });

    // 输入框失去焦点隐藏密码
    Input.addEventListener('blur', () => {
        Input.type = 'password';
    });
}
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
            if (content.id == 'password-manager' & !content.hasAttribute('size')) {
                let baseWidth = content.getBoundingClientRect().width + 60;
                if (baseWidth > content.parentNode.getBoundingClientRect().width) {
                    baseWidth -= 20;
                }
                console.log(baseWidth);
                content.style.minWidth = `${baseWidth <= 700 ? baseWidth : 700}px`;
                content.setAttribute('size', true);
            }
        } else {
            content.classList.remove('active');
        }
    });
    // Reset UI state when switching tabs
    resetUIState();
    cryptoOutput.innerText = '';
}
// Expose it to global scope for other modules
window.switchToTab = switchToTab;

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTabContentId = tab.getAttribute('data-tab');
        switchToTab(targetTabContentId);
    });
});

// Initialize React Component (single shared chessboard)
const cell_root = ReactDOM.createRoot(ChessboardInput);
cell_root.render(React.createElement(App));

// Ensure UI reflects the initial mode (encrypt)
setMode('encrypt');

// Initialize the worker last, after UI is set up
initializeWorker();
