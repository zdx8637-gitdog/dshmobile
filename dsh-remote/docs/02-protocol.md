# 协议契约

本文档定义 dsh-remote 链路两端的线格式，是 Android 客户端与 bridge 实现的单一事实来源。

## 1. 传输拓扑

```
DSH (127.0.0.1:3080)          ← 无认证，信任栅栏只放行回环
  ▲ POST /api/* + WS /api/events.mux + /api/events.host（只读下行）
  │
DSH bridge (Node)             ← 设备身份
  ▲ WSS /ws/bridge            Bearer <deviceToken>（sec-websocket-protocol 承载）
  │
Cloud relay (48730 / nginx 443)
  ▲ WSS /ws/client?targetDeviceId=&clientId=  Bearer <accessToken>
  │
Client (web / Android)
```

## 2. relay 信封（canonical v1）

所有 bridge↔relay、client↔relay 消息都是 JSON 文本帧。

### 2.1 请求（client → relay → bridge）

```json
{
  "schemaVersion": 1,
  "kind": "request",
  "type": "sessions.list",
  "requestId": "req-abc123",          // 客户端生成，全链路唯一
  "sentAt": "2026-08-15T00:00:00Z",
  "actor": { "role": "client", "clientId": "web-x1" },
  "target": { "deviceId": "c0abed24-..." },
  "payload": {}
}
```

### 2.2 响应（bridge → relay → client）

```json
{
  "schemaVersion": 1,
  "kind": "response",
  "type": "sessions.list",
  "requestId": "req-abc123",          // 回显请求 id
  "sentAt": "...",
  "actor": { "role": "bridge", "deviceId": "..." },
  "payload": { "ok": true, "data": { ... } }
}
```

失败：`payload: { "ok": false, "error": { "code": "...", "message": "..." } }`

### 2.3 事件（bridge → relay → 本设备全部客户端）

```json
{
  "schemaVersion": 1,
  "kind": "event",
  "type": "events.forward",
  "sentAt": "...",
  "actor": { "role": "bridge", "deviceId": "..." },
  "target": { "deviceId": "..." },
  "payload": { "sessionId": "...", "frame": { ... } }
}
```

relay 对 `events.forward` 做设备级 fanout（广播给该设备所有在线客户端），
不按订阅路由。客户端按 `payload.frame` 自行过滤。

### 2.4 心跳

```json
{ "schemaVersion": 1, "kind": "heartbeat", "type": "heartbeat.ping",
  "sentAt": "...", "actor": { "role": "bridge" }, "payload": { "now": "..." } }
```

relay 自动应答 `heartbeat.pong`。bridge 侧 30s 一次，relay 45s 超时判离线。

### 2.5 认证

- `/ws/bridge`：`Authorization: Bearer <deviceToken>` 或
  `Sec-WebSocket-Protocol: bearer, <deviceToken>`（浏览器/Node 均可用后者）。
- `/ws/client`：同上，token 为用户 access token，且必须携带 query
  `targetDeviceId`（clientId 可省略，缺省自动生成）。
- relay 附加校验：设备未吊销、client 的 userId 拥有 targetDeviceId、
  响应 requestId 只回到原发起 client、事件只发给同用户客户端。
- 关闭码：`4001` 令牌无效/认证失败、`4002` 缺参、`4003` 设备已吊销/不存在
  ——`4003` 是 bridge 端"清 token 重新注册自愈"的触发信号。

### 2.6 设备 REST 面（Bearer access token）

| 方法 | 路径 | 语义 |
| :-- | :-- | :-- |
| GET | `/devices` | 账号下未吊销设备（已吊销不返回） |
| POST | `/devices/register` | 幂等注册：同 `(userId, platform, clientDeviceKey)` 复用同一行（label 变了则就地更新）；key 首次出现建新行 |
| GET | `/devices/:deviceId` | 单个设备（含已吊销） |
| POST | `/devices/:deviceId/revoke` | 软删除：置 `revoked_at`、吊销该设备全部 token、踢掉在线 bridge/客户端（4003） |

删除语义：revoke 后该设备从所有端消失；电脑端 bridge 重新注册（同 key）
自动以**新行**复活（`findByDedupKey` 只匹配未吊销行）。`clientDeviceKey`
是机器稳定标识（Windows MachineGuid），与显示名解耦——改名不产生新行。

### 2.7 配对码 REST 面（扫码登录/授权，S1+S2）

一个码位、两种方向，扫码方无需思考（二维码恒为落地页 URL，见 §2.8）：

| 方法 | 路径 | 鉴权 | 语义 |
| :-- | :-- | :-- | :-- |
| POST | `/pairing-codes` | 用户 | **方向一**出码（账号码）：6 位、300s、一次性、哈希存储 |
| POST | `/pairing-codes/verify` | 无（严限流 5/分） | **方向一**核销：凭码换码主账号会话（一次性） |
| POST | `/pairing-codes/device` | 无（宽限流） | **方向二**匿名出码：`{id, code, requestSecret, expiresAt}`；`requestSecret` 明文仅此一次，只存哈希 |
| POST | `/pairing-codes/:id/grant` | 用户 | **方向二**手机授权：码绑定账号（幂等；非授权码 409） |
| GET | `/pairing-codes/:id/status?secret=` | 领取凭证 | **方向二**插件轮询：`pending` → `granted`（一次性签发会话，取走即作废） |
| GET/POST | `/pairing-codes` 列表 / `:id/cancel` | 用户 | 管理面 |

