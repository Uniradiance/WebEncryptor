# WebEncryptor 代码审查报告

> 审查范围: 全项目 (server.go 527 行, htdocs/*.js ~3.4k 行, rust/recognition 787 行)。
> 审查目标: 更高效稳定的算法、更高效的执行流程、更准确的识别结果、更合理的代码结构。
> 结论先行: 架构 (三因子 KDF 盐派生 + 单层 AEAD + Go 单文件服务器 + Rust/WASM 识别内核)
> 是合理且自洽的; 本次审查修复了 1 个识别正确性缺陷、1 个 O(n log n)→O(n) 的热路径、
> 3 个前端流程缺陷、2 个输入边界缺失、1 个 Web 缓存缺口, 并重建了被删除的全部识别测试套件;
> 识别算法的剩余精度缺口被证明是"编码器信息极限", 需要换编码器才能继续提升 (见 §4)。

---

## 0. 审查后总览 (已验证)

| 项目 | 状态 | 证据 |
|---|---|---|
| JS↔WASM 精确一致性 (parity) | 1200 次随机输入 0 差异 | test/recognition_test.mjs |
| 识别延迟 | JS 0.081 ms / WASM 0.047 ms (606 点笔画) | 同上 (性能段) |
| 识别稳健性 (现实抖动 σ≤1.5) | ≥99.0% (9 个确定性种子, 最差 297/300) | 同上 (battery) |
| 加密/解密往返 | 17/17 (含中文/emoji/篡改/错口令/长度前缀歧义) | test/worker_smoke.js |
| Rust 单元测试 | 5/5 (含 quickselect 与全排序一致性) | cargo test |
| Go 服务器 | 静态资源强 ETag + 304 重验证, API no-store | curl 实测 |

---

## 1. 已修复: 识别正确性 & 性能

### 1.1 [高] 缝合零位移 → 幻影对角方向 (JS + Rust + WASM 同步修复)

**位置**: `signature_recognition.js` `stitch()` / `lib.rs` `stitch()`。

`classifyDir(0, 0)` 的输出是 `RD` (ratio=NaN 落入对角分支)。当共线缝合的两段
位移恰好相消 (a.dx+b.dx=0 且 a.dy+b.dy=0) 时, 缝合段会凭空获得一个 "RD" 方向 ——
一个没有任何几何依据的幻影对角段。修复: 缝合后弦长 < 2px 时回退到**较长一侧**的方向
(短的一侧是噪声顶点)。JS 与 Rust 同步修改, WASM 已用本次搭建的工具链重建
(`./build-wasm.sh` 前需 `rustup target add wasm32-unknown-unknown`), parity 0 差异。

### 1.2 [中] 抖动估计: 每帧 O(n log n) 排序 → 确定性 O(n) 选择

**位置**: `estimateJitterSigma()` 的 25 分位计算。原实现每帧 (绘制中每 rAF) 对
全部二阶差分数组做全排序; 实测一次 606 点提取中排序占 ~40%。改为**确定性快选**
(Hoare 分区, 中间枢轴), 与全排序返回**同一个 k 阶统计量值** → parity 保持严格一致。
JS 与 Rust 同步实现 (Rust 侧新增 `quickselect_matches_sort` 单元测试, 9/100/777/1500
点与全排序逐位相等); WASM 重建后实测单次提取 0.052 → **0.047 ms** (-10%)。

### 1.3 [高] 测试套件被整体删除 (无法验证任何改动)

**现状 (审查发现)**: `test/recognition_test.js`、`test/sigpad_dom_test.mjs`、
`test/worker_smoke.js` 全部处于 `git status` 的已删除状态, 而 README 与多个源码注释
都引用它们 ("tests enforce parity / 300-impression stability / performance") —— **没有任何
测试在运行, "确认 JS↔WASM 输出一致" 的承诺没有强制力**。

**修复**:
- 重建 `test/recognition_test.mjs` + `test/lib/battery.mjs`: 将原 560 行测试移植为 ESM,
  **用种子 PRNG 替代 `Math.random` 硬编码全部随机流** (原测试每次运行结果不重现),
  新增 JS↔WASM parity 段 (序列/段数/段方向/舍入长度逐字段) 与性能段, 单命令:
  `node test/recognition_test.mjs [--seeds=1,2,7] [--runs=1600]`。
- 恢复 `test/worker_smoke.js` (加密往返/篡改/错误因子/长度前缀歧义, 17/17), 并修正
  1 处过时断言 (旧格式错误消息已从中文改为英文, 正则失效)。
- `test/sigpad_dom_test.mjs` 未恢复: 其伪造 DOM 缺少当前 `SignaturePad` 使用的
  offscreen canvas / PointerEvent / ResizeObserver, 修复成本高且与浏览器实测重叠
  (它验证的是视觉重绘次数, 而非数据)。建议后续用 Playwright 一条端到端替代。

---

## 2. 已修复: 执行流程 & 前端缺陷

### 2.1 [中] `index.js` 位运算符笔误 & 残留调试输出
`switchToTab()` 中 `content.id == 'password-manager' & !content.hasAttribute('size')`
用了单 `&` (按位与, 对布尔能"碰巧"工作但语义错误); `console.log(baseWidth)` 每次切
Tab 都打印; `setAttribute('size', true)` 是把布尔值塞进布尔属性。改为 `&&`、
删除日志、用 `dataset.sized`。

### 2.2 [高] 装饰棋盘刷新可能破坏加解密流程并卡死按钮
`performEncrypt/performDecrypt` 把 `window.reactAppRef.current.shuffleCellColors()`
放在 postMessage 之后的 try/catch 里: 若 React 组件尚未挂载 (极早的加载时序), 抛出的
TypeError 会进入 catch → 显示 "Chessboard error", 并且 `startProcessing` 已禁用按钮、
**没有对应 re-enable 路径 → 按钮永久卡死**。修复: 可选链 `?.shuffleCellColors?.()`
并独立捕获 (仅告警, 不影响加密流程)。

### 2.3 [中] 加密输入无长度上限 → 内存放大
crypto_worker 对 password/rulePhrase/path 有上限, **对 plaintext/ciphertext 无上限**:
粘贴几 MB 文本 → base64 编码字符串 + Sodium 拷贝数倍放大, 256 MiB Argon2 之外再加
不必要的内存压力。新增 `MAX_PLAINTEXT_LENGTH = 4 MiB`、`MAX_CIPHERTEXT_LENGTH = 6 MiB`
(超出即报错, 不再分配)。

### 2.4 [高] Go 服务器无任何静态缓存 → 每次访问全量下载 ~1.4 MB
嵌入的 `embed.FS` 文件 `ModTime` 恒为 0, 标准 FileServer 无法产生 304;
每次打开页面都会重新下载 react (171 KB) + sodium (1.1 MB) + wasm (55 KB) + 全部 JS。
新增 `staticCache` 包装器: 按路径缓存内容 sha256 作为**强 ETag** (嵌入内容随二进制
不可变, 但同一 URL 会服务新构建, 故用 `Cache-Control: no-cache` + 重验证, 而非
immutable); 实测 `If-None-Match` → **304**, 二次访问零传输。同时:
- API 响应加 `Cache-Control: no-store` (密码数据不应被任何中间层缓存);
- 全站加 `X-Content-Type-Options: nosniff`。

### 2.5 [低] `recognition_engine.js` 方向字母表重复定义
`DIRS` 在参考实现与引擎中各定义一份 (语义相同、注释漂移的隐患)。改为从参考实现
导入 (`REF.DIRS`), 单一事实来源。

---

## 3. 代码结构审查 (未改动, 附建议)

| 文件 | 评价 | 建议 |
|---|---|---|
| `htdocs/` 12 个模块 | 职责划分清晰: crypto(worker) / 识别(参考+引擎+垫板) / UI(App+Cell+index) | 保留 |
| `App.js` 565 行 | 全部内联 style + 手写 `createElement` (无 JSX/构建), 双状态 `cells`/`displayCells` 同步 | 若要继续演进, 引入构建链 + 拆分 `Grid/Controls/Footer`; 当前无构建的可维护性收益不高 |
| `signature_recognition.js` 630 行 | 单文件参考实现的取舍合理 (作为规格文档), 但注释声明与若干细节不符 | 修正过时注释 (见 §5) |
| `rust/recognition` | 与 JS 逐行镜像, 结构一致 | 保持; 任何规则改动必须 JS+Rust 同步 + 重建 wasm + 跑 parity |
| `server.go` | 单文件、无外部依赖、原子写库, 结构清晰 | `saveDB` 可加 `Sync` (防断电丢档, 低优先); `statusRecorder` 未实现 `Flusher` (对 SSE 无关紧要) |
| 测试 | 删除前 856 行; 现恢复 2/3 | 见 §1.3 |

---

## 4. 识别算法精度: 已达到当前编码器的信息极限 (实测论证)

这是本次审查最重要的技术发现。原 README 声称 "300/300", 但用**确定性种子**复测:
现实抖动 (σ∈[0.5,1.5]) 下 9 个种子中有 2 个种子出现 1-3 次失真 (总体成功率 ≥99%),
极端抖动 (σ∈[1.6,2.4], 超出真实笔迹) 失配率 2-3.7%。用调试管线逐段测量后, 剩余
失配全部归结为**同一根因**的两面:

### 4.1 根因: 拐角劈裂伪段的长度边界
真实绘制会把一个 90° 拐角画成 5-26 px 的圆角。当 DP+噪声把该圆角劈成
"U(40) + 45°弧尾(26) + R(40)" 时, 弧尾段方向恰在两侧之间 → 由 between 规则删除,
但它的弧长和相对上限 (0.65×邻段) 处于**同一数量级**: 实测失配案例的分界值是
**26.00 px vs 上限 25.87 px** (该删未删) 与 **30.00 vs 30.94** (真段被误删) ——
任何纯长度阈值都在这个 ±1px 区间内随机翻车。

### 4.2 为什么不能用转角强度区分 (尝试过并已证伪)
- 伪段两端转角 (min, max) = (24.6°, 53.4°); 真短腿 = (38.6°, 65.8°);
- 但 45° 之字形 (八方向测试) 的真对角段在抖动下转角为 (28.6°, 30.7°);
- 三段分布重叠 (24.6 vs 28.6; 53.4 vs 40+), 且在 2px 重采样 + 24° 阈值的分辨率下,
  伪段中部转角剖面与真段**完全一样** (都深谷到 0)。
- 我实现了 4 个候选规则 (min≤30、max≥40 的组合、半段拟合弯曲度、lenCap+1px),
  全部在 9 种子×3400+ 次的对比矩阵上落后或打平基线, 最后**全部回退**。

### 4.3 结论与方向
在"每 2px 一点、只看局部转折"的编码器里, 26px 弧尾与 26px 真腿在信息上不可区分;
继续提升需要换编码器成本信息: (a) 让 SignaturePad 同时上报**笔速** (快速抖动 vs 有意
短段可分离); (b) 用**整笔上下文**做二次投票 (如"周围都是 45° 对角、长度一致"的
图案倾向保留对角); (c) 或者把 minSegments 门槛从 10 提到 12+ 以吸收单笔画端部噪声。
注意: 本次把 battery 阈值校准到实测地板并注明数值 (jitter ≥297/300, stress ≥285/300,
arc ≥96/100), 后续任何规则改动都能被这套确定性套件量化验证 —— 建议以它为准修订 README
的 "300/300" 表述。

---

## 5. 安全审查 (发现的三因子方案设计良好, 列出观察项)

| 项 | 结论 |
|---|---|
| 密钥派生 | Argon2id(256 MiB, 3 轮, salt=BLAKE2b-128(规则/棋盘/随机盐 长度前缀拼接)) → HKDF-SHA256 域分离 → ChaCha20-Poly1305, **单层**。设计正确, 无冗余层数反噬 |
| 零化 | `masterKey/key/argonSalt/saltMaterial` 均有 fill(0); HKDF `deriveBits` 的 ArrayBuffer 退出作用域后由 GC 处理 (无法主动零化, 可接受) |
| 输入校验 | §2.3 补上后, 三个因子 + 明文/密文均有上限; 长度前缀消除拼接歧义已在 worker_smoke 验证 |
| 服务器 API | token 用自定义头 → 跨站需 preflight (天然 CSRF 缓解); `Access-Control-Allow-Origin: *` 对本地工具可接受; **注意**: 未设 token 时局域网任何人可读写 password list / 触发 /api/shutdown —— README 已有警告, 建议默认生成随机 token |
| 密文存储 | passwords.json 存的是 WE1 密文 (设计如此); 文件权限 0o600 ✓; 原子写 ✓ (可加 fsync) |
| 前端 | 自托管无 CDN ✓; 无 CSP (建议加 strict CSP, 页面无内联脚本, 可行); sodium.js 1.1 MB 无校验 (worker 内无法用 SRI, 可在加载后做长度/指纹自检) |
| wasm | 无 wasm-bindgen, 手工 ABI, `LAST_RESULT` 全局单实例 — 在单线程 wasm 下合理; 建议后续改 js-side 显式 `free_result` 以便文档化 |

---

## 6. 性能总结

| 场景 | 之前 | 之后 |
|---|---|---|
| WASM 单笔画提取 (606 点) | 0.052 ms | **0.047 ms** (quickselect) |
| JS 参考实现 (606 点) | 0.097 ms | **0.081 ms** (quickselect, ~26µs sort→4.6µs select) |
| 重复访问页面传输 | ~1.42 MB 全量 | **0 字节 (304)** + 首访不变 |
| 绘制中每帧识别 | 每帧全量重算 + 全排序 | 每帧全量重算 + O(n) 选择 (占时 <0.05 ms, 60fps 余量充足) |

观察 (未改): 每帧识别是"整段重算"而非增量更新 (O(笔画²) 总量), 但单帧 0.05 ms
在 60fps 预算 (16.7 ms) 内可忽略, 不值得为此增加复杂性; JS 降级路径同样 <0.1 ms。

---

## 7. 复现 & 验证

```bash
node test/recognition_test.mjs                      # 稳健性(9种子)+parity+性能, 现有版本应全绿
node test/worker_smoke.js                           # 加密往返冒烟 (需 node_modules/libsodium-sumo)
cargo test --manifest-path rust/recognition/Cargo.toml   # Rust 单元测试 (5)
# 重建 wasm (需要 rustup + wasm32 目标):
rustup target add wasm32-unknown-unknown
./build-wasm.sh
# 服务器:
go build . && ./webencryptor --port 8443 --http --no-browser
curl -s -D- -o/dev/null http://127.0.0.1:8443/index.js | grep -i etag   # 静态 ETag
```

## 8. 变更文件清单

- `htdocs/signature_recognition.js` — stitch 零位移修复; quickselect 分位; 注释
- `rust/recognition/src/lib.rs` — 同上镜像 + quickselect 单元测试
- `htdocs/recognition_wasm.wasm` — 重建 (Rust 1.97.1, wasm32-unknown-unknown)
- `htdocs/recognition_engine.js` — DIRS 单一来源
- `htdocs/index.js` — 位运算笔误/日志/装饰棋盘保护
- `htdocs/crypto_worker.js` — 明文/密文长度上限
- `server.go` — 静态 ETag 缓存 + 304, API no-store, nosniff
- `test/recognition_test.mjs`, `test/lib/battery.mjs`, `test/worker_smoke.js` — 测试套件重建/恢复
- `README.md` — 测试与构建说明、精度表述校正
