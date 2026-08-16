# 安全模型

## 0. 身份与归属模型（架构基石）

DSH 没有统一的用户身份概念（本地 /api 无认证层），因此**"谁能操作哪台电脑"
的归属问题全部由 bridge + relay 这一层解决**：

```
bridge 启动 ──账号登录──> relay /auth/login（用户名密码 == 服务器账号）
    └─> /devices/register（Bearer accessToken）──> 拿到 deviceId + deviceToken
        └─> WSS /ws/bridge（Bearer deviceToken 认证）

手机 ──同账号登录──> relay /ws/client（Bearer accessToken）
    └─> relay 校验：client.userId 必须 == 目标 device.user_id，否则 FORBIDDEN
```

不变量：

1. **bridge 必须先登录服务器账号才能转发**：账号凭证写在本机
   `bridge/config.json`，登录失败/凭证错误时 bridge 拒绝工作；
2. **设备归属于账号**：`clientDeviceKey`（每台电脑固定）幂等注册，
   同一账号下多台电脑各是一个 device（`dsh-bridge-windows-p-01`、`-02`…）；
3. **手机只能路由到同账号设备**：relay 层已强制（设备归属校验），
   跨账号访问返回 FORBIDDEN；
4. **DSH 侧无身份**：bridge 是 DSH 的唯一出口（127.0.0.1），
   DSH 会话操作完全以 bridge 的转发为界——这正是"归属只能让 bridge 去做"的落点。

多电脑部署形态：每台电脑装一份 bridge，各自 `clientDeviceKey` 不同、
共用或分用账号（共用 = 一个手机看全部设备；分用 = 按账号隔离）。

## 威胁模型

| 威胁 | 场景 | 对策 |
|---|---|---|
| 远程误操作打断桌面正在进行的对话 | 手机点错中断按钮 | UI 层确认 + DSH queue 语义（发消息只排队）；cancel 是显式动作 |
| UI/中继改写 sessionId 导致操作落到错误会话 | 任何环节解析或规范化 id | opaque id 不变式（§2） |
| 远程拿到 settings/credentials 写权限 | 桥接面过大 | 能力面收窄（§3） |
| 公网扫描/爆破 relay | relay 暴露 443 | relay 既有防线（§4） |
| 大会话打满服务器带宽 | history 全量转发 | wire 投影（协议 §5） |
| 事件泄露桌面私有会话内容 | mux 全量 fanout | bridge 转发过滤（§5） |

## 1. 写权限模型（2026-08-15 修订）

**进入会话即可对话，与桌面 GUI 一致，无按会话写锁。**

- 手机端对任意会话可发消息/中断，语义与桌面 GUI 完全一致；
- 安全基础：
  1. DSH `session.prompt` 的 queue 语义：对运行中的会话发消息是排队（FIFO），
     不打断当前轮次，不会"搞死"进行中的对话；只有显式 `session.cancel` 才中断；
  2. opaque id 不变式（§2）杜绝"操作落到错误会话"；
  3. relay 设备归属校验：手机只能路由到自己账号的设备；
  4. 能力面收窄（§3）：危险面（插件管理、settings/credentials 写）在 bridge 层不存在。
- 早期"remoteOwned 写锁"设计作废（过度设计）：参考项目与 DSH 均无此行为。
  注意：bridge 实现（`src/locks.js`）仍含旧锁逻辑，需随 P0 移除。

## 2. opaque sessionId

- sessionId 从 DSH 输出到客户端渲染、再回传，全程不透明字符串；
- bridge 不解析/规范化/截断/大小写转换；
- relay 只透传 payload 与 target，零改写；
- 客户端只使用服务端返回的 id（list/create），不自行生成/拼接。

## 3. 能力面收窄

bridge 只实现 §协议-4 表内消息。未实现的能力在 bridge 层即不存在：

- `settings.*`、`credentials.*`、`workspace.*` 写操作：无映射，不可达；
- `session.fork` / `session.rename` / `session.updateQueue`：MVP 未暴露；
- `session.prompt` 的 `mode` 固定为 `queue`（steer 未暴露）。

## 4. relay 既有防线（继承自 session_control）

- 设备令牌 JWT（绑定 userId+deviceId，可吊销，不进日志/query string）；
- 用户 access token + refresh token 轮换；
- 设备归属校验：client 只能路由到自己 userId 的设备；
- 危险消息黑名单（`sessions.profile.replace`、`provider.profile.*`）；
- 登录/配对限流、审计日志、日志脱敏；
- nginx TLS + HSTS + 安全头。

## 5. 事件转发过滤（防泄露）

DSH mux 流是全量聚合流（所有会话事件都来）。bridge 只转发：

- 客户端显式订阅的会话（`events.subscribe`）；
- 客户端近期打开过的会话。

其余会话（含桌面正在进行的对话）的事件不上 relay。host 帧只转发
`host/session-added|removed|status`（元数据，无内容）。

## 6. 已知风险与后续项

| 风险 | 状态 |
|---|---|
| 远程会话的 agent 权限 = 桌面用户权限（DSH 沙箱策略） | 接受；远程会话本就需要执行能力 |
| access token 在浏览器 localStorage | 调试期接受；Android 用 Keystore/EncryptedSharedPreferences |
| relay `/auth/register` 公开 | 调试期接受；上线前关注册或加邀请码 |
| 审批/提问 rpcId 全链路可见 | 无额外泄露（rpcId 仅用于应答路由） |
| relay 事件不做离线补发 | 客户端断线重连后靠 history 重基线 |
