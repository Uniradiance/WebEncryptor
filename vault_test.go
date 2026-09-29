package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const testVaultID = "12345678-1234-4234-8234-123456789abc"
const testChildID = "87654321-4321-4321-9321-cba987654321"

func testVault() PasswordEntry {
	header, _ := json.Marshal(map[string]any{"v": 1, "vaultId": testVaultID, "kdf": "argon2id", "ops": 3, "mem": 268435456, "factors": 2})
	b64 := base64.StdEncoding.EncodeToString
	return PasswordEntry{Type: "vault", VaultID: testVaultID, Name: "Personal", Revision: 0,
		Password: "WVK1." + b64(header) + "." + b64(make([]byte, 16)) + "." + b64(make([]byte, 24)) + "." + b64(make([]byte, 48)),
		Children: []VaultChild{{ID: testChildID, Password: "WVI1." + b64(make([]byte, 24)) + "." + b64(make([]byte, 17))}},
	}
}

func vaultJSON(v PasswordEntry) string {
	b, _ := json.Marshal(v)
	var data map[string]any
	json.Unmarshal(b, &data)
	delete(data, "id")
	b, _ = json.Marshal(data)
	return string(b)
}

func TestVaultRoundtripAndRevisionConflicts(t *testing.T) {
	s := newTestServer(t)
	request(s, "POST", "/api/passwords", `{"name":"legacy","password":"WE2.old"}`)
	v := testVault()
	if w := request(s, "POST", "/api/passwords", vaultJSON(v)); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if s.nextID != 3 || s.db[1].Revision != 1 {
		t.Fatal("child consumed top-level IDs or revision not initialized")
	}
	assertDiskMatches(t, s)
	if w := request(s, "POST", "/api/passwords", vaultJSON(v)); w.Code != 400 {
		t.Fatal("duplicate vault accepted")
	}
	v = s.db[1]
	v.Name = "Renamed"
	if w := request(s, "PUT", "/api/passwords/2", vaultJSON(v)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(s, "PUT", "/api/passwords/2", vaultJSON(v)); w.Code != 409 {
		t.Fatal("stale revision overwrote vault")
	}
	if w := request(s, "PUT", "/api/passwords/2", `{"name":"old client"}`); w.Code != 409 {
		t.Fatal("old client modified vault")
	}
	if s.db[1].Revision != 2 || s.db[1].Name != "Renamed" {
		t.Fatal("conflict modified state")
	}
	s = &server{dbPath: s.dbPath, token: "test-token"}
	if err := s.loadDB(); err != nil {
		t.Fatal(err)
	}
	assertDiskMatches(t, s)
	if w := request(s, "DELETE", "/api/passwords/2", ""); w.Code != 409 {
		t.Fatal("vault deletion without revision accepted")
	}
	r := httptest.NewRequest("DELETE", "/api/passwords/2", nil)
	r.Header.Set("X-Auth-Token", "test-token")
	r.Header.Set("If-Match", `"2"`)
	w := httptest.NewRecorder()
	s.apiHandler(w, r)
	if w.Code != 204 || len(s.db) != 1 || s.db[0].Type != "" {
		t.Fatal("vault deletion touched legacy data")
	}
	assertDiskMatches(t, s)
}

func TestEmptyVaultAndNestedRollback(t *testing.T) {
	s := newTestServer(t)
	v := testVault()
	v.Children = nil
	// Creation explicitly requires [] even though persistence can omit empty children.
	body := strings.TrimSuffix(vaultJSON(v), "}") + `,"children":[]}`
	if w := request(s, "POST", "/api/passwords", body); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	s = &server{dbPath: s.dbPath, token: "test-token"}
	if err := s.loadDB(); err != nil {
		t.Fatal(err)
	}
	assertDiskMatches(t, s)
	original := cloneEntries(s.db)
	v = s.db[0]
	v.Children = testVault().Children
	path := s.dbPath
	s.dbPath = filepath.Join(filepath.Dir(path), "missing", "passwords.json")
	if w := request(s, "PUT", "/api/passwords/1", vaultJSON(v)); w.Code != 500 {
		t.Fatal(w.Body.String())
	}
	if !reflect.DeepEqual(original, s.db) {
		t.Fatal("failed nested update changed live memory")
	}
	s.dbPath = path
	assertDiskMatches(t, s)
}

func TestVaultValidationAndCorruptFile(t *testing.T) {
	s := newTestServer(t)
	good := testVault()
	for _, mutate := range []func(*PasswordEntry){
		func(v *PasswordEntry) { v.VaultID = "bad" },
		func(v *PasswordEntry) { v.Password = "raw-key" },
		func(v *PasswordEntry) { v.Type = "folder" },
		func(v *PasswordEntry) { v.Children = append(v.Children, v.Children[0]) },
		func(v *PasswordEntry) { v.Children[0].Name = "plaintext account" },
		func(v *PasswordEntry) { v.Children[0].Password = "plaintext password" },
		func(v *PasswordEntry) { v.Children[0].ID = "bad" },
		func(v *PasswordEntry) { v.Revision = 2 },
	} {
		v := good
		v.Children = append([]VaultChild{}, good.Children...)
		mutate(&v)
		if w := request(s, "POST", "/api/passwords", vaultJSON(v)); w.Code != 400 {
			t.Fatalf("invalid vault accepted: %d %s", w.Code, w.Body.String())
		}
	}
	var fields map[string]any
	json.Unmarshal([]byte(vaultJSON(good)), &fields)
	children := fields["children"].([]any)
	children[0].(map[string]any)["children"] = []any{}
	body, _ := json.Marshal(fields)
	if w := request(s, "POST", "/api/passwords", string(body)); w.Code != 400 {
		t.Fatal("recursive vault accepted")
	}
	if len(s.db) != 0 {
		t.Fatal("invalid vault persisted")
	}
	if w := request(s, "POST", "/api/passwords", vaultJSON(good)); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	broken := s.db[0]
	broken.Children[0].Password = "corrupt"
	data, _ := json.Marshal(databaseFile{NextID: 2, Entries: []PasswordEntry{broken}})
	if err := os.WriteFile(s.dbPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.loadDB(); err == nil {
		t.Fatal("corrupt nested database silently loaded")
	}
	after, _ := os.ReadFile(s.dbPath)
	if string(after) != string(data) {
		t.Fatal("corrupt file overwritten")
	}
}

func TestConcurrentVaultWritersAndReaders(t *testing.T) {
	s := newTestServer(t)
	request(s, "POST", "/api/passwords", vaultJSON(testVault()))
	v := s.db[0]
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- request(s, "PUT", "/api/passwords/1", vaultJSON(v)).Code }()
	}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := request(s, "GET", "/api/passwords", ""); w.Code != 200 {
				t.Error(w.Code)
			}
		}()
	}
	wg.Wait()
	close(results)
	codes := map[int]int{}
	for code := range results {
		codes[code]++
	}
	if codes[200] != 1 || codes[409] != 1 {
		t.Fatal("concurrent writers did not detect conflict", codes)
	}
	assertDiskMatches(t, s)
}
