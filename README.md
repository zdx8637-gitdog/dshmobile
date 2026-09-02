# dshmobile — DeepSeek Harness 手机远程客户端

<p align="center"><img src="docs/images/banner.png" width="760" alt="dshmobile banner"/></p>

**开箱即用**：一条命令装插件 → 扫码 → 手机接着干。为 DSH 建立一个真正的 Remote Client——
不需要懂 Tailscale、隧道、端口、NAT 或任何网络概念，不修改 DSH，跨平台。

在手机上远程控制本机 DeepSeek Harness（DSH）：扫码配对 → 设备 → 会话树 → 对话、审批、
提问应答、模型切换、文件浏览。

## 架构

```
┌──────────────┐   WSS    ┌───────────────────┐   WSS    ┌───────────────────────────┐
│ Android App  │ ───────▶ │  Cloud Relay       │ ◀─────── │ PC Bridge（DSH 插件）       │
│ （签名 APK）  │          │ （托管服务，闭源）   │          │ （开源，连本地 DSH）         │
└──────────────┘          └───────────────────┘          └────────────┬──────────────┘
                                                                       │ 127.0.0.1:3080
                                                             ┌─────────▼──────────┐
                                                             │ DeepSeek Harness   │
                                                             └────────────────────┘
```

业务内容（prompt / 回复 / 会话 / 文件）经 **E2EE 端到端加密**：relay 只能看到路由元数据，
**读不到、也改不了**你的会话内容。

## 开源边界（当前策略）

把「信任边界」开放、把「产品护城河」保留：

| 组件 | 状态 | 位置 |
| :-- | :-- | :-- |
| **PC Bridge / 插件** | ✅ 开源（MIT） | `plugins/`，npm 包 `@zdx8637/dshmobile-bridge` |
| **协议契约** | ✅ 开源 | `docs/02-protocol.md`（wire format 单一事实来源） |
| **E2EE 设计** | ✅ 开源、可审计 | `docs/plan-e2ee.md`（威胁模型 + 密码学参数 + 握手 + pinning） |
| **Android App** | 🔒 闭源 | 以签名 APK 分发（扫码下载） |
| **Cloud Relay** | 🔒 闭源（托管服务） | 认证 / 路由 / 审计 / 运维 |

**为什么这样划分**：E2EE 是「为什么可以信我」的答案——协议与密码学全部公开可审计；relay
即使被攻破也读不到你的内容。而 relay 服务与 App 体验是产品差异化所在，现阶段不全量开源，
避免被一键 clone 换皮。

## 安装

### 电脑端（PC Bridge）

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637/dshmobile-bridge@latest
```

> 前置 `pnpm`。重启 DSH 后，Web 左侧栏底部出现 ▶ 面板：① 登录 / 授权码，② 加密配对码。

### 手机端（Android App）

扫描电脑面板二维码 → 落地页下载签名 APK。装好后在 App 内扫码：先扫①登录，再扫②加密配对，
配对成功后设备列表出现钥匙图标（即 E2EE 已生效）。

## 目录

| 目录 | 内容 |
| :-- | :-- |
| `plugins/` | PC Bridge 插件（host + bridge 守护 + Web 面板），开源 |
| `docs/02-protocol.md` | relay 信封、消息类型、设备语义（线格式契约） |
| `docs/plan-e2ee.md` | E2EE v1 设计（威胁模型、密码学、握手、pinning） |

## 信任与自托管（路线图）

- 现阶段 relay 为作者自营托管服务；内容隐私由 E2EE 保证，relay 只做路由与元数据转发。
- 后续将发布 **reference self-hosted relay**（参考实现，≠ 线上生产版），让用户可自建：
  `Android → 自建 relay → Bridge → DSH`。官方 relay 的 abuse control / monitoring / 扩缩容 /
  账号系统 / 部署运维等运营设施不开源。

## 隐私与密钥

本仓库不含任何真实凭据。Android 签名密钥、relay 账号密码、服务器 SSH 凭据等只存在于
本地 / 私有渠道，一律以环境变量注入、文档中用占位符。
