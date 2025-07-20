# 这是一个离线的web加密软件
特点是通过ChaCha20-Poly1305和AES-GCM混合加密，造就了一个加密复杂解密也复杂的加密软件。安全性属于ChaCha20-Poly1305的安全性加AES-GCM的安全性再加1。
虽然想在浏览器跑，但是web crypto api不让，让这个软件意义降低了一半，不过我用python做了个简单的部署程序。

## 加密规则
1. 基础密码（Password for Encryption）： 加解密用到的密码，所有的加密key都是它诞生的。
2. 规则（Rule）：混淆基础密码用到的规则，有byte和i两个参数，byte密码原文，i是当前加密的轮次。示例：`(byte ^ (i ^ 123) )&255` 最后的&255必加，防止异常。
3. 棋盘（Interactive Color Grid (Path)）: 混淆密码用到的数据，来源有点击顺序、上半颜色、下半颜色。加解密时点击顺序必须保持一致，上下都要有内容。

# 生成密码
在加密也有生成密码选项，可生成8、14、18位随机密码。

# 部署
- https（可以局域网访问）
需要先生成证书:`openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`,然后安装python http.server
然后点击StartServer.bat
- http（只能访问localhost）
直接运行python命令`python -m http.server 80`

# 声明
这个项目基本上是AI写的，我负责复制粘贴。

# This is an Offline Web Encryption Software
It features hybrid encryption using ChaCha20-Poly1305 and AES-GCM, creating a tool that is complex to both encrypt and decrypt. Its security level equals the combined security of ChaCha20-Poly1305 plus AES-GCM, plus an additional margin of safety.

Although intended to run in browsers, restrictions of the Web Crypto API reduce its utility by half. Fortunately, I made a simple deployment program in python.

## Encryption Rules
1. Base Password (Password for Encryption): The password used for all encryption/decryption. All cryptographic keys derive from this.

2. Rule: A function used to obfuscate the base password. Takes parameters byte (original password byte) and i (current encryption round index). Example: (byte ^ (i ^ 123)) & 255. The final & 255 must be included to prevent exceptions.

3. Chessboard (Interactive Color Grid - Path): Data used to obfuscate the password, derived from click sequence, top-half colors, and bottom-half colors. The click sequence must be consistent during both encryption and decryption, and both color sections must contain content.

## Generate Password
The encryption interface includes an option to generate random 8, 14, or 18-character passwords.

## Deployment
HTTPS (Accessible on LAN):

First generate certificates:`openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`

Install python http.server.

Run StartServer.bat.

HTTP (Localhost access only):
Run the Python command directly:`python -m http.server 80`

# Statement
This project was essentially written by AI; I was only responsible for the copy-pasting.
