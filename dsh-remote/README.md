# dsh-remote

DeepSeek Harness 远程控制链路：本地 DSH 实例 → DSH bridge → 云端 relay → Web/Android 客户端。

## 链路

```
DSH (127.0.0.1:3080)          本机 Web GUI 保持原样
   ▲ /api/* (POST) + /api/events.mux + /api/events.host (WS, 只读)
   │
DSH bridge (本机 Node 进程)    设备身份认证，双向适配，写保护，wire 投影
   ▲ wss://www.deepseek-claudex.cn/ws/bridge   Bearer <deviceToken>
   │
云端 relay (<relay-host>)     只做认证与路由
   ▲ wss://www.deepseek-claudex.cn/ws/client?targetDeviceId=...  Bearer <accessToken>
   │
web 调试 UI / Android 客户端
```

## 文档

完整文档在 [`docs/`](docs/index.md)：架构、协议契约、安全模型、运维手册、验证记录。

## 目录

- `bridge/` — DSH bridge（零依赖 Node 24）
- `web/` — 单文件调试 UI（部署到服务器 nginx 静态目录）
- `test/` — 端到端测试与诊断脚本
- `scripts/` — 部署脚本

## 快速开始

```powershell
node bridge/src/main.js          # 启动 bridge（自动登录/注册设备/连接 relay + DSH）
node test/client.mjs             # 端到端测试（登录→设备→列会话→锁→建会话→注入 prompt→流式）
python scripts/deploy-web.py     # 部署调试台 UI 到服务器
```

调试台：https://www.deepseek-claudex.cn/dsh-debug/

## 写权限模型

进入会话即可对话，与桌面 GUI 一致。安全基础：DSH queue 语义（运行中发消息排队不打断）、
opaque sessionId 不变式、relay 设备归属校验、能力面收窄（插件/凭据写面不存在）。
详见 [docs/03-security.md](docs/03-security.md)。
