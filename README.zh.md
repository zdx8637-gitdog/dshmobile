# dshmobile — DeepSeek Harness 手机远程客户端

[English version](./README.md)

<p align="center"><img src="docs/images/banner.png" width="760" alt="dshmobile banner"/></p>

**开箱即用**：装一次插件 → 扫码 → 手机接着干。为 DSH 建立一个真正的 Remote Client——
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

**先选方式**：DSH **桌面版 0.2.0 及以上** → 用 §A（GUI，推荐）；旧版 `dsh web`（**0.1.7**）→ 用 §B（CLI）。
两种方式装的是同一个包：`@zdx8637/dshmobile-bridge`（当前插件版本 **1.0.3**）。

### A. 电脑端 —— DSH 0.2.0 桌面版：GUI 安装（推荐）

1. 打开 DSH 桌面版 → 插件管理器 → 点 **「添加插件」**；
2. 在输入框里粘贴**带精确版本号**的包名（输入框提示原文是「输入插件的包名、GitHub 仓库地址或
   本地目录路径。」，GitHub 仓库地址与本地目录路径它同样接受）：

   ```
   @zdx8637/dshmobile-bridge@1.0.3
   ```

3. 右侧 **「安装源」** 按网络情况选 `npm 官方源` 或 `中国大陆镜像源`；
4. 点安装；
5. **重启 DSH**（宿主需要重新加载插件才会生效）；
6. 打开面板：Web 左侧栏底部出现 ▶ 箭头，点开即配置面板
   （① 登录 / 授权码，② 加密配对码）。

> ⚠️ **务必带上精确版本号**（如 `@zdx8637/dshmobile-bridge@1.0.3`）。
> profile 目录里有 `pnpm-lock.yaml`，只写包名重装时锁文件可能把版本钉回旧的
> （实测：线上已经发到 1.0.2，重装后却仍然是 1.0.0）。

> ⚠️ **没有自动更新。** 弹窗原文：「插件安装后，暂不支持自动更新。若需升级，请先卸载再安装新版」。
> 升级 = 先在插件管理器里**卸载**，再按上面的步骤装上带新版本号的包名。

### B. 电脑端 —— DSH 0.1.7（旧版：`dsh web` + CLI）：CLI 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637/dshmobile-bridge@latest
# 重启 dsh 后，Web 左侧栏底部出现 ▶ 箭头，点开即配置面板
```

> 前置 `pnpm`（`dsh plugin` 子命令依赖它；`corepack enable` 或 `npm i -g pnpm`）。
> 仅限旧版：`@deepseek-ai/dsh` 的 npm `latest` 指向 0.1.7 的 CLI，所以这条命令拿到的是
> 0.1.7 的 `dsh plugin`。**0.2.0 及以上请改用上面的 §A（GUI）**，CLI 不是 0.2.0 的安装路径。

### 手机端（Android App）

扫描电脑面板二维码 → 落地页下载签名 APK（当前版本 **v1.0.0**）。装好后在 App 内扫码：
先扫①登录，再扫②加密配对，配对成功后设备列表出现**盾牌记号**即 E2EE 已生效
（非加密显示为「盾牌 + 斜杠」；两者都是灰色，差别在形状不在颜色）。

## DSH 版本要求

插件**只支持 v2 协议，即 DSH v0.1.5 及以上**。旧版 DSH 的 legacy 协议已于 `0.1.0-beta.23` **整体删除**。

| DSH 版本 | 插件行为 |
| :-- | :-- |
| **v0.1.5 及更新** | 完整支持：`/api` 会话鉴权（launch token → 会话 Cookie）、Typert 端点（`session/*` 等）、`/api/remote.mux` 流复用、`$events` 审批/提问瀑布 |
| **v0.1.0-rc.6 及更早** | **不支持** —— 请先升级 DSH，再安装本插件 |

> 这是**有意的收窄**：双协议分支长期是缺陷高发区，每条改动都要在两条链路上各验一遍。
> 若你仍在使用 v2 之前的 DSH，请停留在 `0.1.0-beta.22`，或先升级 DSH。

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
