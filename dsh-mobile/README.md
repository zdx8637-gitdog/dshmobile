# dsh-mobile — DeepSeek Harness 手机客户端

Kotlin + Jetpack Compose。远程控制本地 DSH 实例：登录 → 设备 → 会话树 → 对话。

## 架构

```
Android (Compose) ──WSS──> relay (<relay-host>) ──WSS──> bridge ──回环──> DSH (127.0.0.1:3080)
```

- 服务器只转发；手机不落盘会话数据（仅 token 存 Keystore）；
- 协议契约：../dsh-remote/docs/02-protocol.md（单一事实来源）；
- 三屏路由：Auth → Navigator（设备 + 会话树）→ Conversation。

## 构建

```powershell
$env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\<user>\AppData\Local\Android\Sdk'
D:\p\tools\gradle-8.13\bin\gradle.bat :app:assembleDebug
# APK: app\build\outputs\apk\debug\app-debug.apk
```

## 状态（2026-08-16）

P0 已验证（Android 36 模拟器）：登录 → 设备 → 会话树 → 历史 → 发消息 → 流式回复全链路通过。
APK：`app/build/outputs/apk/debug/app-debug.apk`。

新增：设备条目删除（F23）——删除 = 服务器吊销（`POST /devices/:id/revoke`），
所有端同步消失；电脑重新登录会自动重新注册回来（误删可恢复），手机端不落删除状态。

## 目录

- `app/src/main/java/dev/dshmobile/app/net/` — 协议层：Models、RemoteClient（WS 重连/token 刷新/请求归属）、CloudApi（REST，含设备吊销）
- `app/src/main/java/dev/dshmobile/app/state/AppRepository.kt` — 单一状态仓库（内存态）
- `app/src/main/java/dev/dshmobile/app/storage/TokenStore.kt` — Keystore 加密 token
- `app/src/main/java/dev/dshmobile/app/screens/` — Auth / Navigator / Conversation

## 版本决策

- minSdk 26 / target 36，无 GMS 依赖（小米/vivo/OPPO/华为卓易通可用）；
- Kotlin 2.0.21 + Compose BOM 2024.12 + kotlinx.serialization + OkHttp 4.12；
- 协议按 DSH 语义（sessions.*），RemoteClient 骨架移植自 sessioncontrol-ref。
