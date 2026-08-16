# 文档索引

`dsh-remote` 开发文档。按阅读顺序：

| 文档 | 内容 |
|---|---|
| [01-architecture.md](01-architecture.md) | 总体架构、组件职责、数据流、会话树、带宽防线 |
| [02-protocol.md](02-protocol.md) | 线格式契约：relay canonical envelope、DSH /api、消息类型映射表、wire 投影 |
| [03-security.md](03-security.md) | 身份与归属模型、威胁模型、写权限模型、opaque id、能力面收窄、事件过滤 |
| [04-operations.md](04-operations.md) | 部署与运维：服务器组件、bridge 启停、web UI 部署、账号、故障排查 |
| [05-verification.md](05-verification.md) | 验证记录：探针、端到端测试、已修复问题清单 |
| [06-mobile-requirements.md](06-mobile-requirements.md) | 手机端需求：产品定位、功能映射、内容模型、待确认决策 |
| [07-plugin-remote-design.md](07-plugin-remote-design.md) | 下一步形态：DSH 插件化（桥守护+设置卡）与扫码双登录设计（设计稿） |

## 快速开始

```powershell
# 启动 bridge（先确认 DSH web 在 127.0.0.1:3080）
node bridge/src/main.js

# 端到端验证（登录→列会话→锁验证→建会话→注入 prompt→收流式回复）
node test/client.mjs

# 部署 web 调试 UI 到服务器
python scripts/deploy-web.py
```

调试台地址：https://www.deepseek-claudex.cn/dsh-debug/
