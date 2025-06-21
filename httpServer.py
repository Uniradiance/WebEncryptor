from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl

# 生成自签名证书（如果没有）
# openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('cert.pem', 'key.pem')

server = HTTPServer(('0.0.0.0', 443), SimpleHTTPRequestHandler)
server.socket = context.wrap_socket(server.socket, server_side=True)
print("HTTPS server running on https:/127.0.0.1:443")
server.serve_forever()