// WebEncryptor 单文件服务器 (Go 版)
//
// 一个完全自包含的 HTTPS 服务器，编译为单个可执行文件，无任何运行时依赖：
//   - 静态网页：htdocs/ 已嵌入二进制（构建时打包），也可用 --dir 指向任意静态目录
//   - REST API：/api/passwords 密码管理（X-Auth-Token 鉴权）
//   - 首次运行自动生成自签证书（cert/），passwords.json 与可执行文件同目录
//   - 默认端口 8443（>1024，无需 root），自动打开浏览器
//
// 交叉编译见 build.sh。纯 Go 标准库实现，可运行于 Windows / macOS / Linux / ARM。

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
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

// PasswordEntry 为 passwords.json 中保存的密码条目。
type PasswordEntry struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Password    string `json:"password"`
}

type server struct {
	mu     sync.Mutex
	db     []PasswordEntry
	nextID int
	token  string
	dbPath string
}

var httpSrv *http.Server

// --- 数据库持久化 ---

func (s *server) loadDB() error {
	s.nextID = 1 // id 从 1 开始
	data, err := os.ReadFile(s.dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("数据库文件 '%s' 不存在，将使用空数据库启动。", s.dbPath)
			return nil
		}
		return err
	}
	if err := json.Unmarshal(data, &s.db); err != nil {
		log.Printf("错误: 无法解析 '%s'，将使用空数据库启动。", s.dbPath)
		s.db = nil
		return nil
	}
	for _, p := range s.db {
		if p.ID >= s.nextID {
			s.nextID = p.ID + 1
		}
	}
	log.Printf("成功从 '%s' 加载 %d 条密码数据。", s.dbPath, len(s.db))
	return nil
}

// saveDB 原子写盘：先写临时文件再 rename，避免写一半损坏数据库。
func (s *server) saveDB() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(s.db, "", "    ")
	if err != nil {
		return err
	}
	tmp := s.dbPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.dbPath); err != nil {
		return err
	}
	log.Printf("数据库已保存到 '%s'（%d 条）。", s.dbPath, len(s.db))
	return nil
}

// --- HTTP 工具 ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
}

// statusRecorder 用于访问日志中记录状态码。
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
		start := time.Now()
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// --- API 路由 ---

