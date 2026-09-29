# 密码库条目

WebEncryptor 保留 `passwords.json` 的 `{nextId, entries}` 外层结构。旧条目继续使用 `{id,name,description,password}`；没有 `type` 的条目视为独立文本条目，WE2 加解密格式不变。

新条目 `type: "vault"` 保存一个密码库：

```json
{
  "id": 2,
  "type": "vault",
  "vaultId": "12345678-1234-4234-8234-123456789abc",
  "revision": 1,
  "name": "Personal",
  "description": "",
  "password": "WVK1.<header>.<salt>.<nonce>.<encrypted-key>",
  "children": [
    {
      "id": "87654321-4321-4321-9321-cba987654321",
      "name": "",
      "description": "",
      "password": "WVI1.<nonce>.<ciphertext>"
    }
  ]
}
```

示例密文是格式占位符。空库保存时可以省略 `children`，读取时视为 `[]`。顶层 ID 由服务器分配，子条目 UUID 由客户端生成，不消耗 `nextId`。只允许一层子条目，类型和 `vaultId` 创建后不可改变。

## 页面

- **Password Vaults**：默认选项卡。创建或选择库后输入口令、棋盘、图案；创建和修改凭据要求重画验证。解锁后隐藏凭据区，支持账号新增、编辑、删除、搜索、复制、20 字符随机密码和加密备份恢复。
- **Text Encryption**：原有任意文本的独立三因子加解密，结果可存入独立条目。
- **Independent Items**：旧条目管理器，过滤掉密码库。解密和编辑流程保留。

库内账号明文包含 `name,url,username,password,notes`，整体加密。子条目的外层名称和描述必须为空。密码库自身的名称、描述、条目数量、标识和修改版本仍为可见元数据，不应在库标签里填写秘密。

从独立条目导入时，使用该条目原来的三因子解密，明文作为新账号的密码，旧名称和描述成为加密账号名称和备注。原条目保留。不能自动恢复缺少原凭据的旧条目。

## 密钥与格式

库密钥是客户端首次建库时生成的 32 字节随机数，只以加密形式发送给服务器。

`WVK1` 的 Base64 JSON 头包含 `v:1,vaultId,kdf:"argon2id",ops:3,mem:268435456,factors:2`。盐为 16 字节，nonce 为 24 字节，加密后的库密钥及标签合计 48 字节。格式、参数、标识和长度均严格校验，当前版本只接受上述参数。

保护密钥复用原有长度前缀图案/棋盘编码、BLAKE2b 盐压缩和 Argon2id；HKDF-SHA256 的 info 改为 `WebEncryptor:vault:wrap:v1` 以分离用途。XChaCha20-Poly1305 加密库密钥，AAD 为 UTF-8 的 `WebEncryptor:vault:wrap:v1.<Base64头>`。

每个账号从库密钥派生独立的 32 字节密钥：HKDF-SHA256，32 字节全零盐，info 是 UTF-8 JSON 数组 `["WebEncryptor:vault:item:v1",vaultId,itemId]`。同一数组同时用作账号加密的 AAD。每次账号修改生成新的随机 24 字节 nonce，使用 XChaCha20-Poly1305，加密 JSON 账号对象及认证标签。

库及条目标识参与派生和认证，调换标识或跨库移动密文会解密失败。正常修改解锁凭据只重新保护原库密钥，账号密文保持不变。本版本没有库密钥轮换功能。

独立 Worker 持有当前库密钥，消息只返回密文或操作所需的账号明文，绝不返回原始库密钥。锁定、离开页面和 5 分钟无操作时终止 Worker、取消待处理请求并清理账号列表与表单。JS 字符串及浏览器管理的内存无法保证物理清零；不将库密钥、主口令或账号明文写入 localStorage。

## API 与保存

仍使用 `/api/passwords` 的 GET、POST、PUT、DELETE。创建库提交完整条目（无顶层 `id`，`revision` 省略或为 0），服务器分配 ID 并设置版本 1。PUT 提交完整库和读到的版本；服务器在互斥锁内检查版本并递增，落盘后返回新条目。过期或缺失版本返回 409，不自动覆盖、合并或重试。

删除密码库必须提交 `If-Match: "<revision>"`。独立条目的原有局部更新与删除接口不变。嵌套条目的 GET 与更新采用分离的快照，复用临时文件、文件同步、原子替换和目录同步机制。损坏的新类型文件会拒绝启动并保留原文件。

写入网络中断或 500 时，客户端保留草稿并阻止继续写入，提示复制草稿后锁定、重新打开检查实际状态。创建结果不确定时保留同一个 UUID 和加密密钥，Refresh 查询是否已创建；未创建可以重试同一份内容，UUID 唯一性防止重复库。锁定后晚到的请求回复不能重新显示明文，但已提交给服务器的写入仍可能完成。

限制：每库最多 1000 条；账号 JSON 明文最多 64 KiB；库的紧凑 JSON 最多 24 MiB；API 请求最多 32 MiB。版本检查防止正常并发操作丢失更新，不提供恶意服务器回滚或删减完整文件的检测。

加密备份下载为单库的 `{nextId,entries}` JSON。Restore backup 保留密码库及子条目的 UUID，分配新的顶层 ID，原凭据仍然可用。恢复不会覆盖同 UUID 的现有库。已有客户端可以读取旧条目；旧版本程序会拒绝新字段，升级前应备份原文件，不要用旧程序打开新增密码库后的文件。

## 验证

```bash
go test -race ./...
node test/worker_smoke.js
node test/vault_crypto_test.cjs
node test/vault_client_test.mjs
node test/password_service_test.mjs
node test/business_state_test.mjs
go build -o /tmp/webencryptor-business-server .
python3 test/browser_flow.py --server /tmp/webencryptor-business-server
```

真实 Firefox 套件使用临时数据，覆盖旧流程与密码库创建、重画验证、账号加密、搜索、复制调用、并发冲突与草稿保留、锁定、凭据修改、旧密文导入、备份恢复、保存晚到回复和创建响应丢失恢复及手机布局。复制测试注入 Clipboard API 回调，空闲测试触发实际定时器的到期回调，指针操作使用真实 DOM 中的合成事件，不覆盖原生剪贴板权限、真实等待五分钟、触屏硬件和物理内存清除。
