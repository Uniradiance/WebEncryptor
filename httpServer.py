# coding=utf-8
from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl
import json
import argparse
import webbrowser
import re
import os
import threading
from gen_key import generate_certificate
import sys

# 只有win才导入
if os.name == 'nt':
    import ctypes


# --- 数据持久化设置 ---
DB_FILE = 'passwords.json'
passwords_db = []
next_id = 1

def load_database():
    """服务器启动时从文件加载数据库"""
    global passwords_db, next_id
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, 'r', encoding='utf-8') as f:
                passwords_db = json.load(f)
            if not isinstance(passwords_db, list):
                print(f"警告: 数据库文件 '{DB_FILE}' 格式不正确，已重置。")
                passwords_db = []
            
            if passwords_db:
                max_id = max(p.get('id', 0) for p in passwords_db)
                next_id = max_id + 1
            else:
                next_id = 1
            print(f"成功从 '{DB_FILE}' 加载 {len(passwords_db)} 条密码数据。")
        except (json.JSONDecodeError, TypeError):
            print(f"错误: 无法解析 '{DB_FILE}'。将使用空数据库启动。")
            passwords_db = []
            next_id = 1
    else:
        print(f"数据库文件 '{DB_FILE}' 不存在。将使用空数据库启动。")

def save_database():
    """将当前密码数据保存到文件"""
    with open(DB_FILE, 'w', encoding='utf-8') as f:
        json.dump(passwords_db, f, indent=4, ensure_ascii=False)
    print(f"数据库已保存到 '{DB_FILE}'。")

class ApiAndFileHandler(SimpleHTTPRequestHandler):
    API_PASSWORDS_PATTERN = re.compile(r'/api/passwords/?$')
    API_PASSWORDS_ID_PATTERN = re.compile(r'/api/passwords/(\d+)/?$')
    API_SHUTDOWN_PATTERN = re.compile(r'/api/shutdown/?$')

    def _send_response(self, status_code, data=None, content_type='application/json'):
        self.send_response(status_code)
        self.send_header('Content-type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')
        self.end_headers()
        if data is not None:
            self.wfile.write(json.dumps(data).encode('utf-8'))
            
    def do_OPTIONS(self): self._send_response(204)
    def do_GET(self):
        # We must override log_message to prevent it from crashing in --noconsole mode
        # by trying to write to a non-existent stderr.
        if self.path.startswith('/api/'):
            if self.API_PASSWORDS_PATTERN.match(self.path): self._send_response(200, passwords_db)
            else: super().do_GET()
        else:
            # For file serving, we call the parent's do_GET.
            # The default handler will log requests. We can suppress this or handle it.
            super().do_GET()

    # To prevent crashes, we can create a dummy log_message
    def log_message(self, format, *args):
        # sys.stderr is redirected to a file, so this is safe.
        # You could also just 'pass' to suppress logs completely.
        sys.stderr.write("%s - - [%s] %s\n" %
                         (self.address_string(),
                          self.log_date_time_string(),
                          format%args))

    def do_POST(self):
        if self.API_PASSWORDS_PATTERN.match(self.path):
            content_length = int(self.headers['Content-Length']); post_data = self.rfile.read(content_length)
            try:
                password_data = json.loads(post_data); global next_id
                new_password = {"id": next_id, "name": password_data.get("name"), "description": password_data.get("description"), "password": password_data.get("password")}
                passwords_db.append(new_password); next_id += 1; save_database()
                self._send_response(201, new_password)
            except (json.JSONDecodeError, KeyError) as e: self._send_response(400, {"error": f"Bad Request: {e}"})
        
        elif self.API_SHUTDOWN_PATTERN.match(self.path):
            print("Received shutdown request...") # This will go to the log file
            self._send_response(200, {"message": "Server is shutting down..."})
            
            def shutdown_server():
                self.server.shutdown()
            threading.Thread(target=shutdown_server).start()
        else: self._send_response(405, {"error": "Method Not Allowed"})

    # ... PUT and DELETE methods remain the same ...
    def do_PUT(self):
        match = self.API_PASSWORDS_ID_PATTERN.match(self.path)
        if match:
            password_id = int(match.group(1)); content_length = int(self.headers['Content-Length']); put_data = self.rfile.read(content_length)
            try:
                update_data = json.loads(put_data)
                password_to_update = next((p for p in passwords_db if p["id"] == password_id), None)
                if password_to_update: password_to_update.update(update_data); save_database(); self._send_response(200, password_to_update)
                else: self._send_response(404, {"error": f"Password with id {password_id} not found."})
            except json.JSONDecodeError: self._send_response(400, {"error": "Bad Request: Invalid JSON."})
        else: self._send_response(405, {"error": "Method Not Allowed"})
    def do_DELETE(self):
        match = self.API_PASSWORDS_ID_PATTERN.match(self.path)
        if match:
            password_id = int(match.group(1)); global passwords_db
            original_length = len(passwords_db); passwords_db = [p for p in passwords_db if p["id"] != password_id]
            if len(passwords_db) < original_length: save_database(); self._send_response(204)
            else: self._send_response(404, {"error": f"Password with id {password_id} not found."})
        else: self._send_response(405, {"error": "Method Not Allowed"})