限流约定：`verify` 是唯一爆破目标（6 位码）——严限 5/分；其余出码/授权/轮询面
宽限 300/分（插件轮询 2s/次 ≈30/分，且手机与电脑常同 NAT 共用一个 IP）。

### 2.8 扫码落地页与 deep link

插件卡片二维码恒编码为落地页 URL（一个码三环境分流）：

```
https://<relay>/dshmobile/?mode=pair|grant&code=<6位>&pid=<grant时>
  ├─ 微信扫 → 页面微信分支：仅显示下载 APK（微信禁自定义协议跳转）
  ├─ 系统相机/浏览器扫 → 页面自动跳 dshmobile://pair|grant?… 进 App；无 App 则停留下载
  └─ App 内扫 → 解析 URL 直接进 登录确认页 / 授权确认页（不进浏览器）
```

APK 托管：`/dshmobile/DSH-Mobile-<ver>.apk`（nginx 静态，与落地页同源）。

## 3. DSH /api（bridge 专用）

### 3.1 unary

`POST /api/<method>`：

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": { ... } }
```

响应：

```json
{ "type": "server-response", "rpcId": "<echo>",
  "result": { "ok": true, "value": { ... } } }
```

失败：`result: { "ok": false, "error": { "code": "...", "message": "..." } }`

### 3.2 下行流

`GET /api/events.mux`（会话事件）与 `GET /api/events.host`（宿主事件），
WebSocket 升级，帧格式：

```json
{ "type": "server-request", "rpcId": "<uuid>", "method": "<frame type>", "payload": { ... } }
```

- `method` 即帧类型（如 `session/event`、`approval/requested`）；
- 只下行：客户端在流上发送任何数据会被 1008 关闭；
- 断线重连 = 重开流 + 重取 history（mux 会重放订阅基线与未决审批/提问）。

### 3.3 应答（审批/提问）

`POST /api/respond`：

```json
{ "type": "client-response", "rpcId": "<server-request 的 rpcId 回显>",
  "result": { "ok": true, "value": { "sessionId": "...", "approvalId": "...", "outcome": "allowed-once" } } }
```

- 审批 outcome：`allowed-once` | `rejected`；
- 提问 value：`{ "sessionId": "...", "answer": <AskUserQuestionAnswer> }`。

## 4. relay 消息类型 ↔ DSH 映射（bridge 实现的完整面）

| relay type | DSH 调用 | 权限 | 说明 |
|---|---|---|---|
| `sessions.list` | `session.list {}` | 只读 | 返回全部会话（含子代理，客户端按 parentSessionId 建树） |
| `sessions.history` | `session.history {sessionId, maxMessages}` | 只读 | 默认 10 条消息，上限 100；bridge 做 wire 投影 |
| `session.models` | `session.models {sessionId}` | 只读 | 模型目录：current/groups/failures |
| `commands.list` | `commands/list {args:{agentId}}` | 只读 | 会话可用斜杠命令 |
| `sessions.create` | `session.create {cwd?}` | 写 | 新会话 |
| `sessions.run` | `session.prompt {sessionId, mode:"queue", content}` | 写（任意会话） | content = `[{type:"text", text}]` 或 image 块 |
| `sessions.steer` | `session.prompt {sessionId, mode:"steer", content}` | 写（任意会话） | 运行中插入引导消息 |
| `sessions.interrupt` | `session.cancel {sessionId, reason}` | 写（任意会话） | |
| `session.selectModel` | `session.selectModel {sessionId, provider, model, reasoningEffort?}` | 写（任意会话） | 切换模型/思考强度 |
| `commands.execute` | `commands/execute {args:{agentId, line}}` | 写（任意会话） | 斜杠命令，line 必须以 / 开头 |
| `approvals.respond` | `POST /api/respond` | 写 | 必须带 server-request 的 rpcId |
| `questions.respond` | `POST /api/respond` | 写 | 同上 |
| `events.subscribe` | 桥接 mux 流 | 只读 | 返回 subscriptionId（MVP 为 sessionId） |
| `events.unsubscribe` | — | 只读 | 停止转发该会话事件 |
| 其他任意类型 | — | — | `UNSUPPORTED` |

## 5. history wire 投影（bandwidth 防线）

服务器公网带宽约 1 Mbps（实测 4.3MB 传输 37s）。bridge 转发 history 前做投影：

1. 丢弃 `assistant/chunk`（token 级流式碎片，占比 ~99%）、`step/start`、`step/end`；
2. `tool/result` 文本内容截断到 500 字符；
3. `maxMessages` 默认 10、上限 100。

实测：19,499 事件 / 4.38MB → 33 事件 / 153KB（压缩 96.5%），传输 <1s。

## 6. sessionId 不变式

- sessionId 全链路**不透明字符串透传**：DSH 输出 → bridge → relay → client → 回传，任何环节不解析/规范化/截断；
- 客户端只能使用 `session.list` / `session.create` 返回的 id；
- relay 对 payload 零改写（仅路由），不新增 id 语义。

## 7. Data Plane（文件传输）

### 7.1 原则

- **控制面/数据面分离**：WS JSON 信封（§2）只承载传输控制消息（投递指令/进度/完成回执）；
  文件字节流走 HTTPS REST，不塞进 WebSocket，大文件不阻塞聊天与实时事件。
- **内容寻址**：`fileId = SHA-256(文件内容)`（hex）。同（用户, 设备, fileId）的传输天然幂等去重，
  断点续传靠 relay 返回已收字节数 + 服务端 offset 强校验。
- **relay 不长期存文件**：spool 仅作过渡（uploading → ready → delivered 即删；TTL 兜底清理）。

### 7.2 生命周期

```
手机                 relay                     bridge                电脑
 │ POST /transfers      │                         │                    │
 │  (announce, 校验归属)│                         │                    │
 │ PUT …/chunks × N ────▶ spool 追加(offset 校验)   │                    │
 │ POST …/complete ────▶ size+SHA-256 校验 → ready  │                    │
 │                      │ ── WS 请求 transfer.deliver ──▶ 拉流下载          │
 │                      │ ◀── WS 响应 {ok, path} ──────────┤ 校验+落盘(workspace 内)
 │  ◀─ WS 事件 transfer.progress（fanout 节流）────────────┘                    │
 │                      │ spool 删除（delivered）    │                    │
