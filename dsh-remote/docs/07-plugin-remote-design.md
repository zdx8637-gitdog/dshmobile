# 插件化远程访问与扫码登录设计（dshmobile 下一步形态）

> 状态：设计稿 v0.1。**S1（方向一扫码登录）、S2（方向二设备授权码流）、S3（插件包装）
> 已实施并上线**（2026-08-16）：relay 五个配对码端点 + 插件「常驻二维码双模式」设置卡 +
> 手机扫码登录/授权确认页 + 落地页三环境分流，全链路实测通过。
> 剩余（S4）：授权码自动续期、会话管理（设备吊销/退出所有设备）、多语言文案。

## 1. 背景与目标

现状问题：

- PC 端接入要「下载 exe → 手工登录 → 保持常驻」，分发成本高；
- 手机端每次换机/登出都要手输账号密码，体验差；
- 账号密码若出现在二维码/URL 里有泄漏风险；自动注册随机账号则不可管理（用户记不住、
  换机即丢、relay 上堆孤儿账号），**已否决**。

目标：

1. PC 端一条命令接入（`dsh plugin add`），桥随 DSH 启停，设置页可视化；
2. 用户**只在任一端注册/登录一次**，另一端扫码继承会话，全程零输入；
3. 二维码中**永不出现长期秘密**（密码/refresh token）。

## 2. 总体架构（插件化后）

```
手机 App（APK，保持不变）──WSS──┐
                                ▼
                        ┌──────────────┐   WSS   ┌──────────────────────────────┐
                        │ relay（云服务器）│ ─────── │ Host 插件：bridge 守护（spawn）│
                        │ 账号/设备/配对/审计 │        │    └─ 现有 bridge 代码（复用） │
                        └──────────────┘        └──────────────┬───────────────┘
                                                                │ 127.0.0.1:3080
Web GUI 设置页（Client 插件卡片）◄──── 状态/登录表单/二维码 ──── DSH（本机进程）
```

- **Host 插件**（Node，DSH 进程内）：spawn 现有 bridge 子进程（协议零改动），
  从插件 settings 读 relay 地址/账号，负责启停与崩溃重启；提供 settings 命名空间
  （`remote`）与配对码服务。
- **Client 插件**（浏览器）：在设置页 `settings.plugin.item` 槽位注册一张卡片：
  桥状态灯、账号登录/注册表单、配对二维码、APK 下载入口。
- **手机 App 与 relay 协议不变**；relay 仅新增配对码核销面（见 §7）。

插件生命周期契约：DSH 进程退出 → 远程入口消失（与现状一致，bridge 本就依赖
127.0.0.1:3080）；如需"DSH 未开也能连"须退回系统服务形态，不在本期范围。

## 3. 双登录模型（核心决策）

- 两个信任入口：**账号密码** 与 **扫码**，两端（桌面插件 / 手机）各提供两种方式；
- 账号是唯一信任锚：设备归属、审计、多电脑管理全部沿用现有账号体系；
- **扫码方向唯一：永远是手机扫桌面**（手机有相机，桌面没有，约定免记）；
- 注册/登录只发生一次：用户要么在桌面插件、要么在手机上注册，另一侧扫码继承；
- 自动注册随机账号：**否决**（不可管理、不可恢复、产生孤儿账号）。

```
桌面已登录 ──出码(QR)──> 手机扫码 ──核销──> 手机获得同账号会话     （方向一）
手机已登录 ──扫码──> 桌面插件轮询 ──手机确认──> 桌面获得同账号会话   （方向二）
```

## 4. 扫码方向一：桌面已登录 → 手机扫码登录

复用 relay 现成配对码面（`POST /pairing-codes` 已登录出码，6 位、300s、哈希存储、
限流、审计全齐），只缺核销接口。

```
1. 桌面插件（已登录 user U）：POST /pairing-codes  → { code: "482913", expiresAt }
2. 设置卡显示二维码：dshmobile://pair?relay=<url>&code=482913
3. 手机扫码 → 打开确认页「登录到账号 xxx？设备：DSH Bridge (windows-p)」→ 确认
4. 手机（无登录态）：POST /pairing-codes/verify {code}
5. relay：验哈希 → 未过期 → 未使用 → markUsed → 签发 U 的 accessToken + refreshToken
6. 手机存 Keystore（TokenStore 现成）→ 登录完成 → 设备列表
```

## 5. 扫码方向二：手机已登录 → 桌面扫码登录（RFC 8628 设备授权码流）

桌面没登录时无法调用需鉴权的出码接口，且 6 位码可被旁人抢先核销，
因此引入 **requestSecret（领取凭证）**：藏在桌面进程内、只用于轮询取回结果。

