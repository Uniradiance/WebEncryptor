# WebEncryptor — Password Vaults and Text Encryption

**三因子密钥派生 + 单层 AEAD**：棋盘路径、手绘图案链码与随机盐组合成 KDF 盐；主口令经 **Argon2id**（内存困难型 KDF，3 轮 / 256 MiB）派生主密钥，再经 HKDF-SHA256 分离出加密密钥，最后用 **ChaCha20-Poly1305**（单层）加密。安全性取决于三因子组合熵 + Argon2id 的成本，密文可以公开存放。

修改密码库凭据现在同时轮换库密钥并重加密全部账号；已有库需在升级后执行一次修改凭据，才能获得这项保护。离开页面清理敏感会话，新写入拒绝明文密码。旧备份仍可用旧凭据解密，弱凭据仍可能被离线猜中，不能承诺“100% 不可破解”。

## 部署方式（推荐）：Go 单文件服务器

`server.go` 是**推荐的后端**：单个可执行文件、零运行时依赖、跨平台（Windows / macOS / Linux / ARM），静态网页已嵌入二进制，`htdocs/` 文件夹不需要分发。`./build.sh` 交叉编译出全部平台产物到 `dist/`（需要 `CGO_ENABLED=0`，构建脚本已设置）。

**快速开始：**
```bash
./build.sh                          # 生成 dist/ 下所有平台二进制
./dist/webencryptor-linux-amd64 --token 9f8a7b6c5d4e3f2a1b0c   # 启动
```

**参数**（详见 `server.go`）：`--port`（默认 8443）、`--token`（API 令牌，强烈建议设置）、`--http`（纯 HTTP）、`--dir`（外部静态目录）、`--san/--days/--cn/--org`（证书）、`--no-browser`、`--debug`（写 server.log）。

## Android 独立离线应用

[`android/`](android/README.md) 将同一套 `htdocs/` 前端直接打包进 APK，由 WebView 承载；`server.go` / `vault.go` 的存储与校验通过 Kotlin 和进程内 JS 桥提供。应用没有监听端口，也没有 `INTERNET` 权限。构建：`android/tools/setup-toolchain.sh && android/tools/ci-build.sh assemble`。

## 当前交互与可靠保存

默认页面为 **Password Vaults**：一次三因子解锁后管理一组账号，支持自动锁定、搜索、编辑、复制、旧密文导入和加密备份恢复。**Text Encryption** 与 **Independent Items** 保留独立加解密及原条目。`passwords.json` 的 `{nextId,entries}` 外层结构不变，新增 `type: "vault"` 条目，其 `password` 保存加密后的随机库密钥，`children` 保存账号资料密文；版本检查阻止并发覆盖。格式、兼容性与验证见 [密码库设计与使用](docs/PASSWORD_VAULTS.md)。

界面采用桌面侧边导航、手机顶部导航。三因子输入区随当前任务显示在新建／解锁、修改凭据、导入或文本加密区域内，切换页面保留输入状态。独立条目页默认折叠解密凭据，点击条目的解密按钮会展开；桌面使用上下方向键切换导航，手机使用左右方向键。

- 棋盘保留外侧行列坐标，格内仅显示颜色；选择顺序用于密钥派生，撤销恢复上一次颜色和顺序，最多保留 256 次修改。提交后明确隐藏棋盘，点击 Show grid 可恢复显示，隐藏期间不能编辑。
- 加密前点击 **Redraw to verify**，重新绘制并点击 **Confirm match**。不匹配可撤销或清空重试；取消验证会丢弃两次输入。解密只需输入图案，不要求重复验证。
- 图案参考网格为 24px，绿色标记表示每笔起点；参考线和标记不参与识别。编码仍仅取方向，不要求落在同一位置。
- 操作期间锁定因子、模式和保存入口；可切换 Data Panel/Manager，任务和进度保留。Worker 请求带编号并串行执行。
- API 写入在同一互斥锁内完成：临时文件 → 文件 Sync → 原子替换 → Unix 目录 Sync，成功后才回复 2xx；Windows 同步文件并使用 Rename。写入失败返回 500，替换前失败不改变内存。目录同步或网络响应失败时结果可能不确定，先刷新列表再重试。
- 损坏的密码库会让服务器停止启动，原文件保留，避免下一次保存覆盖它。
- 明文按 UTF-8 字节限制为 4 MiB，密文上限为 5,592,479 字符，保存与解密使用同一容量限制。API 对超限请求返回 413，并拒绝错误类型与尾随 JSON。
- 密码库采用 `{nextId,entries}` 对象格式，下一条 ID 与条目一起保存；删除后重启不复用 ID。
- 网络请求默认 30 秒超时，失败保留密文和草稿并释放操作锁；管理页刷新保留编辑内容和焦点，过期响应不会覆盖最新列表。

