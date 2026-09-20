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

## DSH 版本要求（只支持 v0.1.5+）

v0.1.5 起 DSH 给本地 Web 服务加了浏览器会话鉴权（`dsh web` 打印的 URL 里带
进程级 launch token → 浏览器换会话 Cookie，`/api` 全部请求校验），并把 RPC
协议升级为 Typert 端点（`session/list`、`{args}` 载荷、`/api/remote.mux`
流复用、`$events` 审批/提问瀑布）。插件 0.1.0-beta.17 起适配该协议：

- host 半边经 `ctx.connection.authenticatedUrl()` 取 launch token 交给桥子进程；
- 桥一次性换 Cookie（HMAC 签名、30 天有效），缓存于状态目录、401 自动重铸，
  所有 `/api` 请求与 WS 升级携带 Cookie；
- 会话/工作区/命令端点映射到新协议，事件流走 `/api/remote.mux` 的
  `session/follow` + `workspace/follow` + `session/control`，审批/提问走
  `$events` + `$events/result`。

> ⚠️ **自 0.1.0-beta.23 起不再支持旧版 DSH（≤ v0.1.0-rc.6）**：原先的"双协议自适应"
> （legacy：点号端点、裸 payload、`events.mux`/`events.host`、`/api/respond`、无鉴权直连）
> 已整体删除，协议面只留一条：**adapter −283 行 / dsh −59 / main −21 / host −8**，
> 另删掉整条"仿旧版 DSH"的 smoke 脚本。请确保 **DSH ≥ v0.1.5**；
> 若桥连不上 DSH，会在 `bridge.log` 给出明确提示：
> 「v2 协议握手失败：请确认 DSH 正在运行（dsh web）；本插件版本已不再支持旧版 DSH（≤0.1.5-rc.6）」。

自检脚本：`node scripts/smoke-dsh-v2.mjs`（仿新版 DSH 全链路）、
`node scripts/probe-real-dsh.mjs`（对运行中真实 DSH 只读验证，需本机浏览器
已登录过一次 Web 面板以生成签名密钥）、
`node scripts/archive-session.mjs --list | --newest-idle`（安全清理闲置会话；默认**拒绝**归档活跃会话）、
`node scripts/unarchive-session.mjs <id>` 与 `node scripts/probe-session-archive.mjs <id>`
（DSH 没有"取消归档"接口：归档集合在宿主内存里，改状态文件后需重启 DSH 才生效——细节与检查清单见
[docs/dsh-session-archive.md](https://github.com/zdx8637-gitdog/dshmobile/blob/main/docs/dsh-session-archive.md)）。

## 单实例保护（防"两个桥互相顶替"）

同一台机器上如果同时跑着两个桥（多开了一个 DSH、上次 DSH 被强杀留下的孤儿桥、或新旧插件混跑），
它们共用同一份状态目录 `~/.dsh-mobile` ⇒ **同一个 relay 设备身份** ⇒ 在 relay 侧互相把对方踢下线，
手机端表现为"**登录后刷新不出会话**"。自 0.1.0-beta.23 起有四层防护：

- **桥侧单例锁**：按状态目录散列出一个本机回环端口当锁（进程退出即自动释放）；新实例会请旧实例"让位"，
  让位失败则以退出码 42 退出，绝不并存；
- **宿主接管**：每次启动桥之前先结束本机其它桥进程（更新/重启 DSH 时会顺手清掉旧孤儿，保证新代码在跑）；
- **父进程看门狗**：宿主消失时桥立即退出，不再产生孤儿；
- **桥侧自愈**：若被 relay 按 `4000 duplicate connection` 反复顶替（说明本机还有**老版本**桥），
  主动清理其它桥进程。

面板入口的状态点会显示「另一个桥实例在运行」；此时在面板**保存一次**或重启 DSH 即可重新接管。
诊断用 `~/.dsh-mobile/bridge.lock.json` 与 `bridge.log`（UTF-8）。
**临时第二桥**（做 UI 验证时）请用独立状态目录并加 `--state-dir=<该目录>` 参数，或设
`DSHMOBILE_BRIDGE_SINGLETON=0`。细节见
[docs/bridge-singleton.md](https://github.com/zdx8637-gitdog/dshmobile/blob/main/docs/bridge-singleton.md)。

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
