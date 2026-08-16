# 架构设计

> 线格式细节见 [02-protocol.md](02-protocol.md)，安全模型见 [03-security.md](03-security.md)。

## 参与者

| 组件 | 位置 | 职责 |
|---|---|---|
| DSH host | 本机 127.0.0.1:3080 | 运行中的 Harness，无认证层，信任栅栏只放行回环 |
| DSH bridge | 本机 Node 进程 | 以"设备"身份连接 relay；将 DSH API 翻译为 relay 信封；wire 投影 |
| Cloud relay | <relay-host>:48730 | 用户/设备/配对/审计；仅路由，不执行 agent 逻辑 |
| Client | 浏览器 / Android | 登录 relay，选择设备，收发会话消息 |

## 数据流

```
请求：  client --request--> relay --路由--> bridge --DSH /api--> DSH
响应：  client <--response-- relay <--requestId 归属-- bridge
事件：  bridge --mux/host 订阅--> relay --events.forward 设备级 fanout--> 全部在线 client
```

要点：

- relay 对客户端请求按 `requestId` 归属路由，响应只回原发起者；
- 事件不做订阅路由（relay 语义），bridge 侧只转发"已订阅 + 近期交互过"
  会话的 mux 帧，桌面私有会话事件不上公网；
- bridge 重启会丢失订阅状态，客户端靠"重开 WS + 重取 history"重基线。

## 带宽防线（wire 投影）

服务器实测 ~1 Mbps。bridge 转发 history 前剥离 token 级流式碎片并截断
工具输出（见 [02-protocol.md §5](02-protocol.md)）：4.3MB → 153KB（96.5%），
<1s 送达。Android 端需沿用同样的投影语义，不得引入全量拉取。

## 会话树

DSH `session.list` 返回全部会话（主会话 + 子代理，`parentSessionId` 指父，
`origin:"subagent"` 标记）。客户端按 parent 建树渲染，子代理默认折叠。

## 断线重连

- bridge ↔ relay：指数退避重连（设备令牌持久化复用）；
- bridge ↔ DSH mux/host 流：断裂后重建并重放（DSH 侧本身按 generation 重放订阅基线）；
- 客户端断开不丢事件：relay 为 pending request 保留 60s，事件 fanout 只影响在线客户端（MVP 暂不做离线补发，DSH 的 history API 是重连基线）。
