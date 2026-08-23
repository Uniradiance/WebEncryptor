# 这是一个基于web的文本加密软件，有密码管理功能。

采用**三因子密钥派生 + 单层 AEAD** 方案：主口令、棋盘路径、手绘图案链码三个因子拼入 KDF 盐，经 **Argon2id**（内存困难型 KDF，3 轮 / 256 MiB）派生主密钥，再经 HKDF-SHA256 分离出加密密钥，最后用 **ChaCha20-Poly1305**（单层）加密。安全性取决于三因子组合熵 + Argon2id 的成本，密文可以公开存放。

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
2. **手绘图案（Pattern）**：因子 C，长条形画板上手绘的折线图案（台阶、折线、斜线都行），识别为**八方向链码序列**（横/竖/斜 8 个方向，如 `RURDRLUDRU`）作为因子。**支持多次落笔累积绘制**（画完一笔继续画下一笔，识别自动追加；画错了用"撤回"撤销最后一笔），要求**总共至少 10 段、每段画长一些（≥1/20 画板宽度）**。画板实时显示识别结果（有效 / 段数不足），当场就能确认，不用等解密失败。图案对平移和缩放不敏感，重复绘制只需"拐弯数、方向、顺序"一致。八方向编码对旧的四方向（纯横竖）图案完全兼容。
3. **棋盘（Interactive Color Grid (Path)）**：因子 B，类安卓图案解锁的彩色棋盘，点击顺序 + 颜色构成路径字符串，加密与解密时必须完全一致。

三个因子全部拼入 KDF 盐材料（长度前缀编码消除拼接歧义），**缺一不可、互为兜底**：泄露其中任意一个，其余两个仍然必须被猜中；攻击者每验证一次完整猜测都要付一次 Argon2id（256 MiB 内存 + 3 轮）的成本。

## 密文格式
输出为 `WE1.<盐(16B,base64)>.<IV(12B,base64)>.<密文(base64)>.<MAC(16B,base64)>`，随机盐随密文存储。

> ⚠️ **兼容性警告**：`WE1.` 格式与旧版"多层 AES/ChaCha 套娃"密文**不兼容**。旧密文需要用旧版程序先解密，再用本版重新加密。旧版的多层方案已被移除——它不增加安全性，只会让合法用户比攻击者多付 (层数+1) 倍的 KDF 成本。

## 生成密码
在加密也有生成密码选项，可生成8、14、18位随机密码。

## 图案识别与稳定性测试
- 识别算法：平滑 → Douglas-Peucker 折线简化 → **拐角精化**（每个顶点在局部窗口内吸附到"转角最尖锐处"；若窗口内最尖锐点的局部转向角仍低于 25°，则视为**大圆弧而非转折**，删除顶点、两弦合并为单一走势段——"挺直的大圆弧"不会再被劈成两个方向）→ 八方向分类（主轴 ±26.6°）→ 迭代式"合并同向段 ↔ 删除短段"。转折判定门槛**逐段增长**（每确认一段，后续段的判定长度 ×1.5，上限 2 倍基础值）：手抖/弧线产生的短腿 V 形被合并掉，长线条尾部的局部倾斜不会翻出新段；斜段另设 1.4 倍门槛剔除拐角圆弧弦（见 `htdocs/signature_recognition.js`）。⚠️ 腿角距扇区边界 ±5° 以内是固有量化边界，任何识别器都会随抖动翻转，画图案应避开边界角；
- 稳定性测试（浏览器手动）：打开 `htdocs/pad-tester.html`，连画 10 次看一致率（测试前先热身 1~2 次）；
- 自动化回归：`node test/recognition_test.js`（合成数据模拟抖动/缩放/平移/圆角/多笔画，现实抖动 300 次须 100% 一致）。

# 声明
这个项目基本上是AI写的，我负责复制粘贴。

# Web-Based Text Encryption Software with Password Management

This software uses a **three-factor key derivation + single-layer AEAD** scheme: the master password, the color-grid path, and a hand-drawn pattern chain code are all folded into the KDF salt material; **Argon2id** (3 passes / 256 MiB) derives a master key; HKDF-SHA256 separates the encryption key; **ChaCha20-Poly1305** (single layer) does the encryption. Ciphertexts are safe to store publicly.

## Encryption Rules
1. **Base Password**: Factor A, the master password you remember.
2. **Hand-Drawn Pattern**: Factor C, drawn on the long strip pad. Axis-aligned patterns (stairs, zigzags) are recognized as a 4-direction chain code (e.g. `RURDLDRU`) used as the factor. **Multiple pen strokes accumulate** (keep drawing; "undo" removes the last stroke). Requires at least 10 segments in total, each drawn reasonably long (≥1/20 of the pad width). The pad shows live recognition feedback (valid / too few segments / diagonal detected) so mistakes are caught immediately. Translation- and scale-invariant: only the turn sequence must match.
   - **Drawing**: hand-draw an axis-aligned pattern (stairs, zigzags) on the long strip pad; it is recognized as a 4-direction chain code (e.g. `RURDLDRU`) used as the factor. Requires at least 10 segments, each drawn reasonably long (≥1/20 of the pad width); the pad shows live recognition feedback (valid / too few segments / diagonal detected) so mistakes are caught immediately. Translation- and scale-invariant: only the turn sequence must match.
3. **Interactive Color Grid (Path)**: Factor B, an Android-pattern-like colored grid; click order + colors form the path string and must match exactly for decryption.

All three factors are folded into the KDF salt material (length-prefixed to avoid ambiguity). All are required; leaking any single one still leaves the other two. Every full guess by an attacker costs one Argon2id evaluation (256 MiB / 3 passes).

## Ciphertext Format
`WE1.<salt(16B,base64)>.<IV(12B,base64)>.<ciphertext(base64)>.<MAC(16B,base64)>`, with a random salt stored alongside.

> ⚠️ **Compatibility**: `WE1.` ciphertexts are **incompatible** with the old multi-layer AES/ChaCha format. Decrypt old data with the old version first, then re-encrypt. The old layering was removed: it added no security while costing legitimate users (layers+1)× the KDF work per operation vs. 1× for an attacker.

## Password Generation
The encryption interface includes an option to generate 8, 14, or 18-character random passwords.


# Disclaimer
This project was primarily developed using AI assistance. My role involved curation and implementation of the generated solutions.