# --- NEW Console Management Functions (Windows Only) ---
def alloc_console():
    """Allocates a new console for the process and redirects I/O."""
    if os.name != 'nt': return
    try:
        # Allocate a console
        if ctypes.windll.kernel32.AllocConsole() == 0:
            raise Exception("Failed to allocate console")
        
        # Redirect stdout, stderr, stdin
        sys.stdout = open('CONOUT$', 'w')
        sys.stderr = open('CONOUT$', 'w')
        sys.stdin = open('CONIN$', 'r')

    except Exception as e:
        print(f"Error allocating console: {e}")

def free_console():
    """Frees the console."""
    if os.name != 'nt': return
    # It's good practice to restore original streams, though the process will exit.
    sys.stdout = sys.__stdout__
    sys.stderr = sys.__stderr__
    sys.stdin = sys.__stdin__
    ctypes.windll.kernel32.FreeConsole()

def hide_console():
    """Hides the console window."""
    if os.name != 'nt': return
    try:
        # 获取 user32.dll 库
        user32 = ctypes.windll.user32
        # 获取 kernel32.dll 库
        kernel32 = ctypes.windll.kernel32
        
        # 定义 ShowWindow 函数的参数
        SW_HIDE = 0
        
        # 获取控制台窗口的句柄 (HWND)
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            # 发送隐藏窗口的命令
            user32.ShowWindow(hwnd, SW_HIDE)
    except Exception as e:
        print(f"Error hiding console: {e}")


# --- 主程序入口 ---
if __name__ == '__main__':
    # 参数解析
    parser = argparse.ArgumentParser(
        description="A simple HTTPS server with API and console management.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    # 服务器相关参数
    parser.add_argument('--hide-console', action='store_true', help='成功启动后隐藏控制台窗口 (仅限Windows)')
    
    # 证书生成相关参数
    cert_group = parser.add_argument_group('Certificate Generation Options')
    cert_group.add_argument('-c', '--country', default='CN', help='国家/地区代码 (2个字母)')
    cert_group.add_argument('-s', '--state', default='Beijing', help='省份或州名')
    cert_group.add_argument('-l', '--locality', default='Beijing', help='城市或地区名称')
    cert_group.add_argument('-o', '--org', default='My Test Company', help='组织或公司名称')
    cert_group.add_argument('--cn', default='localhost', help='通用名称 (Common Name), 通常是域名')
    cert_group.add_argument('--san', nargs='+', default=['localhost', '127.0.0.1'], help='主题备用名称')
    cert_group.add_argument('-d', '--days', type=int, default=365, help='证书的有效天数')

    args = parser.parse_args()

    # --- Step 1: Handle Console and I/O Redirection ---
    alloc_console() # 总是先分配一个控制台，以便能看到初始信息或错误

    # --- Step 2: Check for Certificates ---
    certs_exist = os.path.exists('cert.pem') and os.path.exists('key.pem')

    # 证书存在时窗口是隐藏地
    if certs_exist:
        # 这将捕获所有 print 语句和错误
        log_file = 'server.log'
        sys.stdout = open(log_file, 'a', encoding='utf-8')
        sys.stderr = sys.stdout # 将错误重定向到同一个文件

    if not certs_exist:
        print("\n--- SSL Certificate Generation ---")
        print("SSL certificate (cert.pem/key.pem) not found.")
        print("正在使用提供的参数或默认值生成证书...")
        
        generate_certificate(args) # 使用解析好的 args
        
        print("\n证书生成成功。服务器即将启动。")

    # --- Step 3: Load Database and Start Server ---
    
    DB_FILE = os.path.abspath(DB_FILE)
    load_database()
    
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain('cert.pem', 'key.pem')
        
        # 确保我们在脚本所在的目录的 htdocs 子目录中提供服务
        os.chdir('htdocs')

        server = HTTPServer(('0.0.0.0', 443), ApiAndFileHandler)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        
        print("\nHTTPS server starting on https://127.0.0.1:443")

        # 在启动阻塞循环之前打开浏览器
        webbrowser.open("https://127.0.0.1:443/index.html")
        
        if certs_exist:
            hide_console()

        # 进入服务器主循环 (阻塞)
        server.serve_forever()
        
        # 只有在 server.shutdown() 被调用后，代码才会执行到这里
        print("Server has been shut down.")
        free_console() # 在程序完全退出前，释放控制台

    except PermissionError:
        print("\n致命错误: 拒绝绑定到端口 443。")
        print("请以管理员身份运行，或确保没有其他服务正在使用此端口。")
        input("按 Enter 键退出。")
        free_console()
    except Exception as e:
        print(f"\n致命错误: 无法启动服务器。错误: {e}")
        input("按 Enter 键退出。")
        free_console()