```

### 7.3 REST 端点（数据面）

| 方法 | 路径 | 鉴权 | 语义 |
| :-- | :-- | :-- | :-- |
| POST | `/transfers` | 用户 accessToken | announce：`{deviceId, fileId, name, size, sha256, targetPath}` → `{transferId, received, status}`；同 (用户,设备,fileId) 有活动传输时幂等返回原 transferId（续传） |
| PUT | `/transfers/:transferId/chunks` | 用户 | 分块追加：header `X-Chunk-Offset: <bytes>` + 原始字节 body；offset 必须等于当前已收字节数，否则 `409 chunk-offset-mismatch`；返回 `{received}` |
| GET | `/transfers/:transferId` | 用户 | 状态：`{fileId, name, size, received, status}`（`uploading`/`ready`/`delivered`/`failed`） |
| POST | `/transfers/:transferId/complete` | 用户 | 收尾：校验 size 与 sha256 → `ready` 并通知 bridge 投递；失败 `422 checksum-mismatch` |
| GET | `/transfers/:transferId/download` | 设备 deviceToken | bridge 拉取 spool 内容（仅 `ready` 状态、且 deviceToken 的设备与传输一致） |

归属校验：announce/上传/状态/complete 要求 userId 拥有 deviceId（`findByIdAndUser`）；
download 要求 deviceToken 解出的 deviceId 与传输一致。限流：数据面复用流程面额度（300/分）。

### 7.4 控制面消息

- relay → bridge（投递指令，复用请求/响应通道，actor.role="relay"，requestId 由 relay 生成并
  以 `${deviceId}:${requestId}` 复合键跟踪，10 分钟超时）：
  ```json
  { "schemaVersion": 1, "kind": "request", "type": "transfer.deliver", "requestId": "r-…",
    "actor": { "role": "relay" }, "target": { "deviceId": "…" },
    "payload": { "transferId": "…", "fileId": "…", "name": "…", "size": 123, "sha256": "…",
                 "targetPath": "docs/test.pdf" } }
  ```
- bridge → relay 响应：`payload: { "ok": true, "data": { "path": "/abs/落盘路径" } }`
  或 `{ "ok": false, "error": { "code": "deliver-failed", "message": "…" } }`。
- bridge → relay 事件（进度，fanout 给该设备全部客户端）：
  `{ "kind": "event", "type": "transfer.progress", "payload": { "transferId": "…", "fileId": "…", "received": 123, "total": 456 } }`

### 7.5 边界与安全

- `targetPath` 是**相对路径**；bridge 在 `workspaceRoot` 内解析：拒绝绝对路径、`..` 穿越、
  解析后逃逸出 root（路径规范化后必须以 root 开头）。默认 root = `<stateDir>/deliveries`。
- 大小上限 2GB（可配）、分块 body 上限 8MB（可配）、传输 TTL 24h（可配）；
  `delivered` 后 spool 在 1h 宽限内删除，兜底 sweep 每 5 分钟跑一次。
- relay 只存文件字节（spool），不落数据库；审计日志记录 transferId 元数据。
- 控制面消息体不含文件内容；progress 事件节流（bridge 侧每 1s 最多一条）。
