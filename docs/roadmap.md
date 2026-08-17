# dshmobile 路线图：DeepSeek Harness 的 Paseo

> 定位一句话：**其他 Remote 项目解决 Remote Access（把 DSH Web 暴露出来），
> dshmobile 解决 Remote Client（拿着手机，最快继续电脑上的 DSH 工作）。**
>
> 架构灵感来自 [Paseo](https://github.com/getpaseo/paseo)（开源界「手机操控 coding agent」
> 品类先行者）：Android App ↔ 云端 relay ↔ PC bridge。我们是 DSH 生态里的那个 Paseo。

## 设计原则

**把复杂度从用户侧转移到产品与基础设施侧。** 用户不需要知道 Relay、WebSocket、
公网 IP、NAT、端口、Tunnel 是什么——它们都属于内部实现。

> 产品悖论：会配置 Tailscale/Cloudflare 的人本可以自己实现远程访问；
> 不会配置的人看到这些名词就放弃了。我们服务的是后者。

## 现状（已达成）

| 能力 | 状态 |
| :-- | :-- |
| 一条命令安装的 DSH bundle 插件（npm：`@zdx8637/dshmobile-bridge`） | ✅ beta.6，免补丁、跨平台、DSH 升级免疫 |
| 常驻二维码：一码三用（微信扫=下载 App / 相机扫=跳配对 / App 内扫=登录或授权） | ✅ |
| 双向登录：桌面已登录 → 手机扫码登录同账号；桌面未登录 → 手机反向授权（RFC 8628 风格） | ✅ |
| 原生 Android App（会话树/对话/审批/提问应答/模型切换/文件浏览/队列管理） | ✅ |
| 服务端设备吊销 + 同机自愈重注册（stable clientDeviceKey） | ✅ |
| bridge 子进程守护（账号密码模式 / 手机授权 token 模式，401 自动刷新） | ✅ |
| 手机端 REST token 自动续期（冷启动不再 token expired） | ✅ |
| 消息与工具卡长按复制 | ✅ |
| 状态目录与包目录解耦（`~/.dsh-mobile`，升级不丢登录态） | ✅ |
| GitHub 仓库（封面/截图/简介/topics）+ npm 发布 + awesome-dsh-plugin 收录 | ✅ PR 已开 |

## 路线图（按优先级）

1. **协议层：Data Plane 设计先行** —— 控制面（session/message/tool/permission/status）
   与数据面（file/image/attachment/artifact）分离：WebSocket 只传申请/进度/完成通知，
   文件数据走 HTTP/二进制流 + 分块 + 断点续传 + 幂等去重。大文件不阻塞聊天。
2. **文件/图片上传** —— Android 分享 Intent 入口（微信 PDF → Office-PC → 当前项目；
   拍照 → Microscope-PC）。Attachment 作为独立能力设计，不绑定某个模型；
   未来视觉模型可用时直接复用（本项目的起点正是「文本模型看图」研究）。
3. **安全硬化（近程，便宜且高信任）** —— 全端登出（一键踢下线）、陌生设备登录提示、
   连接列表可见；Workspace 为边界的文件访问（拒绝 `../../` 路径穿越）。
4. **断线恢复打磨** —— 自动重连、会话状态恢复、事件续传、请求去重；
   用户只看到「Office-PC 正在重连… → 已连接」。
5. **E2EE（长期）** —— 控制面起步：relay 只知道「谁连谁、多大、何时」，
   不知道内容。目标安全模型：**服务器负责连接，但不需被信任。**
   完成后自建 relay 的心理门槛大幅下降，与 relay 文档互相成就。
6. **Push（前台服务保活起步）** —— 无 GMS 机型用「前台服务 + 常驻通知」的 80 分方案，
   后续再评估厂商通道（华为/小米/OPPO）。
7. **Relay 可运营性** —— 容量监控、多实例、优雅降级；自建 relay 文档按
   「普通团队照做能跑」标准维护（见 `dsh-remote/docs/04-operations.md`）。

## 最终形态

```
打开 App → 看到电脑 → 看到 Session → 继续工作
```

底层可以越来越复杂，复杂度对用户不可见。安装侧永远保持：

```
安装插件 → 登录/配对 → 完成
```

（高级选项如自建 relay、调试、协议设置存在，但不进入默认流程。）
