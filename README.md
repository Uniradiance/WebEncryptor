# WebEncryptor — Web-Based Text Encryption with Password Management

**三因子密钥派生 + 单层 AEAD**：主口令、棋盘路径、手绘图案链码三个因子拼入 KDF 盐，经 **Argon2id**（内存困难型 KDF，3 轮 / 256 MiB）派生主密钥，再经 HKDF-SHA256 分离出加密密钥，最后用 **ChaCha20-Poly1305**（单层）加密。安全性取决于三因子组合熵 + Argon2id 的成本，密文可以公开存放。

## 部署方式（推荐）：Go 单文件服务器

`server.go` 是**推荐的后端**：单个可执行文件、零运行时依赖、跨平台（Windows / macOS / Linux / ARM），静态网页已嵌入二进制，`htdocs/` 文件夹不需要分发。`./build.sh` 交叉编译出全部平台产物到 `dist/`（需要 `CGO_ENABLED=0`，构建脚本已设置）。

**快速开始：**
```bash
./build.sh                          # 生成 dist/ 下所有平台二进制
./dist/webencryptor-linux-amd64 --token 9f8a7b6c5d4e3f2a1b0c   # 启动
```

**参数**（详见 `server.go`）：`--port`（默认 8443）、`--token`（API 令牌，强烈建议设置）、`--http`（纯 HTTP）、`--dir`（外部静态目录）、`--san/--days/--cn/--org`（证书）、`--no-browser`、`--debug`（写 server.log）。

## 当前交互与可靠保存

- 棋盘数字显示最终选中格子的实际顺序；撤销恢复上一次颜色和顺序，最多保留 256 次修改。提交后明确隐藏棋盘，点击 Show grid 可恢复显示，隐藏期间不能编辑。
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

### 测试
```bash
node test/recognition_test.mjs     # 稳健性回归 + JS/WASM 精确一致性(parity) + 性能
node test/business_state_test.mjs # 棋盘撤销、方向编码、任务互斥与过期响应
node test/password_service_test.mjs # API 超时、取消、重试与容量校验
node test/worker_smoke.js          # 新密文、错误因子、请求编号与串行 Worker
go test -race ./...               # CRUD 落盘、失败回滚、损坏库、并发写入
node test/sigpad_replay_test.mjs   # SignaturePad 状态一致性回归 (提交/撤销/异常注入/引擎防御)
cargo test --manifest-path rust/recognition/Cargo.toml   # Rust 侧单元测试
```
真实 Firefox 业务流程测试（Python 标准库，临时数据，不使用现有密码库）：
```bash
go build -o /tmp/webencryptor-business-server .
python3 test/browser_flow.py --server /tmp/webencryptor-business-server
```
覆盖棋盘实际交互、隐藏、重画不匹配/重试、操作中切换、保存失败、重复提交、落盘、服务器重启和管理器解密。测试以真实 DOM 中的合成鼠标/指针事件运行，不覆盖触屏硬件与原生指针捕获。

浏览器手动稳定性测试：打开 `htdocs/pad-tester.html`，连画 10 次看一致率（先热身 1~2 次）。

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
- New **spike pruning rule** removes DP corner artifacts (see `docs/REVIEW.md` §4 for measured stability numbers: the residual mismatch rate under realistic jitter σ≤1.5 px is ≤3 per 300 across nine deterministic seeds — the pipeline is at the information limit of this 2-px-resampled chain-code encoder).
- **Review round (2026-08/09)**: the jitter estimate's O(n log n) full sort became a deterministic O(n) quickselect (identical k-th order statistic, so JS↔WASM parity still holds; extract 0.052→0.047 ms); the `stitch()` zero-displacement direction trap was fixed in both cores; the Go server now serves static assets with strong **ETags + 304 revalidation** (repeat visits transfer 0 bytes instead of ~1.4 MB) and `Cache-Control: no-store` on the API; the deleted test suite was rebuilt with deterministic seeds (`test/recognition_test.mjs`, `test/lib/battery.mjs`) and the crypto smoke test restored (`test/worker_smoke.js`). Full review: `docs/REVIEW.md`.
- `SignaturePad` caches committed strokes on an **offscreen canvas**: per-frame redraw cost drops from O(all points) to O(current stroke).
- Frontend fully self-hosted (React 19 vendored in `htdocs/vendor/`, no CDN — truly offline).

### Tests
```bash
node test/recognition_test.mjs                     # stability battery + JS/WASM exact parity + perf (seeds: --seeds=1,2,7; parity runs: --runs=1200)
node test/worker_smoke.js                          # crypto round-trip smoke (zero dependencies; tests shipped sodium.js)
cargo test --manifest-path rust/recognition/Cargo.toml   # Rust unit tests
```
Manual stability: open `htdocs/pad-tester.html`, draw 10+ times and check the consistency rate (warm up 1–2 times first).

## Ciphertext Format
`WE2.<salt(16B,base64)>.<IV(12B,base64)>.<ciphertext(base64)>.<MAC(16B,base64)>`.
> Each pattern segment is encoded as one digit: R/RU/U/LU/L/LD/D/RD → 0/1/2/3/4/5/6/7. RU is `1`, while R followed by U is `02`; HKDF info is `WebEncryptor:enc:v2` and AAD is `WebEncryptor:v2`.

Plaintext is limited to 4 MiB of UTF-8 bytes; ciphertext is limited to 5,592,479 characters including format overhead. Decryption and saving use the same ciphertext limit. API requests have a 32 MiB JSON limit and reject invalid field types. Requests time out after 30 seconds; refresh the list before retrying an uncertain write. Manager refreshes retain unsaved drafts and ignore stale responses.

The database persists `{nextId,entries}` so deleted IDs survive restarts.

## Password Generation
The encryption panel includes random password generation (8 / 14 / 18 characters).

# Disclaimer
This project was primarily developed using AI assistance.
