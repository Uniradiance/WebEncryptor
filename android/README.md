# WebEncryptor for Android

独立离线 Android 应用，直接将仓库中的 `htdocs/` 前端打包进 APK，由 WebView 承载。Kotlin 存储层通过进程内 JS 桥提供密码库 API；应用没有监听端口，也没有 `INTERNET` 权限。

## 构建

需要 JDK 17、Android SDK platform 35 和 build-tools 35.0.0。可用仓库内的 Gradle wrapper 构建：

```bash
cd android
./gradlew assembleDebug assembleRelease
```

也可将工具链安装到临时目录，再使用构建脚本：

```bash
android/tools/setup-toolchain.sh
android/tools/ci-build.sh assemble
```

工具链默认位于 `/tmp/webencryptor-toolchain`，可用 `WE_TOOLCHAIN` 指定位置。构建脚本将 APK 复制到 `android/build-artifacts/`；`android/tools/ci-build.sh clean` 清理构建产物。

- `app-debug.apk`：应用 ID 带 `.debug` 后缀，支持 WebView 远程调试。
- `app-release.apk`：启用 R8 和资源压缩，关闭 WebView 调试。默认使用 debug 签名；正式发布时设置 `WE_KEYSTORE_FILE`、`WE_KEYSTORE_PASSWORD`、`WE_KEY_ALIAS`、`WE_KEY_PASSWORD`。

仅有 SOCKS5 网络出口的构建环境可使用工具链脚本提供的 `tools/DevProxy.java`，构建脚本会按代理配置启动它。

## 存储与使用

应用从 `https://appassets.androidplatform.net/assets/` 加载前端。`htdocs/` 直接作为 asset 源目录，无需另行同步；构建时生成 `htdocs-manifest.json`，记录资源的 SHA-256。

密码库的字段、JSON 编码和版本检查沿用桌面端语义。数据库整体用 AES-256-GCM 加密，数据密钥由 Android Keystore 包裹；损坏或无法解密的数据库会保留并进入只读保护态。请通过页面导出加密备份，系统备份已禁用。

应用进入后台时锁定密码库；系统文件选择器期间延后到返回时锁定。剪贴板内容标记为敏感数据，45 秒后清除。应用和 JS 对话框启用 `FLAG_SECURE`，限制截图及最近任务预览。

## 已知差异

- `POST /api/shutdown` 返回 200 并提示离线应用没有服务可关。
- 请求不使用桌面服务器的 token、TLS 或 401 认证机制。
- 多字段同时非法时按校验顺序返回第一项错误。
