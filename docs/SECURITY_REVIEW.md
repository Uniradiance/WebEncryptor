# WebEncryptor 安全审查报告（公网暴露风险评估）

> 审查范围: server.go 全部 582 行、htdocs/ 全部前端模块、dist/ 发布产物、
> build.sh、.gitignore。审查方式: 静态阅读 + 本地构建二进制实测复现
> （无 token 读写、shutdown、CORS 预检、--dir 目录列举与文件下载、证书/密钥配对校验）。
>
> **结论先行: 当前状态不建议直接对公网开放。** 核心加密方案（三因子盐派生 +
> Argon2id + HKDF + 单层 ChaCha20-Poly1305）设计正确，密文可公开存放；
> 但服务器默认配置（无 token）等于对任何能触达端口的人开放全部密码库读写与
> 远程关机，且发布产物里捆绑了 TLS 私钥和开发数据，公网场景下可被完整接管。

---

## 0. 风险等级总览

| 等级 | 问题 | 位置 | 实测证据 |
|---|---|---|---|
| 严重 | 默认无 token = 公网任何人读写密码库 + 远程关机 | server.go:214, 328, 546 | 无 token POST 返回 201 并写入条目; POST /api/shutdown 返回 200 且进程退出 |
| 严重 | dist/ 发布产物捆绑 TLS 私钥 + 开发数据 | dist/cert/key.pem, dist/passwords.json | 证书与私钥模数指纹一致 (e77d7503...); 二进制默认复用该密钥对 |
| 严重 | 自签证书 + sodium.js 无完整性校验 → 可被 MITM 替换加密代码 | server.go:533; crypto_worker.js:30 | importScripts 不支持 SRI; 无 HSTS |
| 高 | --dir 开启目录列举, 可下载 passwords.json / cert/key.pem | server.go:483-506, 177 | 实测 dist/ 全量目录列举, passwords.json 与 key.pem 均 200 下载 |
| 高 | http.Server 无任何超时 → slowloris 类 DoS | server.go:539 | 源码确认 (无 Read/Write/Idle/Header 超时) |
| 高 | API 无速率限制 → token 爆破/磁盘耗尽/关机刷屏 | server.go:203-336 | POST 无限制写库, 每次全量重写 passwords.json |
| 中 | CORS `Access-Control-Allow-Origin: *` + 放行 X-Auth-Token | server.go:206-208 | 实测任意 Origin 预检通过 |
| 中 | 无 CSP / X-Frame-Options / HSTS | server.go:146 | 响应头实测缺失 |
| 中 | token 非恒定时间比较、明文打印在控制台、存于 localStorage | server.go:214,543; password_service.js:19 | — |
| 低 | 服务端不校验存储格式, 明文密码可直接入库 | server.go:231-258 | 实测 POST "hunter2" 原样存储返回 |
| 低 | saveDB 无 fsync; 条目数无上限 | server.go:99-115 | — |

---

## 1. 严重问题（必须先处理）

### 1.1 默认配置下 API 完全开放 [实测复现]

`--token` 未设置时（默认值），token 检查被跳过（`if s.token != ""`，
server.go:214）。实测：

```
$ curl -X POST -H 'Content-Type: application/json' \
     -d '{"name":"pwned","password":"hunter2"}' \
     http://<host>:8443/api/passwords
HTTP/1.1 201 Created
{"id":1,"name":"pwned","description":"","password":"hunter2"}

$ curl -X POST http://<host>:8443/api/shutdown
HTTP/1.1 200 OK  → 服务器进程直接退出
```

即：**任何人能读取/新增/修改/删除全部密码条目、远程关闭服务器**。
启动日志虽有 WARNING（server.go:546-547），但默认行为是"打开即裸奔"，
公网场景下等于默认失守。

### 1.2 发布产物捆绑 TLS 私钥 [实测复现]

