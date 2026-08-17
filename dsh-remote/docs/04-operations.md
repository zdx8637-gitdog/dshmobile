# 运维手册

## 1. 服务器（<relay-host>）

| 组件 | 路径 | 端口 |
|---|---|---|
| relay 服务 | `/opt/session-control-relay/service`（systemd `session-control-relay.service`） | 48730 |
| relay 源码 | `/home/ubuntu/session_control/services/relay` | — |
| nginx 站点 | `/etc/nginx/sites-enabled/session-control-relay` | 80/443 |
| 调试台 UI | `/opt/session-control-relay/web/dsh-debug/index.html` | — |
| relay 数据库 | `/opt/session-control-relay/service/data/relay.db`（SQLite） | — |

常用命令（SSH `ubuntu@<relay-host>`）：

```bash
systemctl is-active session-control-relay.service nginx
curl -s http://127.0.0.1:48730/health
curl -s http://127.0.0.1:48730/relay/status     # bridgeCount/clientCount/pendingRequestCount
journalctl -u session-control-relay.service --since '10 min ago' --no-pager | tail -30
```

## 2. 调试账号

- relay 账号：`dshtest`（测试账号密码不公开；脚本用环境变量 TEST_PASS / RELAY_SSH_PASS 注入）
- 设备：`DSH Bridge (windows-p)`（clientDeviceKey `dsh-bridge-windows-p-01`，
  幂等注册：重启不会新建设备，只轮换设备令牌）
- 公网入口：`https://www.deepseek-claudex.cn`（DNS → <relay-host>，
  Let's Encrypt 证书，注意续期）

## 3. bridge（本机 D:\p\dsh-remote\bridge）

```powershell
node bridge/src/main.js        # 前台；生产可包一层自启
node bridge/src/pair.mjs      # 扫码登录出码：登录 relay 账号并生成 6 位配对码（300s 有效）
```

- 配置：`bridge/config.json`（relay URL/账号/设备标签、DSH URL、状态目录）；
- 状态：`bridge/state/`（运行状态目录）；
- 依赖：DSH web 运行在 `127.0.0.1:3080`（bridge 只走回环，天然过信任栅栏）；
- 重连：relay 与 DSH 两条流均指数退避自动重连；设备令牌复用不重复 provision；
- **凭证失效自愈**：设备被吊销/删除后 relay 以 4003 关闭连接，bridge 清 token 自动
  重新注册（同 `clientDeviceKey` → 服务器新建行，设备自动回到列表）；
- **设备身份**：exe 版 `clientDeviceKey` = Windows MachineGuid（与电脑名解耦），
  改名只更新服务器同一行的 label；dev 版 key 在 `config.json` 手工指定。

## 4. web 调试台

- 本地文件：`web/index.html`（单文件）；
- 部署：`python scripts/deploy-web.py`（SFTP 到服务器 dsh-debug 目录）；
- 访问：`https://www.deepseek-claudex.cn/dsh-debug/`；
- 改 UI 后浏览器需强刷（Ctrl+F5）避免缓存旧页。

## 4.1 扫码分发（落地页 + APK 托管）

- 静态目录：`/opt/session-control-relay/web/dshmobile/`（nginx location `/dshmobile/`）；
- 内容：`index.html`（扫码落地页：微信=下载、浏览器=跳 App）+ `DSH-Mobile-<版本>.apk`；
- 部署：`python scripts/deploy-dshmobile.py`（凭据走环境变量 RELAY_HOST/RELAY_SSH_PASS）；
- 发版流程：`gradle :app:assembleRelease` → 拷到 `release\` → 跑部署脚本 → 手机扫码即领最新包。

## 4.2 DSH 插件（dshmobile-bridge）安装

```powershell
# 前置：pnpm（dsh plugin 子命令依赖）；corepack enable 或 npm i -g pnpm
powershell -File ..\dshmobile-plugin\scripts\install-dev.ps1   # 本地 link 进 web profile
powershell -File ..\dshmobile-plugin\scripts\expose-settings-namespace.ps1  # DSH 白名单补丁（见下）
# 重启 dsh 生效；改插件代码后：node scripts/build.mjs → 重启 dsh
```

- DSH 0.1.0-rc.6 的 settings 命名空间对第三方插件默认不暴露（`dsh-host-apiproxy`
  硬编码白名单，上游标注 deferred work）——`expose-settings-namespace.ps1` 做本地
  单行补丁，**dsh 升级后需重跑**；
- 插件入口：Web 左侧栏底部（设置旁）的 `▶` 箭头——点开弹出面板（二维码/桥状态/
  账号配置），再点收起；数据面仍是 settings 命名空间 `dshmobile`；
- 宿主冒烟：`node plugins/dshmobile-plugin/scripts/smoke-host.mjs <user> <pass>`
  （账号密码模式）与 `smoke-grant.mjs <user> <pass>`（手机授权模式）；
- 正式分发：发布 npm 后 `npx -y @deepseek-ai/dsh plugin --profile web add @liustack/dshmobile-bridge@latest`。

## 5. 端到端验证

```powershell
node test/client.mjs     # 全链路：登录→设备→列会话→锁验证→建会话→注入→流式回复
node test/ui-sim.mjs     # 仅验证 sessions.list 响应路径
node test/diag.mjs <sessionId>  # 单会话 history 诊断（默认空会话）
```

注意：`client.mjs` 每次运行会在 DSH 中真实创建一个新会话并消耗一次 API 调用。

## 6. 故障排查速查

| 症状 | 检查 |
|---|---|
| 调试台"无设备" | bridge 是否在跑；`relay/status` 的 bridgeCount |
| 会话列表为空 | relay 日志是否有 `pending request timed out`；bridge 日志是否有 adapter 输出 |
| 点会话无反应 | F12 看 WS 帧；用 `diag.mjs` 单测 history |
| 发送被拒 | 错误码 `UNSUPPORTED` = 消息类型未实现；`session-locked` 已作废（历史版本） |
| 服务器 502 | nginx 是否 active；`werewolves` default_server 会抢 127.0.0.1 的 curl，测试带 `-H 'Host: www.deepseek-claudex.cn'` |
