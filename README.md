# 这是一个基于web的文本加密软件，有密码管理功能。
特点是通过ChaCha20-Poly1305和AES-GCM混合加密，造就了一个加密复杂解密也复杂的加密软件。安全性属于ChaCha20-Poly1305的安全性加AES-GCM的安全性再加 [1]。
原本想运行在浏览器上，但限制太多太多了，让这个软件意义降低了一半，不过我用python做了个简单的部署程序。

## 加密规则
1. 基础密码（Password for Encryption）： 加解密用到的密码，所有的加密key都是它诞生的。
2. 规则（Rule）：混淆基础密码用到的规则，有byte和i两个参数，byte密码原文，i是当前加密的轮次。示例：`(byte ^ (i ^ 123) )&255` 这样每一轮密码都是混淆后的密码，即时泄露加密密码也不影响安全。最后的&255必加，防止异常。
3. 棋盘（Interactive Color Grid (Path)）: 混淆密码用到的数据，类似于手机上的图案解锁功能更，但是多了颜色维度。使用时点击顺序必须保持一致，上下分区都要有内容。

# 生成密码
在加密也有生成密码选项，可生成8、14、18位随机密码。

## 命令行参数
Windows平台直接运行`httpServer.exe`就会自动打开页面。如果不知道证书是什么那就什么都不用管，双击运行就能正常使用。

### 注意事项
1. **首次运行行为**:
   - 如果 `cert/cert.pem` 不存在会自动生成证书
   - 证书生成期间控制台保持可见
   - 服务器启动后自动打开浏览器

2. **安全提示**:
   - 证书是自签名的（浏览器会显示安全警告）
   - 使用 `--san` 添加所有需要的域名/IP
   - 密码存储在 `passwords.json`

3. **关闭服务器**:
   - 点击Manager右边的 [⫶] 会显示Shutdown，点击即可关闭服务器
   - 这个应用空载运行时只需要16MB+内存，系统消耗很低

### 1. 控制台管理
```bash
--hide-console
```
- **用途**: 成功启动后隐藏控制台窗口（仅限 Windows）
- **行为**:
  - 启动期间控制台窗口可见
  - 服务器初始化后自动隐藏
- **示例**:
  ```bash
  httpServer.exe --hide-console
  ```

### 2. 调试模式
```bash
--debug
```
- **用途**: 启用日志记录到文件
- **行为**:
  - 将所有服务器日志保存到 `server.log`
  - 用于故障排除
- **示例**:
  ```bash
  httpServer.exe --debug
  ```

### 3. 证书生成选项
当需要生成新 SSL 证书时使用这些参数：

```bash
-c, --country 国家代码
```
- **用途**: 证书的 2 字母国家代码
- **默认值**: `CN`
- **示例**:
  ```bash
  httpServer.exe -c US
  ```

```bash
-s, --state 州/省名称
```
- **用途**: 证书的州/省名称
- **默认值**: `Beijing`
- **示例**:
  ```bash
  httpServer.exe -s "California"
  ```

```bash
-l, --locality 城市名称
```
- **用途**: 证书的城市/地区名称
- **默认值**: `Beijing`
- **示例**:
  ```bash
  httpServer.exe -l "San Francisco"
  ```

```bash
-o, --org 组织名称
```
- **用途**: 证书的组织名称
- **默认值**: `My Test Company`
- **示例**:
  ```bash
  httpServer.exe -o "Acme Corp"
  ```

```bash
--cn 通用名称
```
- **用途**: 证书的域名（通用名称）
- **默认值**: `localhost`
- **示例**:
  ```bash
  httpServer.exe --cn myserver.local
  ```

```bash
--san 备用名称
```
- **用途**: 证书的额外域名/IP 地址
- **默认值**: `localhost 127.0.0.1`
- **格式**: 空格分隔的列表
- **示例**:
  ```bash
  httpServer.exe --san "myserver.local 192.168.1.100"
  ```

```bash
-d, --days 有效天数
```
- **用途**: 证书有效期（天）
- **默认值**: `365`
- **示例**:
  ```bash
  httpServer.exe -d 730  # 2 年有效期
  ```

### 完整证书生成示例
```bash
httpServer.exe \
  --country US \
  --state "New York" \
  --locality "New York City" \
  --org "My Company" \
  --cn myserver.local \
  --san "myserver.local 192.168.1.100" \
  --days 730
```