`dist/cert/cert.pem` 与 `dist/cert/key.pem` 是一对真实 RSA-2048 密钥
（模数指纹一致），且 `ensureCert`（server.go:392-405）在证书已存在时直接复用。
所有使用该 dist 目录部署的实例共享**同一把私钥**——任何拿到二进制的人都能
解密/篡改任意实例的全部 TLS 流量。此外 `dist/passwords.json` 还携带了
开发者的真实数据（含 WE1 密文）。`dist/` 虽在 .gitignore 中，但作为发布物
一旦分发即为泄漏。发布前必须清理，证书应在每台机器首次运行时生成。

### 1.3 传输层可被 MITM，加密代码可被替换

- 证书为自签（SAN 默认仅 localhost），浏览器无法验证身份，用户点击警告后
  继续使用 → 中间人可完全控制通信内容。
- `crypto_worker.js` 用 `importScripts("sodium.js")` 加载 1 MB 加密库，
  **importScripts 不支持 SRI/完整性校验**；页面也无 CSP。
- 后果链：MITM → 替换 sodium.js/任意 JS → 窃取口令、三因子、明文。
  在公网（公共 Wi-Fi/运营商/被控路由）上这是现实威胁。
  客户端加密的全部安全性都建立在"服务器下发的代码可信"之上，公网暴露下
  该前提不成立。

---

## 2. 高问题

### 2.1 --dir 静态目录 = 敏感文件自助下载 [实测复现]

`http.FileServer` 默认开启目录列举。实测 `--dir dist` 后：

```
GET /                        → 完整目录列表 (cert/, passwords.json, 各平台二进制)
GET /passwords.json          → 200, 全部密码条目明文返回
GET /cert/key.pem            → 200, TLS 私钥直接下载
```

用户若把 `--dir` 指向可执行文件所在目录（含 passwords.json、cert/、
server.log），等于把所有数据挂到网上。路径穿越本身被 FileServer 正确拦截
（Clean 后 307），此项安全。

### 2.2 服务器无超时/无速率限制 → DoS

- `httpSrv = &http.Server{Handler: handler}`（server.go:539）未设置
  ReadTimeout/ReadHeaderTimeout/WriteTimeout/IdleTimeout：慢速连接可无限占住
  goroutine/连接 → slowloris 拒绝服务。
- API 无任何速率限制：token 可在线爆破（token 弱时）；POST 可无限刷库，
  每次全量重写 passwords.json（无条目数上限）→ 磁盘耗尽；shutdown 可被反复触发。
- 单请求体 1 MiB 上限（server.go:237,272）已有限制，值得肯定。

### 2.3 CORS 全开 + 无 Origin/Host 校验

`Access-Control-Allow-Origin: *` 且放行 `X-Auth-Token` 头：任何恶意网站
只要拿到 token（或服务器无 token）即可跨域读写 API 并读取响应。配合
0.0.0.0 绑定与无 Host 校验，DNS rebinding 也可绕过 CORS（现代浏览器
PNA 有部分缓解）。本地工具可接受，公网场景应改为仅同源（不返回 ACAO 或
返回具体 Origin）。

---

## 3. 中/低问题

1. **token 比较非常数时间**（server.go:214，`!=`）：token 足够长时网络侧
   利用不现实，但应改为 `subtle.ConstantTimeCompare`。
2. **token 明文打印到控制台**（server.go:543）、**存于 localStorage**
   （password_service.js:19）：页面一旦存在 XSS（当前无注入点，但无 CSP
   兜底），token 即被窃取；共享浏览器会话内所有访问者共用一个 token。
3. **无 CSP/X-Frame-Options/HSTS**：点击劫持可诱导用户触发
   "Shutdown"/删除按钮；公网建议 `frame-ancestors 'none'`。
4. **服务端不校验 password 字段格式**：API 可存入/返回明文（实测
   "hunter2" 原样落盘）。若设计上只存 WE1 密文，应在服务端校验
   `WE1.` 前缀与字段长度。
5. **saveDB 无 fsync**（崩溃断电可能丢最近一次写入）；临时文件与目标同目录
   原子 rename 正确，并发写由互斥锁串行化，无竞态（已核实）。