## 加密规则
1. **基础密码（Password）**：因子 A，主口令。
2. **棋盘（Interactive Color Grid (Path)）**：因子 B，彩色棋盘上"点击顺序 + 颜色"构成路径字符串，必须完全一致。
3. **手绘图案（Signature Pattern）**：因子 C，长条形画板上手绘的折线图案，识别为**八方向链码序列**（如 `RURDLDRU`）。支持多笔累积绘制、"撤回"撤销最后一笔；要求总共**至少 10 段、每段画长一些（≥1/20 画板宽度）**。图案对平移和缩放不敏感，只需"拐弯数、方向、顺序"一致。

## 图案识别算法

管线（`htdocs/signature_recognition.js` 参考实现 + Rust/WASM 加速内核，二者输出严格一致）：

1. **自适应 DP 去噪**：抖动用二阶差分第 25 分位数估计（σ̂），容差随 σ̂ 放大（上限 1.6× 基础值）；回折环/抖动被折叠成直弦，真拐角保留。
2. **等弧长重采样**（2px 步长）：统一点距，消除手速差异。
3. **转角剖面**：固定弧长双弦的局部转向角 + 5 点滑窗；剖面局部极大值即拐角（几何确定，不随噪声跳动），低于 24° 的候选视为大圆弧/抖动；间距 20px 内的候选合并。
4. **分段**：段方向取段内点集的最小二乘主方向（对拐角定位误差稳健）；段长取路径弧长。
5. **迭代修剪**（每轮删除一条噪声段，删除后重新合并）：
   - **桥段**：两侧同向的短 V 形（抖动凸起）；
   - **夹角段**：方向介于两侧之间 + 短于上下限 + 一侧拐角 ≥40°（圆角弧尾）；
   - **尖刺段**（本优化新增）：两侧转角 ≤135° 时，方向落在邻段短扇区**之外**的短段（DP 在拐角处产生的回冲伪段，如 U→D→R 中的 D）；
   - **共线顶点**：两侧弦的最小二乘拟合夹角 <14°，缝合；
   - **短段**：弧长 <18px 或弦长 <2px。

### 算法优化要点（2026-08 优化轮）
- 核心识别管线用 **Rust 重写并编译为 WASM**（`rust/recognition` → `htdocs/recognition_wasm.wasm`，`./build-wasm.sh` 构建）：绘制过程中每帧只重算当前笔画，WASM 内核处理原始点缓冲（零逐帧对象分配），识别延迟从 ~2ms 降到亚毫秒级；JS 参考实现保留为**精确一致的降级后备**（WASM 加载失败时链码不变）。
- 新增**尖刺修剪规则**：消除 DP 在拐角处产生的回冲伪段，现实抖动（σ≤1.5px）300 次随机变化测试从 299/300 提升到 **300/300**。
- `SignaturePad` 采用**离屏画布缓存已落笔笔画**：逐帧重绘成本从 O(全部笔画点数) 降到 O(当前笔画点数)。
- 前端完全自托管（React 19 已 vendor 到 `htdocs/vendor/`，无 CDN 依赖，真正离线可用）。

## 密文格式
`WE2.<盐(16B,base64)>.<IV(12B,base64)>.<密文(base64)>.<MAC(16B,base64)>`，随机盐随密文存储。
> 图案因子每段编码一个数字：R/RU/U/LU/L/LD/D/RD → 0/1/2/3/4/5/6/7；因此 RU 与 R 后接 U 分别为 `1` 与 `02`。HKDF info 为 `WebEncryptor:enc:v2`，AAD 为 `WebEncryptor:v2`。

