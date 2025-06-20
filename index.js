import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js'; // Ensure .js extension

const getElement = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element with id ${id} not found.`);
    return el;
};

const plaintextInput = getElement('plaintext');
const passwordEncryptInput = getElement('passwordEncrypt'); // New password input for encryption
const nestingRuleAEncryptInput = getElement('nestingRuleAEncrypt');
const ChessboardEncryptInput = getElement('ChessboardEncrypt');
const encryptButton = getElement('encryptButton');
const ciphertextOutput = getElement('ciphertextOutput');
const copyCiphertextButton = getElement('copyCiphertextButton');

const ciphertextInput = getElement('ciphertextInput');
const nestingRuleADecryptInput = getElement('nestingRuleADecrypt');
const ChessboardDecryptInput = getElement('ChessboardDecrypt');
const passwordDecryptInput = getElement('passwordDecrypt');
const decryptButton = getElement('decryptButton');
const plaintextOutput = getElement('plaintextOutput');

const loadingIndicator = getElement('loadingIndicator');
const errorDisplay = getElement('errorDisplay');
const progressBarContainer = getElement('progressBarContainer');
const progressBar = getElement('progressBar');
const progressText = getElement('progressText');

const tabs = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

let cryptoWorker = null;

function initializeWorker() {
    if (window.Worker) {
        cryptoWorker = new Worker('./crypto_worker.js');

        cryptoWorker.onmessage = (e) => {
            if (e.data.status === 'progress') {
                loadingIndicator.style.display = 'none';
                progressBarContainer.style.display = 'block';
                const { currentStep, totalSteps } = e.data;
                if (typeof currentStep === 'number' && typeof totalSteps === 'number' && totalSteps > 0) {
                    const percentage = Math.max(0, Math.min(100, (currentStep / totalSteps) * 100));
                    progressBar.style.width = `${percentage}%`;
                    progressText.textContent = `Step ${currentStep} of ${totalSteps}`;
                }
                return;
            }
            
            progressBarContainer.style.display = 'none';
            progressBar.style.width = '0%';
            progressText.textContent = '';
            encryptButton.disabled = false;
            decryptButton.disabled = false;

            if (e.data.status === 'success') {
                errorDisplay.style.display = 'none';
                errorDisplay.textContent = '';
                if (e.data.action === 'encrypt') {
                    ciphertextOutput.value = e.data.result;
                } else if (e.data.action === 'decrypt') {
                    plaintextOutput.value = e.data.result;
                }
            } else if (e.data.status === 'error') {
                plaintextOutput.value = '';
                ciphertextOutput.value = '';
                errorDisplay.textContent = `Error: ${e.data.error}`;
                errorDisplay.style.display = 'block';
                console.error('Worker error:', e.data.error);
            }
        };

        cryptoWorker.onerror = (e) => {
            progressBarContainer.style.display = 'none';
            loadingIndicator.style.display = 'none';
            encryptButton.disabled = false;
            decryptButton.disabled = false;
            errorDisplay.textContent = `Worker critical error: ${e.message}`;
            errorDisplay.style.display = 'block';
            console.error('Worker onerror:', e);
        };
        
        loadingIndicator.textContent = "Initializing Worker...";
        loadingIndicator.style.display = 'block';
        
        setTimeout(() => {
            if (progressBarContainer.style.display === 'none' && errorDisplay.style.display === 'none') {
                 loadingIndicator.style.display = 'none';
            }
        }, 1500);

    } else {
        errorDisplay.textContent = 'Web Workers are not supported in your browser.';
        errorDisplay.style.display = 'block';
        encryptButton.disabled = true;
        decryptButton.disabled = true;
        loadingIndicator.style.display = 'none';
    }
}

function displayError(message) {
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
    loadingIndicator.style.display = 'none';
    progressBarContainer.style.display = 'none';
}

function startProcessing() {
    errorDisplay.style.display = 'none';
    loadingIndicator.style.display = 'none'; 
    progressBarContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.textContent = 'Starting...';
    encryptButton.disabled = true;
    decryptButton.disabled = true;
}

function getFullData() {
    // 确保React组件已加载
    if (!window.reactAppRef || !window.reactAppRef.current) {
        throw new Error("The cell is empty! ");
    }

    const result = window.reactAppRef.current.getFullData();
    if (result == null) throw new Error("The cell is empty! ");

    return result;
}

function getHalfData(isUpperHalf) {
    // 确保React组件已加载
    if (!window.reactAppRef || !window.reactAppRef.current) {
        throw new Error("The cell is empty! ");
    }

    
    const result = window.reactAppRef.current.getHalfData(isUpperHalf);
    if (result == null) throw new Error("The cell is empty! ");
    
    return result;
}

encryptButton.addEventListener('click', () => {
    if (!cryptoWorker) {
        displayError("Crypto worker not initialized.");
        return;
    }
    const plaintext = plaintextInput.value;
    const password = passwordEncryptInput.value; // Get password for encryption
    const nestingRuleA = nestingRuleAEncryptInput.value;

    if (!plaintext || !password || !nestingRuleA) {
        displayError('All fields for encryption (Data, Password, Nesting Rule, Obfuscation Function) are required.');
        return;
    }

    const _path = getFullData();
    const _upper = getHalfData(true);
    const _lower = getHalfData(false);

    if (!_path || !_upper || !_lower){
        displayError('There are not enough chess pieces.');
        return;
    }

    startProcessing();
    ciphertextOutput.value = '';

    const payload = {
        action: 'encrypt',
        plaintext,
        password: password, // Use the dedicated password field
        nestingRuleA,
        path: _path,
        upper: _upper,
        lower:_lower,
    };
    cryptoWorker.postMessage(payload);
});

decryptButton.addEventListener('click', () => {
    if (!cryptoWorker) {
        displayError("Crypto worker not initialized.");
        return;
    }
    const ciphertext = ciphertextInput.value;
    const nestingRuleA = nestingRuleADecryptInput.value;
    const password = passwordDecryptInput.value;

    if (!ciphertext || !password || !nestingRuleA) {
        displayError('All fields for decryption are required.');
        return;
    }

    const _path = getFullData();
    const _upper = getHalfData(true);
    const _lower = getHalfData(false);

    if (!_path || !_upper || !_lower){
        displayError('There are not enough chess pieces.');
        return;
    }

    startProcessing();
    plaintextOutput.value = '';

    const payload = {
        action: 'decrypt',
        ciphertext,
        password,
        nestingRuleA,
        path:_path,
        upper:_upper,
        lower:_lower,
    };
    cryptoWorker.postMessage(payload);
});

copyCiphertextButton.addEventListener('click', async () => {
    if (!ciphertextOutput.value) {
        displayError('No ciphertext to copy.');
        setTimeout(() => { if(errorDisplay.textContent === 'No ciphertext to copy.') errorDisplay.style.display = 'none'; }, 2000);
        return;
    }
    try {
        await navigator.clipboard.writeText(ciphertextOutput.value);
        const originalText = copyCiphertextButton.textContent;
        copyCiphertextButton.textContent = 'Copied!';
        copyCiphertextButton.disabled = true;
        setTimeout(() => {
            copyCiphertextButton.textContent = originalText;
            copyCiphertextButton.disabled = false;
        }, 1500);
    } catch (err) {
        console.error('Failed to copy ciphertext: ', err);
        displayError('Failed to copy ciphertext. Check console for details.');
    }
});

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const targetTabContentId = tab.getAttribute('data-tab');
        tabContents.forEach(content => {
            content.classList.remove('active');
            if (content.id === targetTabContentId) {
                content.classList.add('active');
            }
        });
        errorDisplay.style.display = 'none';
        errorDisplay.textContent = '';
        ciphertextOutput.value = '';
        plaintextOutput.value = '';
        progressBarContainer.style.display = 'none'; 
        encryptButton.disabled = false; 
        decryptButton.disabled = false;
    });
});

const cell_encrypt = ReactDOM.createRoot(ChessboardEncryptInput);
const cell_decrypt = ReactDOM.createRoot(ChessboardDecryptInput);
// Replace JSX with React.createElement

const chessboard = React.createElement(App)
cell_encrypt.render(chessboard);
cell_decrypt.render(chessboard);

initializeWorker();