```
1. 桌面插件（未登录）：POST /pairing-codes/device（匿名，限流）
   → { pairingId, code: "913570", requestSecret: "<128bit>", expiresAt }
   （relay 只存 requestSecret 的哈希）
2. 设置卡显示二维码：dshmobile://grant?relay=<url>&pairingId=…&code=913570
   （码里只有 pairingId+code，无 secret）
3. 手机（已登录 user U）扫码 → 确认页「允许这台电脑登录你的账号？」
   → POST /pairing-codes/:id/grant （Bearer U）→ 码绑定 U
4. 桌面插件：每 2s 轮询 GET /pairing-codes/:id/status?secret=<requestSecret>
   → pending → granted：relay 返回 U 的 accessToken + refreshToken（仅持有 secret 者可取）
5. 桌面存会话（OS 凭据库/加密存储）→ bridge 以 U 注册设备 → 设备列表可见
```

- 旁人扫到码也只能把自己的账号"送"给那台电脑（grant 是登录态操作），
  抢不到结果、也拿不到任何 token；
- 手机必须显示**明确确认页**（设备名 + 账号名），扫码绝不静默授权；
- 码 300s 过期、一次性、限流（复用 pairing 限流器）。

## 6. 两端 UI 清单

| 端 | 改动 | 备注 |
| :-- | :-- | :-- |
| 桌面插件设置卡 | ① 桥状态灯（online/offline/重连）；② 登录/注册表单（card-form 支持 secret 字段）；③ 出码按钮 + 二维码（react-qr-code）+ 倒计时/刷新；④ 未登录时轮询配对状态；⑤ APK 下载二维码/链接 | 方向一与方向二按登录态自动切换 |
| 手机 App | ① 注册 `dshmobile://` deep link；② 扫码页（相机 + 手动输 6 位码兜底）；③ 确认页（方向二「允许登录」、方向一「登录到账号」）；④ verify/grant 接口封装；⑤ 手动登录保留不变 | AuthScreen 增加「扫码登录」入口 |

## 7. relay 接口与数据变更

新增接口（配对码面扩展）：

| 方法 | 路径 | 鉴权 | 语义 |
| :-- | :-- | :-- | :-- |
| POST | `/pairing-codes/verify` | 无（限流） | 核销 6 位码 → 签发码主账号的 token 对 |
| POST | `/pairing-codes/device` | 无（限流） | 匿名出码（方向二）→ 返回 pairingId+code+requestSecret |
| POST | `/pairing-codes/:id/grant` | Bearer 用户 | 登录态绑定：码 ↔ 用户（方向二第 3 步） |
| GET | `/pairing-codes/:id/status` | query `secret` | 轮询：pending/granted(+token 对)/expired/cancelled |

数据：`pairing_codes` 表加列 `request_secret_hash TEXT`、`granted_to_user_id TEXT`
（迁移 009，均哈希/索引，与现有一致）。下游（设备注册、WS 鉴权、事件过滤）零改动：
桌面拿到的是正常账号 token，bridge 照旧 `/devices/register`。

## 8. 安全设计

- 配对码：6 位数字、300s TTL、一次性核销、只存哈希（bcrypt，现有 `hashSecret`）；
- `requestSecret`：128bit 随机、只存哈希、只经 query 返回给轮询方、核销后作废；
- 限流：配对码面复用现有 rate-limiter（60s/5 次）；verify/device 额外按 IP 限；
- 审计：create/verify/grant/cancel/expire 全部落 `audit_logs`（现有动作风格）；
- 会话吊销：签发即入库 `auth_sessions`，支持按用户吊销（后续可加"退出所有设备"）；
- 确认页是安全底线：方向二必须展示设备名/账号名并显式确认。

## 9. 分阶段计划

| 阶段 | 内容 | 验收 |
| :-- | :-- | :-- |
| S1 | 方向一：relay `verify` 接口 + 桌面出码 + 手机扫码登录（复用已登录出码面） | 桌面已登录时手机扫码零输入登录 |
| S2 | 方向二：`device`/`grant`/`status` + requestSecret + 确认页 | 手机已登录时桌面扫码登录 |
| S3 | Host/Client 插件封装（bridge 守护 + 设置卡）、APK 分发入口、码自动刷新 | `dsh plugin add` 后全流程可用 |
| S4 | 会话管理（设备列表吊销、退出所有设备）、多语言文案 | 账号可管理化 |

注：S1/S2 为 relay+手机+桌面的功能开发；S3 才把整件事包进 DSH 插件形态。
每阶段独立可验证，不互相阻塞。

## 10. 决策记录（续 docs/06）

| # | 决策项 | 结论 | 日期 |
| :-- | :-- | :-- | :-- |
| D8 | 登录模型 | 双登录：账号密码 + 扫码；账号为唯一信任锚；自动注册随机账号否决（不可管理） | 2026-08-16 |
| D9 | 扫码方向 | 唯一方向：手机扫桌面；两端注册/登录任选其一，另一侧扫码继承会话 | 2026-08-16 |
| D10 | 方向二机制 | RFC 8628 设备授权码流：匿名出码 + requestSecret 领取凭证 + 轮询 + 手机显式确认 | 2026-08-16 |
| D11 | 插件形态 | 先 S1/S2 功能，后 S3 包装：Host 插件 spawn 现有 bridge（子进程守护，协议零改动），Client 插件设置卡承载 UI | 2026-08-16 |
