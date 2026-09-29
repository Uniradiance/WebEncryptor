package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func request(s *server, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Auth-Token", "test-token")
	w := httptest.NewRecorder()
	s.apiHandler(w, r)
	return w
}

func newTestServer(t *testing.T) *server {
	t.Helper()
	s := &server{dbPath: filepath.Join(t.TempDir(), "passwords.json"), token: "test-token"}
	if err := s.loadDB(); err != nil {
		t.Fatal(err)
	}
	return s
}

func assertDiskMatches(t *testing.T, s *server) {
	t.Helper()
	data, err := os.ReadFile(s.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	var stored databaseFile
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.NextID != s.nextID || !reflect.DeepEqual(stored.Entries, s.db) {
		t.Fatalf("disk=%v memory=%v nextID=%d", stored, s.db, s.nextID)
	}
}

func TestDeletedIDsNeverReusedAfterRestart(t *testing.T) {
	s := newTestServer(t)
	for i := 0; i < 3; i++ {
		if w := request(s, "POST", "/api/passwords", `{"name":"original"}`); w.Code != 201 {
			t.Fatal(w.Code)
		}
	}
	for _, id := range []int{3, 2, 1} {
		if w := request(s, "DELETE", fmt.Sprintf("/api/passwords/%d", id), ""); w.Code != 204 {
			t.Fatal(w.Code)
		}
		s = &server{dbPath: s.dbPath, token: "test-token"}
		if err := s.loadDB(); err != nil {
			t.Fatal(err)
		}
		if s.nextID != 4 {
			t.Fatal("restart lost high-water mark", s.nextID)
		}
	}
	if w := request(s, "POST", "/api/passwords", `{"name":"new"}`); w.Code != 201 || s.db[0].ID != 4 {
		t.Fatal("deleted ID reused", w.Body.String())
	}
	for _, method := range []string{"DELETE", "PUT"} {
		if w := request(s, method, "/api/passwords/1", `{"name":"stale client"}`); w.Code != 404 || s.db[0].Name != "new" {
			t.Fatal("stale client changed a new record", w.Code)
		}
	}
	assertDiskMatches(t, s)
}

func TestInvalidBodiesNeverChangeDatabase(t *testing.T) {
	s := newTestServer(t)
	request(s, "POST", "/api/passwords", `{"name":"original","password":"WE2.original"}`)
	original := append([]PasswordEntry{}, s.db...)
	for _, method := range []string{"POST", "PUT"} {
		path := "/api/passwords"
		if method == "PUT" {
			path += "/1"
		}
		for _, body := range []string{
			`null`, `[]`, `"text"`, `{} {}`, `{} garbage`, `{"unknown":"x"}`,
			`{"password":null}`, `{"password":42}`, `{"password":{}}`, `{"password":[]}`,
			`{"name":null}`, `{"description":true}`,
		} {
			if w := request(s, method, path, body); w.Code != 400 {
				t.Fatalf("%s %s accepted: %d", method, body, w.Code)
			}
			if !reflect.DeepEqual(original, s.db) || s.nextID != 2 {
				t.Fatal("invalid body changed state")
			}
		}
		for _, field := range []struct {
			name  string
			limit int
		}{{"name", maxNameBytes}, {"description", maxDescriptionBytes}, {"password", maxPasswordBytes}} {
			body := fmt.Sprintf(`{"%s":"%s"}`, field.name, strings.Repeat("A", field.limit+1))
			if w := request(s, method, path, body); w.Code != 413 || !reflect.DeepEqual(original, s.db) {
				t.Fatalf("oversized %s changed state: %d", field.name, w.Code)
			}
		}
	}
	assertDiskMatches(t, s)
}

func TestFullSizeCiphertextCanBeSavedAndUpdated(t *testing.T) {
	s := newTestServer(t)
	value := strings.Repeat("A", maxPasswordBytes)
	body := `{"name":"large","password":"` + value + `"}`
	if w := request(s, "POST", "/api/passwords", body); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := s.loadDB(); err != nil || s.db[0].Password != value {
		t.Fatal("large ciphertext lost on restart", err)
	}
	if w := request(s, "PUT", "/api/passwords/1", body); w.Code != 200 {
		t.Fatal(w.Code)
	}
	assertDiskMatches(t, s)
}

func TestOversizedRequestRejectsEvenWithValidJSONPrefix(t *testing.T) {
	s := newTestServer(t)
	body := `{}` + strings.Repeat(" ", maxRequestBytes)
	for _, method := range []string{"POST", "PUT"} {
		path := "/api/passwords"
		if method == "PUT" {
			path += "/1"
		}
		if w := request(s, method, path, body); w.Code != 413 || len(s.db) != 0 || s.nextID != 1 {
			t.Fatalf("oversized request accepted: %d", w.Code)
		}
	}
}

func TestInvalidDatabaseIDsPreserveOriginal(t *testing.T) {
	for _, data := range []string{
		`{"nextId":1,"entries":[{"id":0}]}`,
		`{"nextId":2,"entries":[{"id":1},{"id":1}]}`,
		`{"nextId":9007199254740993,"entries":[{"id":9007199254740992}]}`,
		`{"nextId":1,"entries":[{"id":1}]}`,
		`{"nextId":0,"entries":[]}`,
		`{"nextId":1,"entries":null}`,
		`{"nextId":1,"entries":[],"unexpected":true}`,
		`{"nextId":1,"entries":[]} {}`,
		`[]`, `null`,
	} {
		s := newTestServer(t)
		os.WriteFile(s.dbPath, []byte(data), 0600)
		if err := s.loadDB(); err == nil {
			t.Fatal("invalid database accepted", data)
		}
		after, _ := os.ReadFile(s.dbPath)
		if string(after) != data {
			t.Fatal("invalid database overwritten")
		}
	}
}

func TestCRUDSurvivesRestart(t *testing.T) {
	s := newTestServer(t)
	if w := request(s, "POST", "/api/passwords", `{"name":"Vault","password":"WE2.test"}`); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	assertDiskMatches(t, s)
	if w := request(s, "PUT", "/api/passwords/1", `{"name":"Updated"}`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	assertDiskMatches(t, s)
	restarted := &server{dbPath: s.dbPath, token: s.token}
	if err := restarted.loadDB(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restarted.db, s.db) {
		t.Fatal("restart lost saved entries")
	}
	if w := request(restarted, "DELETE", "/api/passwords/1", ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	assertDiskMatches(t, restarted)
	if w := request(restarted, "POST", "/api/passwords", `{"name":"Next"}`); w.Code != 201 || restarted.db[0].ID != 2 {
		t.Fatal("delete reused ID", w.Body.String())
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(s.dbPath), ".passwords-*"))
	if len(leftovers) != 0 {
		t.Fatal("temporary files leaked", leftovers)
	}
}

func TestFailedWritesDoNotPublish(t *testing.T) {
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		t.Run(method, func(t *testing.T) {
			s := newTestServer(t)
			request(s, "POST", "/api/passwords", `{"name":"Original","password":"WE2.original"}`)
			originalPath := s.dbPath
			original := append([]PasswordEntry{}, s.db...)
			nextID := s.nextID
			// A nonexistent parent fails on every platform, even as root.
			s.dbPath = filepath.Join(filepath.Dir(originalPath), "missing", "passwords.json")
			path := "/api/passwords"
			if method != "POST" {
				path += "/1"
			}
			w := request(s, method, path, `{"name":"Unsaved"}`)
			if w.Code != 500 {
				t.Fatalf("false success: %d", w.Code)
			}
			if !reflect.DeepEqual(s.db, original) || s.nextID != nextID {
				t.Fatal("failed write changed memory/ID")
			}
			s.dbPath = originalPath
			assertDiskMatches(t, s)
			if w := request(s, "POST", "/api/passwords", `{"name":"Retry"}`); w.Code != 201 {
				t.Fatal("retry failed")
			}
		})
	}
}

func TestRenameFailureAndCorruptDatabase(t *testing.T) {
	s := newTestServer(t)
	if err := os.Mkdir(s.dbPath, 0700); err != nil {
		t.Fatal(err)
	}
	if w := request(s, "POST", "/api/passwords", `{"name":"Unsaved"}`); w.Code != 500 || len(s.db) != 0 {
		t.Fatal("rename failure published")
	}
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(s.dbPath), ".passwords-*"))
	if len(matches) != 0 {
		t.Fatal("failed rename leaked temporary files")
	}
	corrupt := filepath.Join(t.TempDir(), "passwords.json")
	if err := os.WriteFile(corrupt, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := (&server{dbPath: corrupt}).loadDB(); err == nil {
		t.Fatal("corrupt database silently accepted")
	}
	data, _ := os.ReadFile(corrupt)
	if string(data) != "{broken" {
		t.Fatal("corrupt database overwritten")
	}
}

func TestConcurrentSavesAndAuthentication(t *testing.T) {
	s := newTestServer(t)
	w := httptest.NewRecorder()
	s.apiHandler(w, httptest.NewRequest("POST", "/api/passwords", strings.NewReader(`{}`)))
	if w.Code != 401 {
		t.Fatal("unauthenticated write accepted")
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := request(s, "POST", "/api/passwords", fmt.Sprintf(`{"name":"item%d"}`, i))
			if w.Code != 201 {
				t.Errorf("save failed: %d", w.Code)
			}
		}(i)
	}
	wg.Wait()
	if len(s.db) != 20 || s.nextID != 21 {
		t.Fatal("concurrent saves lost entries")
	}
	assertDiskMatches(t, s)
}