# 声明
这个项目基本上是AI写的，我负责复制粘贴。

Here's the translated English version of your README.md:

# Web-Based Text Encryption Software with Password Management

This software uses hybrid encryption with ChaCha20-Poly1305 and AES-GCM, creating a solution where both encryption and decryption processes are complex. The security level combines the security of ChaCha20-Poly1305 plus AES-GCM security plus [1].

Originally designed to run in browsers, significant limitations reduced its effectiveness. As an alternative, I've created a simple deployment solution using Python.

## Encryption Rules
1. **Base Password (Password for Encryption)**: Used for encryption/decryption. All cryptographic keys derive from this.
2. **Rule**: Obfuscation logic for the base password. Takes `byte` (password byte) and `i` (encryption round index) as parameters. Example: `(byte ^ (i ^ 123)) & 255` ensures each round uses an obfuscated password. Final `& 255` prevents exceptions.
3. **Interactive Color Grid (Path)**: Obfuscation data similar to Android pattern unlock, but with an added color dimension. Click sequence must be consistent, and both upper/lower sections must contain elements.

## Password Generation
The encryption interface includes an option to generate 8, 14, or 18-character random passwords.

## Command Line Arguments
On Windows, run `httpServer.exe` to automatically open the web interface. No certificate setup is required for basic usage - just double-click to run.

### Important Notes
1. **First Run Behavior**:
   - Auto-generates certificate if `cert/cert.pem` doesn't exist
   - Console remains visible during certificate generation
   - Browser launches automatically after server starts

2. **Security Notice**:
   - Uses self-signed certificate (browsers will show security warnings)
   - Use `--san` to add required domains/IPs
   - Passwords are stored in `passwords.json`

3. **Shutting Down**:
   - Click [⫶] next to "Manager" and select "Shutdown"
   - Low resource usage (~16MB RAM when idle)

---

### 1. Console Management
```bash
--hide-console
```
- **Purpose**: Hides console window after successful launch (Windows only)
- **Behavior**:
  - Console visible during startup
  - Auto-hides after server initialization
- **Example**:
  ```bash
  httpServer.exe --hide-console
  ```

### 2. Debug Mode
```bash
--debug
```
- **Purpose**: Enables file logging
- **Behavior**:
  - Saves all server logs to `server.log`
  - For troubleshooting
- **Example**:
  ```bash
  httpServer.exe --debug
  ```

### 3. Certificate Generation Options
Use these when generating new SSL certificates:

```bash
-c, --country [Country Code]
```
- **Purpose**: 2-letter certificate country code
- **Default**: `CN`
- **Example**:
  ```bash
  httpServer.exe -c US
  ```

```bash
-s, --state [State/Province]
```
- **Purpose**: State/province name
- **Default**: `Beijing`
- **Example**:
  ```bash
  httpServer.exe -s "California"
  ```

```bash
-l, --locality [City]
```
- **Purpose**: City/locality name
- **Default**: `Beijing`
- **Example**:
  ```bash
  httpServer.exe -l "San Francisco"
  ```

```bash
-o, --org [Organization]
```
- **Purpose**: Organization name
- **Default**: `My Test Company`
- **Example**:
  ```bash
  httpServer.exe -o "Acme Corp"
  ```

```bash
--cn [Common Name]
```
- **Purpose**: Domain name (Common Name)
- **Default**: `localhost`
- **Example**:
  ```bash
  httpServer.exe --cn myserver.local
  ```

```bash
--san [SAN List]
```
- **Purpose**: Additional domains/IP addresses
- **Default**: `localhost 127.0.0.1`
- **Format**: Space-separated list
- **Example**:
  ```bash
  httpServer.exe --san "myserver.local 192.168.1.100"
  ```

```bash
-d, --days [Validity]
```
- **Purpose**: Certificate validity (days)
- **Default**: `365`
- **Example**:
  ```bash
  httpServer.exe -d 730  # 2-year validity
  ```

### Complete Certificate Generation Example
```bash
httpServer.exe \
  --country US \
  --state "New York" \
  --locality "New York City" \
  --org "My Company" \
  --cn myserver.local \
  --san "myserver.local 192.168.1.100" \
  --days 730
```

# Disclaimer
This project was primarily developed using AI assistance. My role involved curation and implementation of the generated solutions.