func (s *server) apiHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, X-Auth-Token")

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
			list := make([]PasswordEntry, len(s.db))
			copy(list, s.db)
			s.mu.Unlock()
			writeJSON(w, http.StatusOK, list)
		case http.MethodPost:
			var body struct {
				Name        *string `json:"name"`
				Description *string `json:"description"`
				Password    *string `json:"password"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Bad Request: " + err.Error()})
				return
			}
			s.mu.Lock()
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
			s.db = append(s.db, entry)
			s.nextID++
			s.mu.Unlock()
			if err := s.saveDB(); err != nil {
				log.Printf("保存数据库失败: %v", err)
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
			var body map[string]any
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Bad Request: Invalid JSON."})
				return
			}
			s.mu.Lock()
			var target *PasswordEntry
			for i := range s.db {
				if s.db[i].ID == id {
					target = &s.db[i]
					break
				}
			}
			if target == nil {
				s.mu.Unlock()
				writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("Password with id %d not found.", id)})
				return
			}
			if v, ok := body["name"]; ok {
				target.Name = fmt.Sprintf("%v", v)
			}
			if v, ok := body["description"]; ok {
				target.Description = fmt.Sprintf("%v", v)
			}
			if v, ok := body["password"]; ok {
				target.Password = fmt.Sprintf("%v", v)
			}
			updated := *target
			s.mu.Unlock()
			if err := s.saveDB(); err != nil {
				log.Printf("保存数据库失败: %v", err)
			}
			writeJSON(w, http.StatusOK, updated)
		case http.MethodDelete:
			s.mu.Lock()
			before := len(s.db)
			filtered := s.db[:0]
			for _, p := range s.db {
				if p.ID != id {
					filtered = append(filtered, p)
				}
			}
			s.db = filtered
			removed := len(s.db) != before
			s.mu.Unlock()
			if !removed {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("Password with id %d not found.", id)})
				return
			}
			if err := s.saveDB(); err != nil {
				log.Printf("保存数据库失败: %v", err)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			methodNotAllowed(w)
		}

	case path == "/api/shutdown" && r.Method == http.MethodPost:
		log.Println("收到关闭请求 (POST /api/shutdown)...")
		writeJSON(w, http.StatusOK, map[string]string{"message": "Server is shutting down..."})
		go shutdownServer()

	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not Found"})
	}
}

// --- 自签证书 ---

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
	log.Printf("已生成自签证书 (有效期 %d 天, SAN: %s): %s, %s", days, strings.Join(sans, ", "), certFile, keyFile)
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
	log.Println("证书不存在，正在生成自签证书...")
	if err := generateCert(dir, cn, org, sans, days); err != nil {
		return "", "", err
	}
	return certFile, keyFile, nil
}

// --- 打开浏览器 ---

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
		log.Printf("无法自动打开浏览器: %v", err)
	}
}

func shutdownServer() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if httpSrv != nil {
		_ = httpSrv.Shutdown(ctx)
	}
}

// --- 主入口 ---

func main() {
	log.SetFlags(log.LstdFlags)

	var (
		port      = flag.Int("port", 8443, "监听端口 (默认 8443, >1024 无需 root)")
		token     = flag.String("token", "", "API 访问令牌: 设置后所有 /api/ 请求必须携带请求头 X-Auth-Token; 不设置则局域网内任何能访问本端口的人都可以读写密码库")
		httpOnly  = flag.Bool("http", false, "使用纯 HTTP (不启用 TLS, 适合内网或反代场景)")
		dir       = flag.String("dir", "", "静态文件目录; 默认使用内嵌的 htdocs (构建时打包)")
		noBrowser = flag.Bool("no-browser", false, "不自动打开浏览器")
		debug     = flag.Bool("debug", false, "同时将日志写入 server.log")
		cn        = flag.String("cn", "localhost", "证书通用名称 (Common Name)")
		org       = flag.String("org", "WebEncryptor", "证书组织名称")
		san       = flag.String("san", "localhost,127.0.0.1", "证书 SAN (逗号分隔的域名或 IP)")
		days      = flag.Int("days", 365, "证书有效天数")
	)
	flag.Parse()

	// 数据文件、证书、日志都在可执行文件所在目录 → 整个文件夹即插即用、可整体拷贝。
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	baseDir := filepath.Dir(exe)
	if cwd, err := os.Getwd(); err == nil {
		// 开发时 (go run) 可执行文件在临时目录，回退到当前工作目录。
		if strings.Contains(baseDir, os.TempDir()) || baseDir == "." {
			baseDir = cwd
		}
	}

	if *debug {
		logFile, err := os.OpenFile(filepath.Join(baseDir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err == nil {
			log.SetOutput(io.MultiWriter(os.Stderr, logFile))
			log.Printf("日志已同时写入 %s", filepath.Join(baseDir, "server.log"))
		}
	}

	dbPath := filepath.Join(baseDir, "passwords.json")

	s := &server{token: *token, dbPath: dbPath}
	if err := s.loadDB(); err != nil {
		log.Fatalf("读取数据库失败: %v", err)
	}

	// 静态文件: --dir 优先，否则用内嵌的 htdocs。
	var staticFS fs.FS
	if *dir != "" {
		log.Printf("使用外部静态目录: %s", *dir)
		staticFS = os.DirFS(*dir)
	} else {
		staticFS, err = fs.Sub(embeddedFS, "htdocs")
		if err != nil {
			log.Fatalf("内嵌静态文件加载失败: %v", err)
		}
	}
	// 补全 MIME 类型 (某些平台系统表缺失)。
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
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	handler := withLog(mux)

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if isPermissionError(err) {
			log.Printf("致命错误: 无法绑定端口 %d (权限不足或被占用)。", *port)
			log.Printf("提示: 端口 < 1024 需要 root/管理员权限，请改用 --port 8443 或更高端口。")
		} else {
			log.Printf("致命错误: 无法监听 %s: %v", addr, err)
		}
		os.Exit(1)
	}

	scheme := "http"
	if !*httpOnly {
		scheme = "https"
		certDir := filepath.Join(baseDir, "cert")
		certFile, keyFile, err := ensureCert(certDir, *cn, *org, splitCSV(*san), *days)
		if err != nil {
			log.Fatalf("证书生成/加载失败: %v", err)
		}
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			log.Fatalf("证书加载失败: %v", err)
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
		log.Printf("🔑 API 访问令牌: %s", *token)
		log.Printf("   浏览器首次访问 Manager 时会提示输入该令牌 (保存在 localStorage)。")
	} else {
		log.Printf("⚠️ 警告: 未设置 API 访问令牌 (--token)。")
		log.Printf("   局域网内任何能访问本端口的人都可以读写密码库, 建议: webencryptor --token <随机字符串>")
	}

	// Ctrl+C / SIGTERM 优雅关闭。
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("收到退出信号, 正在关闭...")
		shutdownServer()
	}()

	if !*noBrowser {
		time.AfterFunc(500*time.Millisecond, func() { openBrowser(url) })
	}

	if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Printf("服务器错误: %v", err)
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
