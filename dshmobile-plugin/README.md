# @liustack/dshmobile-bridge

DSH 插件：把本机 DeepSeek Harness 接入手机远程控制（dshmobile 三端里的「电脑端」）。

- **host 半边**（`lib/index.js`）：注册 settings 命名空间 `dshmobile`；按配置
  启停 bridge 子进程（包内 `bridge/`，与独立版 bridge 同协议）；扫码登录
  （方向一）出码——客户端卡写 `refreshPairing=true` 即登录 relay 生成一次性配对码。
- **client 半边**（`lib/client.js`）：设置页 → 插件 → 「DSH Mobile 远程桥接」卡：
  连接配置（保存后桥自动重启）、桥状态、配对二维码 + 6 位码 + 倒计时。

## 构建

```powershell
npm install            # esbuild 等构建期依赖
node scripts/build.mjs # 产出 lib/index.js + lib/client.js（handoff 格式）
```

## 开发态安装（本机 web profile）

```powershell
powershell -File scripts/install-dev.ps1
# 依赖注入（link）+ cordis.patch.yml 插入行；随后重启 dsh 生效
```

正式分发：发布 npm 后 `npx -y @deepseek-ai/dsh plugin --profile web add @liustack/dshmobile-bridge@latest`。

## 调试

- 宿主逻辑冒烟（不重启 dsh）：`node scripts/smoke-host.mjs <relayUser> <relayPass>`
  （建议用一次性账号，避免污染常用账号的设备列表）。
- 改代码后：`node scripts/build.mjs`（link 安装无需重装）→ 重启 dsh 看效果。

## 依赖契约

- 运行时依赖：`zod`、`@deepseek-ai/dsh-settings`（版本对齐 DSH 发行版 0.1.0-rc.6）；
- client 半边依赖边（package.json `dsh.client.inject`）：
  `@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-settings`；
- bridge 协议与 `dsh-remote` 一致：设备身份 = Windows MachineGuid（改名不换行），
  凭证失效（4003）自动重注册自愈。
