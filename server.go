// WebEncryptor single-file server (Go)
//
// A fully self-contained HTTPS server compiled to a single executable with no
// runtime dependencies:
//   - Static web app: htdocs/ is embedded into the binary at build time
//     (--dir serves any external static directory instead)
//   - REST API: /api/passwords password management (X-Auth-Token auth)
//   - Self-signed certificate generated automatically on first run (cert/);
//     passwords.json lives next to the executable
//   - Default port 8443 (>1024, no root required), auto-opens the browser
//
// Cross-compilation: see build.sh. Pure Go standard library; runs on
// Windows / macOS / Linux / ARM.

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math/big"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed all:htdocs
var embeddedFS embed.FS

// PasswordEntry is one password record persisted in passwords.json.
type PasswordEntry struct {
	ID          int          `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Password    string       `json:"password"`
	Type        string       `json:"type,omitempty"`
	VaultID     string       `json:"vaultId,omitempty"`
	Revision    uint64       `json:"revision,omitempty"`
	Children    []VaultChild `json:"children,omitempty"`
}

// Base64 expansion of 4 MiB UTF-8 plaintext plus salt, nonce, tag and separators.
const maxPlaintextBytes = 4 * 1024 * 1024
const maxPasswordBytes = 4*((maxPlaintextBytes+2)/3) + 71
const maxNameBytes = 4096
const maxDescriptionBytes = 65536
const maxRequestBytes = 32 * 1024 * 1024

type databaseFile struct {
	NextID  int             `json:"nextId"`
	Entries []PasswordEntry `json:"entries"`
}

type server struct {
	mu     sync.Mutex
	db     []PasswordEntry
	nextID int
	token  string
	dbPath string
}

var httpSrv *http.Server

// --- database persistence ---

func (s *server) loadDB() error {
	data, err := os.ReadFile(s.dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			s.db, s.nextID = []PasswordEntry{}, 1
			log.Printf("Database file '%s' does not exist; starting with an empty database.", s.dbPath)
			return nil
		}
		return err
	}
	var stored databaseFile
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		return fmt.Errorf("cannot parse database %s (original file preserved): %w", s.dbPath, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("database must contain one JSON object (original file preserved)")
	}
	if stored.NextID < 1 || stored.Entries == nil {
		return errors.New("invalid database nextId or entries (original file preserved)")
	}
	entries, nextID := stored.Entries, stored.NextID
	seen := make(map[int]bool, len(entries))
	vaultIDs := make(map[string]bool)
	for _, p := range entries {
		if err := validateStoredEntry(p); err != nil {
			return fmt.Errorf("invalid record %d (original file preserved): %w", p.ID, err)
		}
		if p.Type == "vault" {
			if vaultIDs[p.VaultID] {
				return errors.New("duplicate vault identifier (original file preserved)")
			}
			vaultIDs[p.VaultID] = true
		}
		if p.ID < 1 || p.ID == int(^uint(0)>>1) || uint64(p.ID) >= 1<<53 || seen[p.ID] {
			return fmt.Errorf("invalid or duplicate database ID %d (original file preserved)", p.ID)
		}
		seen[p.ID] = true
		if p.ID >= nextID {
			return errors.New("database nextId must exceed all record IDs (original file preserved)")
		}
	}
	if uint64(nextID) > 1<<53 {
		return errors.New("database nextId exceeds the safe integer range (original file preserved)")
	}
	s.db, s.nextID = entries, nextID
	log.Printf("Loaded %d password records from '%s'.", len(s.db), s.dbPath)
	return nil
}

// commitDB must be called with s.mu held. Publish memory only after rename;
// sync both the new file and (on Unix) its directory before acknowledging it.
func (s *server) commitDB(next []PasswordEntry) error {
	nextID := s.nextID
	for _, entry := range next {
		if entry.ID >= nextID {
			nextID = entry.ID + 1
		}
	}
	data, err := json.MarshalIndent(databaseFile{NextID: nextID, Entries: next}, "", "    ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.dbPath)
	f, err := os.CreateTemp(dir, ".passwords-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), s.dbPath); err != nil {
		return err
	}
	// Rename committed the file: keep memory consistent even if directory
	// sync subsequently fails. That failure still produces an API error.
	s.db, s.nextID = next, nextID
	if runtime.GOOS != "windows" {
		d, err := os.Open(dir)
		if err != nil {
			return err
		}
		err = d.Sync()
		closeErr := d.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	log.Printf("Database saved to '%s' (%d records).", s.dbPath, len(next))
	return nil
}

func databaseError(w http.ResponseWriter, err error) {
	log.Printf("Database persistence failed: %v", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{
		"error": "Could not confirm saving to disk. Refresh the list before retrying."})
}

// --- HTTP helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
}

type passwordUpdate struct {
	Name, Description, Password *string
	Type, VaultID               *string
	Revision                    *uint64
	Children                    *[]VaultChild
}

// Read the entire bounded body: reject trailing JSON and oversized requests
// even when a valid object appears at the beginning.
func decodePasswordUpdate(w http.ResponseWriter, r *http.Request) (passwordUpdate, bool) {
	var update passwordUpdate
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Request exceeds the 32 MiB JSON limit."})
		} else {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Could not read request body."})
		}
		return update, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Expected one JSON object."})
		return update, false
	}
	for field, raw := range fields {
		var target **string
		var limit int
		switch field {
		case "revision":
			var value uint64
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil || value >= 1<<53 {
				writeJSON(w, 400, map[string]string{"error": "revision must be a safe non-negative integer."})
				return update, false
			}
			update.Revision = &value
			continue
		case "children":
			var value []VaultChild
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&value) != nil || value == nil {
				writeJSON(w, 400, map[string]string{"error": "children must be an array of encrypted items without nested children."})
				return update, false
			}
			if err := validateChildren(value); err != nil {
				writeJSON(w, 400, map[string]string{"error": err.Error()})
				return update, false
			}
			update.Children = &value
			continue
		case "type":
			target, limit = &update.Type, 16
		case "vaultId":
			target, limit = &update.VaultID, 36
		case "name":
			target, limit = &update.Name, maxNameBytes
		case "description":
			target, limit = &update.Description, maxDescriptionBytes
		case "password":
			target, limit = &update.Password, maxPasswordBytes
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Unknown field: " + field})
			return update, false
		}
		var value string
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": field + " must be a string (null is not allowed)."})
			return update, false
		}
		if len(value) > limit {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("%s exceeds %d UTF-8 bytes.", field, limit)})
			return update, false
		}
		*target = &value
	}
	return update, true
}

// statusRecorder captures the status code for access logs.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func withLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		// Static is embedded & immutable per binary (content never changes), but
		// the same URLs serve fresh builds, so use revalidation caching: paired
		// with strong ETags this lets repeat visits 304 the ~1.4 MB asset set.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		start := time.Now()
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// staticCache serves static files with strong ETags (sha256 of the content,
// cached per path) and honors If-None-Match -> 304. The embedded FS has zero
// ModTime, so without this every visit fully re-downloads the web app.
type staticCache struct {
	fs    fs.FS
	mu    sync.Mutex
	etags map[string]string
}

func newStaticCache(fsys fs.FS) *staticCache {
	return &staticCache{fs: fsys, etags: make(map[string]string)}
}

func (c *staticCache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if etag, ok := c.etag(r.URL.Path); ok {
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("ETag", etag)
			if inm := r.Header.Get("If-None-Match"); inm != "" && inm == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
	}
	http.FileServer(http.FS(c.fs)).ServeHTTP(w, r)
}

func (c *staticCache) etag(p string) (string, bool) {
	path := strings.TrimPrefix(p, "/")
	c.mu.Lock()
	e, ok := c.etags[path]
	c.mu.Unlock()
	if ok {
		return e, true
	}
	data, err := fs.ReadFile(c.fs, path)
	if err != nil {
		return "", false // directories (index.html resolution) fall through to FileServer
	}
	sum := sha256.Sum256(data)
	// 16 hex chars of the digest keep the header short; collision risk is nil here.
	e = `"` + fmt.Sprintf("%x", sum[:8]) + `"`
	c.mu.Lock()
	c.etags[path] = e
	c.mu.Unlock()
	return e, true
}

// --- API routes ---

func (s *server) apiHandler(w http.ResponseWriter, r *http.Request) {
	// API responses carry password data: never let them be cached.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, X-Auth-Token, If-Match")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if s.token != "" && r.Header.Get("X-Auth-Token") != s.token {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error": "Unauthorized: missing or invalid X-Auth-Token header."})
		return
	}

	path := strings.TrimSuffix(r.URL.Path, "/")

	switch {
	case path == "/api/passwords":
		switch r.Method {
		case http.MethodGet:
			s.mu.Lock()
			list := cloneEntries(s.db)
			s.mu.Unlock()
			writeJSON(w, http.StatusOK, list)
		case http.MethodPost:
			body, ok := decodePasswordUpdate(w, r)
			if !ok {
				return
			}
			s.mu.Lock()
			if s.nextID == int(^uint(0)>>1) || uint64(s.nextID) >= 1<<53 {
				s.mu.Unlock()
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Record ID space exhausted."})
				return
			}
			entry := PasswordEntry{ID: s.nextID}
			if body.Name != nil {
				entry.Name = *body.Name
			}
			if body.Description != nil {
				entry.Description = *body.Description
			}
			if body.Password != nil {
				entry.Password = *body.Password
			}
			if err := createVaultFields(&entry, body, s.db); err != nil {
				s.mu.Unlock()
				writeJSON(w, 400, map[string]string{"error": err.Error()})
				return
			}
			next := append(append([]PasswordEntry{}, s.db...), entry)
			err := s.commitDB(next)
			s.mu.Unlock()
			if err != nil {
				databaseError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, entry)
		default:
			methodNotAllowed(w)
		}

	case strings.HasPrefix(path, "/api/passwords/"):
		id, err := strconv.Atoi(strings.TrimPrefix(path, "/api/passwords/"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not Found"})
			return
		}
		switch r.Method {
		case http.MethodPut:
			body, ok := decodePasswordUpdate(w, r)
			if !ok {
				return
			}
			s.mu.Lock()
			next := cloneEntries(s.db)
			var target *PasswordEntry
			for i := range next {
				if next[i].ID == id {
					target = &next[i]
					break
				}
			}
			if target == nil {
				s.mu.Unlock()
				writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("Password with id %d not found.", id)})
				return
			}
			if err := updateVaultFields(target, body); err != nil {
				s.mu.Unlock()
				status := 400
				if errors.Is(err, errVaultConflict) {
					status = 409
				}
				writeJSON(w, status, map[string]string{"error": err.Error()})
				return
			}
			if body.Name != nil {
				target.Name = *body.Name
			}
			if body.Description != nil {
				target.Description = *body.Description
			}
			if body.Password != nil {
				target.Password = *body.Password
			}
			updated := *target
			err := s.commitDB(next)
			s.mu.Unlock()
			if err != nil {
				databaseError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, updated)
		case http.MethodDelete:
			s.mu.Lock()
			for _, p := range s.db {
				if p.ID == id && p.Type == "vault" && r.Header.Get("If-Match") != fmt.Sprintf("\"%d\"", p.Revision) {
					s.mu.Unlock()
					writeJSON(w, 409, map[string]string{"error": errVaultConflict.Error()})
					return
				}
			}
			before := len(s.db)
			filtered := make([]PasswordEntry, 0, len(s.db))
			for _, p := range s.db {
				if p.ID != id {
					filtered = append(filtered, p)
				}
			}
			removed := len(filtered) != before
			if !removed {
				s.mu.Unlock()
				writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("Password with id %d not found.", id)})
				return
			}
			err := s.commitDB(filtered)
			s.mu.Unlock()
			if err != nil {
				databaseError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			methodNotAllowed(w)
		}

	case path == "/api/shutdown" && r.Method == http.MethodPost:
		log.Println("Shutdown requested (POST /api/shutdown)...")
		writeJSON(w, http.StatusOK, map[string]string{"message": "Server is shutting down..."})
		go shutdownServer()

	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not Found"})
	}
}

// --- self-signed certificate ---

func generateCert(dir, cn, org string, sans []string, days int) error {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	now := time.Now()
	template := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Country:            []string{"CN"},
			Province:           []string{"Beijing"},
			Locality:           []string{"Beijing"},
			Organization:       []string{org},
			OrganizationalUnit: []string{"WebEncryptor"},
			CommonName:         cn,
		},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(0, 0, days),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, san := range sans {
		if ip := net.ParseIP(san); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, san)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	certFile := filepath.Join(dir, "cert.pem")
	keyFile := filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0o600); err != nil {
		return err
	}
	log.Printf("Self-signed certificate generated (%d days, SAN: %s): %s, %s", days, strings.Join(sans, ", "), certFile, keyFile)
	return nil
}

func ensureCert(dir, cn, org string, sans []string, days int) (string, string, error) {
	certFile := filepath.Join(dir, "cert.pem")
	keyFile := filepath.Join(dir, "key.pem")
	if _, err := os.Stat(certFile); err == nil {
		if _, err := os.Stat(keyFile); err == nil {
			return certFile, keyFile, nil
		}
	}
	log.Println("Certificate not found; generating a self-signed certificate...")
	if err := generateCert(dir, cn, org, sans, days); err != nil {
		return "", "", err
	}
	return certFile, keyFile, nil
}

// --- open the browser ---

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("Could not open the browser automatically: %v", err)
	}
}

func shutdownServer() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if httpSrv != nil {
		_ = httpSrv.Shutdown(ctx)
	}
}

// --- main entry ---

func main() {
	log.SetFlags(log.LstdFlags)

	var (
		port      = flag.Int("port", 8443, "Listen port (default 8443, >1024 needs no root)")
		token     = flag.String("token", "", "API access token: when set, every /api/ request must carry the header X-Auth-Token; without it anyone who can reach this port can read/write the password database")
		httpOnly  = flag.Bool("http", false, "Serve plain HTTP (no TLS; for LAN or reverse-proxy setups)")
		dir       = flag.String("dir", "", "External static directory; defaults to the embedded htdocs (compiled in)")
		noBrowser = flag.Bool("no-browser", false, "Do not open the browser automatically")
		debug     = flag.Bool("debug", false, "Also write logs to server.log")
		cn        = flag.String("cn", "localhost", "Certificate Common Name")
		org       = flag.String("org", "WebEncryptor", "Certificate organization")
		san       = flag.String("san", "localhost,127.0.0.1", "Certificate SANs (comma-separated domains or IPs)")
		days      = flag.Int("days", 365, "Certificate validity in days")
	)
	flag.Parse()

	// Data files, certificates and logs live next to the executable -> the
	// whole folder is portable and can be copied as-is.
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	baseDir := filepath.Dir(exe)
	if cwd, err := os.Getwd(); err == nil {
		// During development (go run) the executable lives in a temp dir;
		// fall back to the working directory.
		if strings.Contains(baseDir, os.TempDir()) || baseDir == "." {
			baseDir = cwd
		}
	}

	if *debug {
		logFile, err := os.OpenFile(filepath.Join(baseDir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err == nil {
			log.SetOutput(io.MultiWriter(os.Stderr, logFile))
			log.Printf("Logs are also written to %s", filepath.Join(baseDir, "server.log"))
		}
	}

	dbPath := filepath.Join(baseDir, "passwords.json")

	s := &server{token: *token, dbPath: dbPath}
	if err := s.loadDB(); err != nil {
		log.Fatalf("Failed to read the database: %v", err)
	}

	// Static files: --dir wins, otherwise the embedded htdocs.
	var staticFS fs.FS
	if *dir != "" {
		log.Printf("Using external static directory: %s", *dir)
		staticFS = os.DirFS(*dir)
	} else {
		staticFS, err = fs.Sub(embeddedFS, "htdocs")
		if err != nil {
			log.Fatalf("Failed to load embedded static files: %v", err)
		}
	}
	// Fill in MIME types (some platforms have incomplete system tables).
	for ext, typ := range map[string]string{
		".js":          "text/javascript; charset=utf-8",
		".mjs":         "text/javascript; charset=utf-8",
		".wasm":        "application/wasm",
		".webmanifest": "application/manifest+json",
		".svg":         "image/svg+xml",
		".json":        "application/json; charset=utf-8",
	} {
		mime.AddExtensionType(ext, typ)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/", s.apiHandler)
	mux.Handle("/", newStaticCache(staticFS))
	handler := withLog(mux)

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if isPermissionError(err) {
			log.Printf("Fatal error: cannot bind port %d (permission denied or already in use).", *port)
			log.Printf("Tip: ports < 1024 need root/admin; use --port 8443 or higher instead.")
		} else {
			log.Printf("Fatal error: cannot listen on %s: %v", addr, err)
		}
		os.Exit(1)
	}

	scheme := "http"
	if !*httpOnly {
		scheme = "https"
		certDir := filepath.Join(baseDir, "cert")
		certFile, keyFile, err := ensureCert(certDir, *cn, *org, splitCSV(*san), *days)
		if err != nil {
			log.Fatalf("Certificate generation/loading failed: %v", err)
		}
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			log.Fatalf("Certificate loading failed: %v", err)
		}
		ln = tls.NewListener(ln, &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		})
	}

	httpSrv = &http.Server{Handler: handler}
	url := fmt.Sprintf("%s://127.0.0.1:%d/index.html", scheme, *port)
	log.Printf("%s server starting on %s", strings.ToUpper(scheme), url)
	if *token != "" {
		log.Printf("API access token: %s", *token)
		log.Printf("   The browser asks for this token on first visit to the Manager (stored in localStorage).")
	} else {
		log.Printf("WARNING: no API access token set (--token).")
		log.Printf("   Anyone who can reach this port can read/write the password database; run: webencryptor --token <random-string>")
	}

	// Graceful shutdown on Ctrl+C / SIGTERM.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("Exit signal received; shutting down...")
		shutdownServer()
	}()

	if !*noBrowser {
		time.AfterFunc(500*time.Millisecond, func() { openBrowser(url) })
	}

	if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Printf("Server error: %v", err)
		os.Exit(1)
	}
	log.Println("Server has been shut down.")
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func isPermissionError(err error) bool {
	return errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM)
}
