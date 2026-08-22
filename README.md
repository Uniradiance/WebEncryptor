# 这是一个基于web的文本加密软件，有密码管理功能。

采用**三因子密钥派生 + 单层 AEAD** 方案：主口令、棋盘路径、规则短语三个因子拼入 KDF 盐，经 **Argon2id**（内存困难型 KDF，3 轮 / 256 MiB）派生主密钥，再经 HKDF-SHA256 分离出加密密钥，最后用 **ChaCha20-Poly1305**（单层）加密。安全性取决于三因子组合熵 + Argon2id 的成本，密文可以公开存放。

## 部署方式（推荐）：Go 单文件服务器

`server.go` 是**推荐的后端**：单个可执行文件、零运行时依赖、跨平台（Windows / macOS / Linux / ARM），静态网页已嵌入二进制，`htdocs/` 文件夹都不需要分发。

**为什么选它：**
- **免 root**：默认监听 8443 端口（>1024 无需管理员权限），不再绑定 443
- **便携**：整个程序就一个文件；`cert/`、`passwords.json`、`server.log` 都生成在可执行文件旁边，整个文件夹拷走即用
- **多平台**：一条 `./build.sh` 交叉编译出 8 种平台的产物到 `dist/`
- **可托管任意静态网页**：`--dir <文件夹>` 可以把任何静态站点目录挂上去（开发时也可用它指向 htdocs 免重新编译）
- **可纯明文**：`--http` 关闭 TLS，适合内网或放在 nginx/Caddy 后面

**快速开始：**
```bash
./build.sh                          # 生成 dist/ 下所有平台二进制
./dist/webencryptor-linux-amd64 --token 9f8a7b6c5d4e3f2a1b0c   # 启动
```
Windows 双击 `webencryptor-windows-amd64.exe`（带控制台）或 `webencryptor-windows-amd64-silent.exe`（静默版，无窗口）即可，浏览器会自动打开。

**参数：**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8443` | 监听端口（>1024 无需 root） |
| `--token` | 无 | API 访问令牌，不设置则局域网内任何人都能读写密码库（强烈建议设置） |
| `--http` | 关 | 纯 HTTP，不启用 TLS |
| `--dir` | 内嵌 htdocs | 改为从外部目录提供静态文件 |
| `--san` | `localhost,127.0.0.1` | 证书 SAN（逗号分隔的域名/IP） |
| `--days` | `365` | 证书有效天数 |
| `--cn` / `--org` | `localhost` / `WebEncryptor` | 证书主题 |
| `--no-browser` | 关 | 不自动打开浏览器 |
| `--debug` | 关 | 日志同时写入 `server.log` |

## 加密规则
1. **基础密码（Password for Encryption）**：因子 A，你记住的主口令。
2. **规则短语（Rule Phrase）**：因子 C，任意固定字符串（不再是可执行代码！），例如 `my-vault-v2`。写在纸上或存在配置文件里都行。
3. **棋盘（Interactive Color Grid (Path)）**：因子 B，类安卓图案解锁的彩色棋盘，点击顺序 + 颜色构成路径字符串，加密与解密时必须完全一致。

三个因子全部拼入 KDF 盐材料（长度前缀编码消除拼接歧义），**缺一不可、互为兜底**：泄露其中任意一个，其余两个仍然必须被猜中；攻击者每验证一次完整猜测都要付一次 Argon2id（256 MiB 内存 + 3 轮）的成本。

## 密文格式
输出为 `WE1.<盐(16B,base64)>.<IV(12B,base64)>.<密文(base64)>.<MAC(16B,base64)>`，随机盐随密文存储。

> ⚠️ **兼容性警告**：`WE1.` 格式与旧版"多层 AES/ChaCha 套娃"密文**不兼容**。旧密文需要用旧版程序先解密，再用本版重新加密。旧版的多层方案已被移除——它不增加安全性，只会让合法用户比攻击者多付 (层数+1) 倍的 KDF 成本。

## 生成密码
在加密也有生成密码选项，可生成8、14、18位随机密码。

# 声明
这个项目基本上是AI写的，我负责复制粘贴。

# Web-Based Text Encryption Software with Password Management

This software uses a **three-factor key derivation + single-layer AEAD** scheme: the master password, the color-grid path, and a rule phrase are all folded into the KDF salt material; **Argon2id** (3 passes / 256 MiB) derives a master key; HKDF-SHA256 separates the encryption key; **ChaCha20-Poly1305** (single layer) does the encryption. Ciphertexts are safe to store publicly.

## Encryption Rules
1. **Base Password**: Factor A, the master password you remember.
2. **Rule Phrase**: Factor C, any fixed string (no longer executable code!), e.g. `my-vault-v2`.
3. **Interactive Color Grid (Path)**: Factor B, an Android-pattern-like colored grid; click order + colors form the path string and must match exactly for decryption.

All three factors are folded into the KDF salt material (length-prefixed to avoid ambiguity). All are required; leaking any single one still leaves the other two. Every full guess by an attacker costs one Argon2id evaluation (256 MiB / 3 passes).

## Ciphertext Format
`WE1.<salt(16B,base64)>.<IV(12B,base64)>.<ciphertext(base64)>.<MAC(16B,base64)>`, with a random salt stored alongside.

> ⚠️ **Compatibility**: `WE1.` ciphertexts are **incompatible** with the old multi-layer AES/ChaCha format. Decrypt old data with the old version first, then re-encrypt. The old layering was removed: it added no security while costing legitimate users (layers+1)× the KDF work per operation vs. 1× for an attacker.

## Password Generation
The encryption interface includes an option to generate 8, 14, or 18-character random passwords.


# Disclaimer
This project was primarily developed using AI assistance. My role involved curation and implementation of the generated solutions.