
import { passwordService } from './password_service.js';

// The use-for-decrypt button has two roles depending on the card state:
// - normal (view) mode: decrypt the stored ciphertext directly
// - edit mode: jump to the Data Panel (fill ciphertext + switch to decrypt mode)
function setUseForDecryptBtnState(btn, isEditing) {
    btn.title = isEditing ? 'Jump to Decryption' : 'Decrypt';
    btn.setAttribute('aria-label', isEditing ? 'Jump to Decryption' : 'Decrypt');
}

document.addEventListener('DOMContentLoaded', () => {
    // This script might run before or after the main index.js,
    // so we need to ensure we don't cause issues if elements aren't found.
    const passwordList = document.getElementById('password-list');
    const addPasswordBtn = document.getElementById('add-password-btn');
    const cardTemplate = document.getElementById('password-card-template');

    // If the elements don't exist, we're not on the right page or the DOM is not ready.
    if (!passwordList || !addPasswordBtn || !cardTemplate) {
        return;
    }
    
    // --- UI Rendering ---
    const renderPasswords = async () => {
        // A simple loader for better UX during network requests
        passwordList.innerHTML = '<div class="pm-loader" style="text-align: center; color: #7f8c8d; grid-column: 1 / -1;">Loading passwords...</div>';

        try {
            const passwords = await passwordService.getPasswords();
            passwordList.innerHTML = ''; // Clear loader/old content

            if (passwords.length === 0) {
                const p = document.createElement('p');
                p.textContent = 'No passwords saved. Click "Add New" to get started.';
                p.style.textAlign = 'center';
                p.style.color = '#7f8c8d';
                p.style.gridColumn = "1 / -1"; // Span across all columns if grid is active
                passwordList.appendChild(p);
            } else {
                passwords.forEach(password => {
                    const card = createPasswordCard(password);
                    passwordList.appendChild(card);
                });
            }
        } catch (error) {
            console.error("Failed to load passwords:", error);
            passwordList.innerHTML = '<p class="pm-error" style="text-align: center; color: #e74c3c; grid-column: 1 / -1;">Error: Could not fetch passwords from the server. Please check your connection and try again.</p>';
        }
    };

    const createPasswordCard = (passwordData) => {
        const cardClone = cardTemplate.content.cloneNode(true);
        const cardElement = cardClone.querySelector('.pm-card');
        cardElement.dataset.id = passwordData.id;

        // Get elements
        const nameEl = cardElement.querySelector('[data-name]');
        const descriptionEl = cardElement.querySelector('[data-description]');
        const nameInput = cardElement.querySelector('[data-name-input]');
        const descriptionInput = cardElement.querySelector('[data-description-input]');
        const passwordInput = cardElement.querySelector('[data-password-input]');
        
        const editBtn = cardElement.querySelector('.edit-btn');
        const saveBtn = cardElement.querySelector('.save-btn');
        const cancelBtn = cardElement.querySelector('.cancel-btn');
        const deleteBtn = cardElement.querySelector('.delete-btn');
        const useForDecryptBtn = cardElement.querySelector('.use-for-decrypt-btn');

        // Populate view mode
        nameEl.textContent = passwordData.name;
        descriptionEl.textContent = passwordData.description;

        // Populate edit mode
        nameInput.value = passwordData.name;
        descriptionInput.value = passwordData.description;
        passwordInput.value = passwordData.password;

        const setCardBusy = (isBusy) => {
            editBtn.disabled = isBusy;
            saveBtn.disabled = isBusy;
            cancelBtn.disabled = isBusy;
            deleteBtn.disabled = isBusy;
            useForDecryptBtn.disabled = isBusy;
            cardElement.style.opacity = isBusy ? '0.7' : '1';
        };

        // --- Event Listeners ---
        editBtn.addEventListener('click', () => {
            cardElement.classList.add('editing');
            setUseForDecryptBtnState(useForDecryptBtn, true); // Edit mode: jump to the Data Panel
        });

        cancelBtn.addEventListener('click', () => {
            // Revert any changes by resetting the input values
            nameInput.value = passwordData.name;
            descriptionInput.value = passwordData.description;
            passwordInput.value = passwordData.password;
            // Exit edit mode
            cardElement.classList.remove('editing');
            setUseForDecryptBtnState(useForDecryptBtn, false); // Back to normal mode: direct decrypt
        });

        saveBtn.addEventListener('click', async () => {
            const updatedPassword = {
                id: passwordData.id,
                name: nameInput.value.trim(),
                description: descriptionInput.value.trim(),
                password: passwordInput.value.trim(),
            };

            if (!updatedPassword.name) {
                alert("Name cannot be empty.");
                return;
            }
            
            setCardBusy(true);

            try {
                if (await passwordService.updatePassword(updatedPassword)) {
                    // Update the local data object to reflect the save
                    passwordData.name = updatedPassword.name;
                    passwordData.description = updatedPassword.description;
                    passwordData.password = updatedPassword.password;
                    
                    // Update UI without full re-render for a smoother experience
                    nameEl.textContent = updatedPassword.name;
                    descriptionEl.textContent = updatedPassword.description;
                    cardElement.classList.remove('editing');
                    setUseForDecryptBtnState(useForDecryptBtn, false); // Back to normal mode: direct decrypt
                }
            } catch (error) {
                console.error("Failed to save password:", error);
                alert("Failed to save the password. The item may have been deleted. The list will be refreshed.");
                renderPasswords(); // Re-render to get latest state from server
            } finally {
                setCardBusy(false);
            }
        });
        
        useForDecryptBtn.addEventListener('click', () => {
            const ciphertextInput = document.getElementById('ciphertextInput');

            if (cardElement.classList.contains('editing')) {
                // Edit mode: jump to the Data Panel (fill ciphertext, switch to
                // the Data Panel sub-tab + decrypt mode, then scroll to it).
                if (ciphertextInput && window.switchToTab && window.scrollToSection && window.switchCryptoMode) {
                    // 1. Set the value
                    ciphertextInput.value = passwordData.password;

                    // 2. Switch to the decryption input card (mutually exclusive mode)
                    window.switchCryptoMode('decrypt');

                    // 3. Switch to the "Data Panel" sub-tab (the factors stay visible)
                    window.switchToTab('data');

                    // 4. Scroll to the Data Panel
                    window.scrollToSection('dataPanel');

                    // 5. Focus the input for better UX
                    ciphertextInput.focus();
                } else {
                    if (!ciphertextInput) {
                        alert('Could not find the decryption input field.');
                    }
                    if (!window.switchCryptoMode) {
                        alert('Could not switch to decryption mode. The main script might have an issue.');
                    }
                    if (!window.switchToTab) {
                        alert('Could not switch to the Data Panel tab. The main script might have an issue.');
                    }
                    if (!window.scrollToSection) {
                        alert('Could not scroll to the Data Panel. The main script might have an issue.');
                    }
                }
            } else {
                // Normal (view) mode: decrypt the stored ciphertext directly.
                // Fill the decrypt pane (and switch the Data Panel to decrypt
                // mode so the user sees exactly what was loaded), then run the
                // decryption: the result is shown in the floating result
                // window (modal), not inline.
                if (ciphertextInput && window.switchCryptoMode && window.triggerDecrypt) {
                    // 1. Set the value (used by the decryption step)
                    ciphertextInput.value = passwordData.password;

                    // 2. Show it in the Data Panel's decrypt pane
                    window.switchCryptoMode('decrypt');

                    // 3. Run the decryption from the manager flow
                    window.triggerDecrypt(true);
                } else {
                    if (!ciphertextInput) {
                        alert('Could not find the decryption input field.');
                    }
                    if (!window.triggerDecrypt) {
                        alert('Could not trigger decryption. The main script might have an issue.');
                    }
                }
            }
        });

        deleteBtn.addEventListener('click', async () => {
            if (confirm(`Are you sure you want to delete "${passwordData.name}"?`)) {
                setCardBusy(true);
                try {
                    if(await passwordService.deletePassword(passwordData.id)) {
                        // The card will be removed by renderPasswords, so we don't need to call setCardBusy(false)
                        renderPasswords(); // Re-render the whole list
                    }
                } catch (error) {
                    console.error("Failed to delete password:", error);
                    alert("Failed to delete the password. The list will be refreshed.");
                    setCardBusy(false);
                    renderPasswords();
                }
            }
        });

        return cardElement;
    };

    addPasswordBtn.addEventListener('click', async () => {
        addPasswordBtn.disabled = true;

        const newPasswordData = {
            name: "New Item",
            description: "A brief description.",
            password: ""
        };
        
        try {
            const newPasswordEntry = await passwordService.addPassword(newPasswordData);
            await renderPasswords();

            // Automatically enter edit mode for the new card for a better UX
            setTimeout(() => {
                const newCard = passwordList.querySelector(`[data-id='${newPasswordEntry.id}']`);
                if (newCard) {
                    newCard.classList.add('editing');
                    setUseForDecryptBtnState(newCard.querySelector('.use-for-decrypt-btn'), true);
                    newCard.querySelector('[data-name-input]').focus();
                    newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
        } catch (error) {
            console.error("Failed to add new password:", error);
            alert("Failed to add the new item. Please try again.");
        } finally {
            addPasswordBtn.disabled = false;
        }
    });

    // The Password Manager lives in its own sub-tab: the list is rendered
    // lazily when the tab is first opened (index.js calls refreshPasswordList
    // on every switch to the "manager" tab), so no password data is fetched
    // while the user only works in the Data Panel.
    // Expose a refresh hook so other modules (e.g. the "Save to Password
    // Manager" button in index.js, or the sub-tab switch) can render/refresh
    // the card list.
    window.refreshPasswordList = () => renderPasswords();
});
