package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const maxVaultChildren = 1000
const maxVaultItemBytes = 64 * 1024
const maxVaultItemCiphertext = 4*((maxVaultItemBytes+16+2)/3) + 39
const maxVaultBytes = 24 * 1024 * 1024

type VaultChild struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Password    string `json:"password"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var errVaultConflict = errors.New("This vault changed in another session. Your draft is retained. Lock and reopen the vault before retrying.")

func decodeBase64(s string) ([]byte, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errors.New("invalid canonical Base64")
	}
	return b, nil
}

func validateWrappedKey(value, vaultID string) error {
	if len(value) > 2048 {
		return errors.New("encrypted vault key is too large")
	}
	p := strings.Split(value, ".")
	if len(p) != 5 || p[0] != "WVK1" {
		return errors.New("expected a WVK1 encrypted vault key")
	}
	headerBytes, err := decodeBase64(p[1])
	if err != nil {
		return err
	}
	var header struct {
		V       int    `json:"v"`
		VaultID string `json:"vaultId"`
		KDF     string `json:"kdf"`
		Ops     int    `json:"ops"`
		Mem     int    `json:"mem"`
		Factors int    `json:"factors"`
	}
	d := json.NewDecoder(bytes.NewReader(headerBytes))
	d.DisallowUnknownFields()
	if d.Decode(&header) != nil || d.Decode(new(any)) != io.EOF || header.V != 1 || header.VaultID != vaultID || header.KDF != "argon2id" || header.Ops != 3 || header.Mem != 268435456 || header.Factors != 2 {
		return errors.New("invalid or unsupported vault key parameters")
	}
	for i, size := range []int{16, 24, 48} {
		b, err := decodeBase64(p[i+2])
		if err != nil || len(b) != size {
			return errors.New("invalid vault key envelope lengths")
		}
	}
	return nil
}

func validateChildren(children []VaultChild) error {
	if len(children) > maxVaultChildren {
		return fmt.Errorf("a vault supports at most %d items", maxVaultChildren)
	}
	seen := make(map[string]bool)
	for _, child := range children {
		if !uuidPattern.MatchString(child.ID) || seen[child.ID] {
			return errors.New("invalid or duplicate child UUID")
		}
		seen[child.ID] = true
		if child.Name != "" || child.Description != "" {
			return errors.New("child names and descriptions must be inside the ciphertext")
		}
		p := strings.Split(child.Password, ".")
		if len(child.Password) > maxVaultItemCiphertext || len(p) != 3 || p[0] != "WVI1" {
			return errors.New("invalid encrypted vault item")
		}
		nonce, err := decodeBase64(p[1])
		if err != nil || len(nonce) != 24 {
			return errors.New("invalid item nonce")
		}
		ct, err := decodeBase64(p[2])
		if err != nil || len(ct) <= 16 || len(ct) > maxVaultItemBytes+16 {
			return errors.New("invalid item ciphertext length")
		}
	}
	return nil
}

func validateStoredEntry(p PasswordEntry) error {
	if len(p.Name) > maxNameBytes || len(p.Description) > maxDescriptionBytes || len(p.Password) > maxPasswordBytes {
		return errors.New("record exceeds field limits")
	}
	if p.Type == "" || p.Type == "text" {
		if p.VaultID != "" || p.Revision != 0 || p.Children != nil {
			return errors.New("ordinary records cannot have vault fields")
		}
		return nil
	}
	if p.Type != "vault" || !uuidPattern.MatchString(p.VaultID) || p.Revision < 1 || p.Revision >= 1<<53 {
		return errors.New("invalid vault type, identifier or revision")
	}
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("vault name cannot be empty")
	}
	if err := validateWrappedKey(p.Password, p.VaultID); err != nil {
		return err
	}
	if err := validateChildren(p.Children); err != nil {
		return err
	}
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if len(b) > maxVaultBytes {
		return errors.New("vault exceeds the 24 MiB limit")
	}
	return nil
}

func createVaultFields(p *PasswordEntry, u passwordUpdate, entries []PasswordEntry) error {
	if u.Type != nil {
		p.Type = *u.Type
	}
	if p.Type != "vault" {
		if u.VaultID != nil || u.Children != nil || u.Revision != nil {
			return errors.New("vault fields require type vault")
		}
		return validateStoredEntry(*p)
	}
	if u.VaultID == nil || u.Children == nil || u.Password == nil || (u.Revision != nil && *u.Revision != 0) {
		return errors.New("new vault requires vaultId, encrypted key, children and revision 0")
	}
	p.VaultID, p.Revision = *u.VaultID, 1
	p.Children = append([]VaultChild(nil), (*u.Children)...)
	for _, existing := range entries {
		if existing.VaultID == p.VaultID {
			return errors.New("vault identifier already exists; refresh before retrying creation")
		}
	}
	return validateStoredEntry(*p)
}

func updateVaultFields(p *PasswordEntry, u passwordUpdate) error {
	if p.Type != "vault" {
		if u.VaultID != nil || u.Children != nil || u.Revision != nil || (u.Type != nil && *u.Type != p.Type) {
			return errors.New("record type cannot change; create a new vault")
		}
		return nil
	}
	if u.Revision == nil || *u.Revision != p.Revision {
		return errVaultConflict
	}
	if p.Revision >= (1<<53)-1 {
		return errors.New("vault revision space exhausted")
	}
	if u.Type == nil || *u.Type != "vault" || u.VaultID == nil || *u.VaultID != p.VaultID || u.Children == nil || u.Password == nil || u.Name == nil || u.Description == nil {
		return errors.New("vault updates must contain the complete vault with an unchanged identifier")
	}
	candidate := *p
	candidate.Name, candidate.Description, candidate.Password = *u.Name, *u.Description, *u.Password
	candidate.Children = append([]VaultChild(nil), (*u.Children)...)
	candidate.Revision++
	if err := validateStoredEntry(candidate); err != nil {
		return err
	}
	*p = candidate
	return nil
}

// Detached snapshots preserve failed-write rollback and allow encoding GET
// responses outside the mutex without sharing nested slices with writers.
func cloneEntries(entries []PasswordEntry) []PasswordEntry {
	out := append([]PasswordEntry{}, entries...)
	for i := range out {
		if out[i].Children != nil {
			out[i].Children = append([]VaultChild(nil), out[i].Children...)
		}
	}
	return out
}
