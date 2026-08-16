# @zdx8637-gitdog/dshmobile-bridge

DSH 插件：让手机远程控制本机 DeepSeek Harness（dshmobile 三端里的「电脑端」）。

- **常驻二维码**（Web 左侧栏底部箭头弹窗）：与登录态无关，永远可扫——
  · 电脑已登录 → 手机（哪怕未登录）扫码直接登录同账号；
  · 电脑未登录 → 手机（已登录）扫码授权，电脑自动登录；
- **bridge 子进程守护**：账号密码模式或手机授权 token 模式（无密码直连，401 自动刷新）；
- 手机端一码三用：微信扫=下载 App、相机扫=跳 App 配对、App 内扫=直接登录/授权。

## 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637-gitdog/dshmobile-bridge@latest
# 重启 dsh 后，Web 左侧栏底部出现 ▶ 箭头，点开即配置面板
```

前置：本机需要 `pnpm`（`dsh plugin` 子命令依赖它；`corepack enable` 或
`npm i -g pnpm`）。

手机 App：扫描面板二维码 → 落地页下载 APK（或从
[发布页](https://github.com/zdx8637-gitdog/dshmobile/releases)获取）。

## ⚠️ 已知限制（DSH 0.1.0-rc.6）

第三方插件的 settings 命名空间默认**不对 Web 界面暴露**（DSH 上游标注为
deferred work）。本插件需要一行本地补丁，否则面板会显示
`scope=unavailable`：

```powershell
powershell -File "$env:LOCALAPPDATA\npm-cache\_npx\*\node_modules\@zdx8637-gitdog\dshmobile-bridge\scripts\expose-settings-namespace.ps1"
# 或直接运行：npx 安装目录下 node_modules/@zdx8637-gitdog/dshmobile-bridge/scripts/expose-settings-namespace.ps1
# 每个 dsh 安装目录运行一次；dsh 升级后需重跑
```

上游开放"插件自注册命名空间即可远程暴露"后，此补丁可移除。

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
