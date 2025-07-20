from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl
import argparse
from gen_key import generate_certificate

# 生成自签名证书（如果没有）
# openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes


if __name__ == '__main__':
    print("""usage: generate_cert.py [-h] [-c COUNTRY] [-s STATE] [-l LOCALITY] [-o ORG] [--cn CN] [--san SAN [SAN ...]] [-d DAYS]

生成一个自签名的 SSL 证书和私钥。

options:
-h, --help            show this help message and exit
-c COUNTRY, --country COUNTRY
                        国家/地区代码 (2个字母) (default: CN)
-s STATE, --state STATE
                        省份或州名 (default: Beijing)
-l LOCALITY, --locality LOCALITY
                        城市或地区名称 (default: Beijing)
-o ORG, --org ORG     组织或公司名称 (default: My Test Company)
--cn CN               通用名称 (Common Name), 通常是域名 (default: localhost)
--san SAN [SAN ...]   主题备用名称 (Subject Alternative Names), 例如: localhost 127.0.0.1 example.com (default: ['localhost'])
-d DAYS, --days DAYS  证书的有效天数 (default: 365)\n""")
        
    try:
        with open('cert.pem', 'r') as f:
            pass
        with open('key.pem', 'r') as f:
            pass

        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain('cert.pem', 'key.pem')

        server = HTTPServer(('0.0.0.0', 443), SimpleHTTPRequestHandler)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        print("HTTPS server running on https:/127.0.0.1:443")
        server.serve_forever()

    except IOError:
        print(f"Unable to read the cert file.\n")
        
        # --- 设置命令行参数解析 ---
        parser = argparse.ArgumentParser(
            description="Generate a self-signed SSL certificate and private key.",
            formatter_class=argparse.ArgumentDefaultsHelpFormatter # 自动显示默认值
        )
        
        # 证书信息参数
        parser.add_argument('-c', '--country', default='CN', help='国家/地区代码 (2个字母)')
        parser.add_argument('-s', '--state', default='Beijing', help='省份或州名')
        parser.add_argument('-l', '--locality', default='Beijing', help='城市或地区名称')
        parser.add_argument('-o', '--org', default='My Test Company', help='组织或公司名称')
        parser.add_argument('--cn', default='localhost', help='通用名称 (Common Name), 通常是域名')
        
        # SAN 参数，可以接受多个值
        parser.add_argument(
            '--san',
            nargs='+',  # 接受一个或多个参数
            default=['localhost'],
            help='主题备用名称 (Subject Alternative Names), 例如: localhost 127.0.0.1 example.com'
        )
        
        # 有效期参数
        parser.add_argument('-d', '--days', type=int, default=365, help='证书的有效天数')
        
        # 解析命令行传入的参数
        args = parser.parse_args()
        
        # 调用主函数
        generate_certificate(args)

        print("\nRestart the program to continue.")