## 生成密码
加密界面内置随机密码生成（8 / 14 / 18 位）。

---

# Web-Based Text Encryption Software with Password Management

**Three-factor key derivation + single-layer AEAD**: the master password, the color-grid path and the hand-drawn pattern chain code are folded into the KDF salt material; **Argon2id** (3 passes / 256 MiB) derives a master key; HKDF-SHA256 separates the encryption key; a **single ChaCha20-Poly1305** layer encrypts. Ciphertexts are safe to store publicly.

## Deployment (recommended): single-file Go server

`server.go` is the recommended backend: one executable, zero runtime dependencies, cross-platform (Windows / macOS / Linux / ARM); the static web app is embedded. `./build.sh` cross-compiles every platform into `dist/` (uses `CGO_ENABLED=0`, already set in the script).

## Encryption Rules
1. **Password**: factor A, the master password.
2. **Interactive Color Grid (Path)**: factor B, click order + colors — must match exactly.
3. **Signature Pattern**: factor C, drawn on the elongated pad and recognized as an **8-direction chain code** (e.g. `RURDLDRU`). Multiple strokes accumulate; "Undo" removes the last stroke. Requires **at least 10 segments**, each reasonably long (≥1/20 of the pad width). Translation- and scale-invariant: only the turn sequence must match.

## Pattern Recognition

Pipeline (pure-JS reference in `htdocs/signature_recognition.js` + a Rust/WASM core with **strictly identical output**):

1. **Adaptive DP de-noising** (tolerance scaled by the 25th-percentile jitter estimate, capped at 1.6× base).
2. **Uniform arc-length resampling** (2 px) — hand-speed invariant.
3. **Turn-angle profile** over fixed-arc chords + 5-point smoothing; local maxima are corners (geometrically stable), <24° candidates treated as arcs/jitter; candidates within 20 px merge.
4. **Segmentation**: direction = least-squares principal direction of the segment's points; length = path arc.
5. **Iterative pruning** (one deletion per round, then re-merge): bridge (short V between same-direction neighbors), between (rounded-corner arc tail), **spike (new: short out-of-fan reversal produced by DP at corners — e.g. the D in U→D→R)**, collinear vertex (<14° fitted turn, stitched), short leg (<18 px arc or <2 px chord).

### Optimization notes (2026-08)
- The recognition core is rewritten in **Rust and compiled to WASM** (`rust/recognition` → `htdocs/recognition_wasm.wasm`, built by `./build-wasm.sh`; needs `rustup target add wasm32-unknown-unknown` and `wasm-ld`): per-frame work is only the stroke in progress, latency drops from ~2 ms to sub-millisecond. The JS reference stays as an **exact-parity fallback** (the chain code never depends on WASM load timing).
- **Spike pruning** removes short reversal artifacts at DP corners.
- The jitter estimate uses deterministic O(n) quickselect. The Go server serves static assets with strong **ETags + 304 revalidation** and sets `Cache-Control: no-store` on the API.
- `SignaturePad` caches committed strokes on an **offscreen canvas**: per-frame redraw cost drops from O(all points) to O(current stroke).
- Frontend fully self-hosted (React 19 vendored in `htdocs/vendor/`, no CDN — truly offline).

## Ciphertext Format
`WE2.<salt(16B,base64)>.<IV(12B,base64)>.<ciphertext(base64)>.<MAC(16B,base64)>`.
> Each pattern segment is encoded as one digit: R/RU/U/LU/L/LD/D/RD → 0/1/2/3/4/5/6/7. RU is `1`, while R followed by U is `02`; HKDF info is `WebEncryptor:enc:v2` and AAD is `WebEncryptor:v2`.

Plaintext is limited to 4 MiB of UTF-8 bytes; ciphertext is limited to 5,592,479 characters including format overhead. Decryption and saving use the same ciphertext limit. API requests have a 32 MiB JSON limit and reject invalid field types. Requests time out after 30 seconds; refresh the list before retrying an uncertain write. Manager refreshes retain unsaved drafts and ignore stale responses.

The database persists `{nextId,entries}` so deleted IDs survive restarts.

## Password Generation
The encryption panel includes random password generation (8 / 14 / 18 characters).

# Disclaimer
This project was primarily developed using AI assistance.