6. **访问日志记录完整 URL**（无查询串，token 走 header 不落日志，此项安全）。
7. **无 per-user 模型**：token 是单一共享秘密，公网多人使用场景一旦泄露即
   全量沦陷；也没有审计/锁定机制。

---

## 4. 做得好的地方（保留）

- **加密方案**：三因子拼入 KDF 盐（长度前缀防歧义）→ BLAKE2b-128 →
  Argon2id(256MiB, 3轮) → HKDF 域分离 → ChaCha20-Poly1305 单层；
  密钥/盐主动零化；密文 `WE1.` 格式自描述。设计正确，密文可公开存放。
- **认证形态**：token 走自定义 header（非 Cookie），跨站自动请求需预检，
  客观上缓解了经典 CSRF（但被 ACAO * 部分抵消）。
- **HTTP 硬化**：TLS 1.2 下限、API no-store、全局 nosniff、静态强 ETag+304。
- **前端**：无 `eval`/`new Function`，渲染全部走 `textContent`/
  静态模板，未发现 XSS 注入点；全自托管无第三方请求（无外泄信道）。
- **输入边界**：body 1 MiB、明文 4 MiB、密文 6 MiB、口令/路径/链码上限；
  WASM 手工 ABI 无 extern 调用面。
- **工程**：纯 Go 标准库零依赖、原子写库、跨平台构建、测试套件（识别
  parity/稳健性、加密往返）齐全。

---

## 5. 公网暴露结论与整改建议

**结论：不安全，当前状态请勿直接对公网开放。** 最小可用前提：
强随机 token 强制启用（或首次运行自动生成）；发布物不携带 cert/key 与
passwords.json；--dir 绝不指向含敏感文件的目录。

按优先级整改：

1. **强制认证**：无 `--token` 时拒绝启动 API（fail-closed），或首启自动
   生成随机 token 写入 0600 文件；token 用恒定时间比较。
2. **清理发布物**：build.sh 增加清理步骤，确保 dist 不含 cert/、passwords.json、
   server.log；证书每机首次运行生成（现有逻辑，删除捆绑物即可）。
3. **传输安全**：改用受信 CA 证书（Let's Encrypt / 反向代理终止 TLS），或
   明确仅限可信内网；增加 HSTS（受信证书时）；sodium.js 改用支持 SRI 的
   加载方式（如 fetch + integrity 校验后再 importScripts/blob URL）。
4. **反向代理 + 网络层防护**：8443 仅绑定 127.0.0.1（加 `--host` 参数），
   由 nginx/caddy 暴露：TLS 终止、限流（rate limit）、请求体/头大小限制、
   X-Frame-Options/CSP、日志审计。API 与页面同源，去掉 ACAO。
5. **服务器硬化**：`http.Server` 增加 ReadHeaderTimeout/ReadTimeout/
   WriteTimeout/IdleTimeout（如 5s/10s/15s/60s）；API 按 IP 限流；
   条目数/库文件大小上限；shutdown 增加二次确认 token 或仅允许本机来源。
6. **数据校验**：服务端校验 `password` 字段必须为合法 `WE1.` 密文格式；
   saveDB 落盘后 `f.Sync()`。
7. **文档**：README 补充"公网部署清单"（强制 token、代理 TLS、防火墙只开
   代理端口）。

---

## 6. 复现命令（本次审查实测用）

```bash
go build -o /tmp/webencryptor .
/tmp/webencryptor --port 18443 --no-browser --http          # 无 token 实例
curl -X POST -d '{"password":"hunter2"}' 127.0.0.1:18443/api/passwords   # 201
curl -X POST 127.0.0.1:18443/api/shutdown                  # 200, 进程退出
/tmp/webencryptor --port 18444 --no-browser --http --dir dist
curl 127.0.0.1:18444/                                      # 目录列举
curl 127.0.0.1:18444/passwords.json                        # 200
curl 127.0.0.1:18444/cert/key.pem                          # 200
openssl x509 -in dist/cert/cert.pem -noout -modulus | md5sum   # 与
openssl rsa  -in dist/cert/key.pem -noout -modulus | md5sum    # 一致
```

（审查后已清理全部临时进程与文件。）
