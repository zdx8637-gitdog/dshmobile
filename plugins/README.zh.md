# @zdx8637/dshmobile-bridge

[English version](./README.md)

**开箱即用的手机远程桥接**：一条命令安装，无需任何网络配置、无需本地补丁，
重启 dsh 后左侧栏即出现常驻二维码面板（跨平台，DSH 升级免疫）。

- **常驻二维码**（Web 左侧栏底部箭头弹窗）：与登录态无关，永远可扫——
  · 电脑已登录 → 手机（哪怕未登录）扫码直接登录同账号；
  · 电脑未登录 → 手机（已登录）扫码授权，电脑自动登录；
- **bridge 子进程守护**：账号密码模式或手机授权 token 模式（无密码直连，401 自动刷新）；
- 手机端一码三用：微信扫=下载 App、相机扫=跳 App 配对、App 内扫=直接登录/授权。

<p align="center"><img src="https://raw.githubusercontent.com/zdx8637-gitdog/dshmobile/main/docs/images/plugin-panel.jpg" width="480" alt="DSH 插件面板（左侧栏常驻二维码）"/></p>

## 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637/dshmobile-bridge@latest
# 重启 dsh 后，Web 左侧栏底部出现 ▶ 箭头，点开即配置面板
```

前置：本机需要 `pnpm`（`dsh plugin` 子命令依赖它；`corepack enable` 或
`npm i -g pnpm`）。

手机 App：扫描面板二维码 → 落地页下载 APK（或从
[发布页](https://github.com/zdx8637-gitdog/dshmobile/releases)获取）。

## 免补丁：面板走本地通道

DSH 0.1.0-rc.6 默认不向浏览器暴露第三方 settings 命名空间（上游标注为
deferred work）。本插件**不依赖该通道**：面板与宿主通过 `127.0.0.1:17653`
的本地 HTTP 通信（轮询状态 + 下发动作，CORS 仅放行本机来源），因此

- 一条命令安装即用，**无需任何本地补丁**；
- Windows/macOS/Linux 通用；
- DSH 升级不受影响（历史版本 0.1.0-beta.3 及更早需要 `scripts/expose-settings-namespace.ps1` 补丁，已废弃）。

## DSH 新版（v0.1.5+）适配与双协议兼容

v0.1.5 起 DSH 给本地 Web 服务加了浏览器会话鉴权（`dsh web` 打印的 URL 里带
进程级 launch token → 浏览器换会话 Cookie，`/api` 全部请求校验），并把 RPC
协议升级为 Typert 端点（`session/list`、`{args}` 载荷、`/api/remote.mux`
流复用、`$events` 审批/提问瀑布）。插件 0.1.0-beta.17 起自动适配：

- host 半边经 `ctx.connection.authenticatedUrl()` 取 launch token 交给桥子进程；
- 桥一次性换 Cookie（HMAC 签名、30 天有效），缓存于状态目录、401 自动重铸，
  所有 `/api` 请求与 WS 升级携带 Cookie；
- 会话/工作区/命令端点映射到新协议，事件流走 `/api/remote.mux` 的
  `session/follow` + `workspace/follow` + `session/control`，审批/提问走
  `$events` + `$events/result`。

**双协议自适应（0.1.0-beta.18 起）**：桥启动时自动探测 DSH 代际——新版走上述
v2 协议；旧版 DSH 自动回退 legacy 协议（点号端点、裸 payload、`events.mux`/
`events.host` 双流、`/api/respond` 应答、无鉴权直连，与 beta.16 行为一致）。
因此**升级顺序无关**：先升插件、后升 DSH，或反之，均全程可用；旧版 DSH 用户
不升级也照常工作。

自检脚本：`node scripts/smoke-dsh-v2.mjs`（仿新版 DSH 全链路）、
`node scripts/smoke-dsh-legacy.mjs`（仿旧版 DSH 全链路）、
`node scripts/probe-real-dsh.mjs`（对运行中真实 DSH 只读验证，需本机浏览器
已登录过一次 Web 面板以生成签名密钥）。

## relay 说明

插件默认连接 `https://www.deepseek-claudex.cn`（作者自营 relay：账号注册、
设备管理、消息路由均走该服务器）。也可自建：见主仓库
[dshmobile](https://github.com/zdx8637-gitdog/dshmobile) 的 `relay/` 目录与
`dsh-remote/docs/04-operations.md`，然后在面板里把 relay 地址改成你自己的。

## 开发

```sh
npm install
node scripts/build.mjs                  # 产出 lib/index.js + lib/client.js
node scripts/smoke-host.mjs <u> <p>     # 账号密码模式冒烟
node scripts/smoke-grant.mjs <u> <p>    # 手机授权模式冒烟
```

完整三端（手机 App / relay / 协议）见主仓库
[zdx8637-gitdog/dshmobile](https://github.com/zdx8637-gitdog/dshmobile)。

## License

MIT
