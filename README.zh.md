# dshmobile — DeepSeek Harness 手机远程客户端

[English version](./README.md)

<p align="center"><img src="docs/images/banner.png" width="760" alt="dshmobile banner"/></p>

**开箱即用**：一条命令装插件 → 扫码 → 手机接着干。为 DSH 建立一个真正的 Remote Client——
不需要懂 Tailscale、隧道、端口、NAT 或任何网络概念，不修改 DSH，跨平台。

在手机上远程控制本机 DeepSeek Harness（DSH）：扫码配对 → 设备 → 会话树 → 对话、审批、
提问应答、模型切换、文件浏览。

## 架构

```
┌──────────────┐   WSS    ┌───────────────────┐   WSS    ┌───────────────────────────┐
│ Android App  │ ───────▶ │  Cloud Relay       │ ◀─────── │ PC Bridge（DSH 插件）       │
│ （签名 APK）  │          │ （托管服务）         │          │ （开源）                    │
└──────────────┘          └───────────────────┘          └────────────┬──────────────┘
                                                                       │ 127.0.0.1:3080
                                                             ┌─────────▼──────────┐
                                                             │ DeepSeek Harness   │
                                                             └────────────────────┘
```

业务内容（prompt / 回复 / 会话 / 文件）经 **E2EE 端到端加密**：relay 只能看到路由元数据，
**读不到、也改不了**你的会话内容。连接层带自愈：DSH 重启、网络抖动后自动重握手恢复，
无需手动操作。

## 开源与安全

| 组件 | 状态 | 说明 |
| :-- | :-- | :-- |
| **PC Bridge / 插件** | Open Source（MIT） | `plugins/`，npm 包 `@zdx8637/dshmobile-bridge` |
| **协议契约** | Open | `docs/02-protocol.md`（wire format 单一事实来源） |
| **E2EE 设计** | Open and auditable | `docs/plan-e2ee.md`（威胁模型 + 密码学参数 + 握手） |
| **Android App** | 签名 APK 分发 | 扫码下载 |
| **Cloud Relay** | 托管服务 | 认证 / 路由 / 审计 |

协议与加密实现完全公开、可独立审计；业务内容经 E2EE 端到端加密，relay 只负责路由与元数据
转发，无法读取你的会话内容。

## 安装

### 电脑端（PC Bridge）

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637/dshmobile-bridge@latest
```

> 前置 `pnpm`。重启 DSH 后，Web 左侧栏底部出现 ▶ 面板：① 登录 / 授权码，② 加密配对码。
> 当前插件版本 **0.1.0-beta.20**。

### 手机端（Android App）

扫描电脑面板二维码 → 落地页下载签名 APK（当前版本 **v0.2.12**）。装好后在 App 内扫码：
先扫①登录，再扫②加密配对，配对成功后设备列表出现钥匙图标（即 E2EE 已生效）。

## DSH 版本兼容（双协议自适应）

插件 0.1.0-beta.18 起**自动探测 DSH 代际**，升级顺序无关：

| DSH 版本 | 插件行为 |
| :-- | :-- |
| **v0.1.5 及更新** | 新协议全适配：`/api` 会话鉴权（launch token → 会话 Cookie）、Typert 端点（`session/*` 等）、`/api/remote.mux` 流复用、`$events` 审批/提问瀑布 |
| **v0.1.0-rc.6 及更早** | 自动回退 legacy 协议（点号端点、`events.mux`/`events.host`、`respond` 应答），无鉴权直连，行为与 beta.16 一致 |

因此**先升插件、后升 DSH，或反着升，或老版本不升**，均全程可用。

## 目录

| 目录 | 内容 |
| :-- | :-- |
| `plugins/` | PC Bridge 插件（host + bridge 守护 + Web 面板），开源 |
| `docs/02-protocol.md` | relay 信封、消息类型、设备语义（线格式契约） |
| `docs/plan-e2ee.md` | E2EE v1 设计（威胁模型、密码学、握手、pinning） |
| `docs/e2ee-identity-issues.md` | E2EE 身份/配对问题调研（撕裂读再生、重启自愈等） |
| `docs/bridge-singleton.md` | 桥单实例保护：多实例/孤儿桥互相顶替的原理、四层防护与诊断入口 |

## 信任与自托管（路线图）

- 现阶段 relay 为作者自营托管服务；内容隐私由 E2EE 保证，relay 只做路由与元数据转发。
- 后续将发布 **reference self-hosted relay**（参考实现，≠ 线上生产版），让用户可自建：
  `Android → 自建 relay → Bridge → DSH`。账号系统、监控、扩缩容等运营能力由托管方维护。

## 隐私与密钥

本仓库不含任何真实凭据。Android 签名密钥、relay 账号密码、服务器 SSH 凭据等只存在于
本地 / 私有渠道，一律以环境变量注入、文档中用占位符。
