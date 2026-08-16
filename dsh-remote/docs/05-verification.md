# 验证记录

## 2026-08-16 · 扫码授权 S2 + 插件包装 S3（全链路）

- relay：`/pairing-codes/device`（匿名出码+领取凭证）、`/:id/grant`（手机授权）、
  `/:id/status?secret=`（插件轮询一次性签发会话）；迁移 009（user_id 可空 +
  request_secret_hash + granted_to_user_id）；全量测试 117/117；生产冒烟通过。
- 限流：verify 严限 5/分（防爆破 6 位码）；出码/授权/轮询面 300/分
  （插件轮询 30/分 + 手机电脑同 NAT 共 IP，实测 40 连发不 429）。
- 插件：常驻二维码双模式（pair/grant 按登录态自动切换）；grant 轮询 2s；
  会话落盘（手机授权后重启保持登录）+「退出登录」；bridge token 模式（无密码直连，
  401 自动刷新一次）；429 自动延时重试；账号密码错误自动回退授权码。
- 手机：登录页扫码入口合并（扫一扫 + 手输码同一面板）；设备页顶栏「扫码」；
  GrantLoginScreen 授权确认页；grant deep link + 相机扫码分流。
- 插件入口：设置页卡片 → **左侧栏底部箭头弹窗**（`sidebar.footer.action` 槽位，
  宽栏带文字、窄轨仅箭头；面板浮层承载全部配置与二维码）。
- 落地页/分发：/dshmobile 静态托管（微信=下载、浏览器=跳 App、App 内=扫码）；
  APK 直链；grant 深链带 pid。
- 踩坑：① DSH `dsh-host-apiproxy` 的 settings 命名空间白名单硬编码，第三方插件
  默认不暴露（上游标注 deferred work）——本地补丁脚本
  `dshmobile-plugin/scripts/expose-settings-namespace.ps1` 临时解锁；
  ② qrcode-generator CJS 命名空间被当函数调用 → 画布空白（默认导入修复）；
  ③ 轮询耗尽共享 IP 限流额度 → 限额分层；
  ④ 宿主 session 残留导致"未填账号却 running"——补「已登录徽标 + 退出登录」。

## 2026-08-16 · 扫码登录 S1（配对码核销链路）

- relay 新增 `POST /pairing-codes/verify`（无登录态、限流、一次性核销）：全量测试
  111/111 通过；nginx 补 `/pairing-codes` 代理块；生产冒烟（登录→出码→核销→新 token
  访问 /devices→二次核销 401）通过。
- 踩坑记录：① verify 路由曾挂载在其它带 `router.use(authenticate)` 的路由器之后
  被误拦（无路径 use 中间件匹配所有请求）——修复为独立公开路由器最先挂载；
  ② 配对码哈希此前用 bcrypt 随机盐无法按哈希查找——改为 SHA-256 确定性哈希
  （防爆破靠限流+TTL）；③ `markUsed` 传空串违反 device_id 外键——改传 null。
- 桌面出码：`bridge/src/pair.mjs`；electron 运行视图新增配对卡（二维码/倒计时/刷新）。
- 手机端：deep link `dshmobile://pair?relay=…&code=…`（含 onNewIntent）+ 登录页
  手输码入口；错码显示 "Invalid or expired pairing code"；有效码登录直达设备列表。
  模拟器实测通过（deep link 成功 / 手输码成功 / 错码报错三路径）。

## 2026-08-15：P1 智能体控制面验证

| 项 | 结果 |
|---|---|
| bridge `session.models`（模型目录） | ✅ deepseek-v4-flash/pro，efforts off/high/max |
| bridge `session.selectModel`（幂等回写） | ✅ |
| bridge `commands.list` / `commands.execute`（斜杠命令通道） | ✅ /plan、/plan off、/permission 全部执行成功 |
| App 模型选择器（提供方→模型→思考强度三级） | ✅ 模拟器 UI dump 验证 |
| App 会话控制面板（计划模式开关 + 权限预设 read-only/workspace-write/danger-full-access） | ✅ 开关触发 /plan，DSH 端 plan/mode 事件落日志 |
| App 审批/提问卡片（respond 通道） | ✅ 代码已接（mux 帧 → 卡片 → approvals.respond/questions.respond）；实机审批场景待真机验证 |
| App steer 介入（bridge sessions.steer） | ✅ bridge 通道实现 + App 接口预留（UI 入口 P2） |

### 关键发现

- **斜杠命令不能走 session.prompt**：DSH 把 `/plan` 当普通文本发给模型（模型回答"没有这个命令"）。正确通道是
  `POST /api/commands/execute`，payload 需 `{args: {agentId, line}}` 包装；
- **权限预设命令名是 `/permission <preset>`**（非 /permissionPresets），可用预设
  read-only / workspace-write / danger-full-access；
- **commands/list 返回会话可用命令**：compact、export、feedback、goal、permission、plan。

## 2026-08-15：Android P0 验证（模拟器）

环境：Android 36 模拟器 `dsh_phone`（SDK 新装，cmdline-tools 13114758 +
platform-36 + build-tools 36.0.0 + google_apis x86_64 镜像），APK 18.5MB debug。

| 项 | 结果 |
|---|---|
| Gradle 构建（8.13，腾讯云镜像下载） | ✅ BUILD SUCCESSFUL，无 Kotlin 编译错误 |
| APK 安装 + 启动 | ✅ 无崩溃，AuthScreen 渲染（UI dump 验证） |
| 登录 relay（dshtest，Keystore 存储） | ✅ 登录后进入 Navigator，设备列表显示 `DSH Bridge (windows-p) · online` |
| 设备 WS 连接 | ✅ 状态"已连接"，RemoteClient 收到 relay 消息 |
| 会话树 | ✅ 21 会话渲染（主会话 + 子代理折叠） |
| 会话历史 | ✅ assistant 消息全文 + 轮次标记渲染 |
| 发消息（ping） | ✅ 到达 DSH，agent 回复 `pong 🏓` 流式返回并在 UI 显示 |
| bridge 事件过滤 | ✅ 未订阅会话帧被过滤（桌面进行中会话不泄露） |

### 修复的问题（Android 阶段）

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 7 | 登录报"操作失败" | OkHttp 在主线程发网络请求 | 登录/设备列表移到 IO 协程 |
| 8 | 设备列表为空 | 登录后未自动刷新设备 | LaunchedEffect(auth) 触发 refreshDevices |
| 9 | relay 消息全部静默丢弃 | RemoteEnvelope.schemaVersion 声明 Int，legacy 帧是字符串 → JSON 解码失败被 catch | schemaVersion 改 JsonElement |
| 10 | 模拟器无网络 | 模拟器 wifi 未启用，eth0 无 IP | svc wifi enable |

### 已知问题（P0 遗留）

- 用户消息气泡偶发不渲染（历史加载与事件流竞态，重进会话即恢复）；
- 会话列表需手动点"刷新会话"（未在连接后自动加载）；
- 模拟器验证为 UI 自动化（uiautomator），真机未测（用户后续真机安装验证）。

## 2026-08-15：最小链路（MVP）验证通过

链路：`DSH 127.0.0.1:3080 → bridge → relay(<relay-host>) → 客户端`。

### 环境状态

- 服务器 relay + nginx 从停机状态恢复（7月25日停摆，8月15日复活）；
- 公网 HTTPS/WSS 正常，`/ws/client` 无令牌返回 401（认证层工作）；
- 注册测试账号 `dshtest`，bridge 幂等注册设备 `DSH Bridge (windows-p)`。

### 探针验证（test 阶段）

| 项 | 结果 |
|---|---|
| `POST /api/session.list`（只读探针，无副作用） | 200，18 会话，rpcId 回显匹配 |
| `/api/events.mux` WS 升级 | 正常；4 秒收 1341 帧（全量聚合流，证实需要转发过滤） |
| 第二客户端连接不影响桌面 GUI | 正常（host 支持多下行连接） |

### 端到端测试（test/client.mjs）

```
login ok → device online → ws connected
sessions.list: 18 sessions
lock 验证: 对既有会话写入 => session-locked ✓
sessions.create: 成功，记入 remoteOwned
sessions.run: accepted
assistant 流式回复到达 ✓
```

### 浏览器人工验收

- 登录/自动连接/会话列表渲染 ✓
- 会话内容查看（history + wire 投影）✓
- 新建会话 + 注入 prompt + 流式回复 ✓

## 修复过的问题（按时间）

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | bridge 连 relay 后秒断循环 | 等待断开逻辑在 WS open 前误判 | 事件驱动 closePromise |
| 2 | 客户端收不到会话事件 | mux 帧路由条件写错（method 是帧类型非流名） | 按流分派 handleMuxFrame/handleHostFrame |
| 3 | 登录框不消失、点按钮无反应 | CSS `display:flex` 覆盖 HTML `hidden` 属性 | `[hidden]{display:none!important}` |
| 4 | 登录后无会话列表 | `sessions.list` 请求未注册回调，响应被丢弃；重复连接叠加 | loadSessions 回调 + 防重复连接 + 断线置空 |
| 5 | 点会话看不到内容 | 大会话 history 4.3MB × 服务器 1Mbps = 37s 传输；UI 几万次 DOM 插入 | bridge wire 投影（去 chunk 碎片/截断）+ maxMessages 限制 + 批量渲染 |
| 6 | fpgaproject 会话数量"对不上" | 12 个子代理会话（parent=主会话）被平铺 | UI 按 parentSessionId 建树，子代理默认折叠 |

## 遗留项（有意）

- 审批/提问：bridge 已实现转发与应答，调试台 UI 仅提示"请在桌面 GUI 处理"；
- 事件离线补发：客户端断线重连靠 history 重基线，relay 不做离线队列；
- 远程创建的测试会话在 DSH 侧未清理（4 个，cwd `C:\Users\<user>`），可随时手动删除。

> **修订注（2026-08-15 晚）**：`session-locked` 写锁为早期过度设计，已作废
> （见 docs/03 §1、docs/06 D1）。bridge 代码中的锁逻辑将在 P0 阶段移除。
> 本文档中关于锁的验证记录仅作历史留存。

## 2026-08-15 深夜：手机端三缺陷修复验证（模拟器，真机链路）

链路：手机（模拟器，经 relay）→ 本地 CLI bridge（device `DSH Bridge (windows-p)`）→ 本机 DSH。
注：relay 上同时存在用户另一台电脑的 bridge（device `scanner`，跑 0.1.0 旧版 exe），
探针与手机均显式指向 `DSH Bridge (windows-p)` 才命中本次修复的 bridge 代码。

| 项 | 结果 |
|---|---|
| ① 停止按钮 | ✅ 运行中时输入区替换为「停止当前任务」；点按发送 `sessions.interrupt`，DSH 轮次 TURN END，UI 回到「空闲 + 发消息…」 |
| ② 提问卡跳过 | ✅ 点按「跳过本问题」→ bridge 收到 `questions.respond {cancel:true}` → DSH 解析 question/resolved → agent 回复「问题已被取消…」 |
| ② 提问卡手动输入 | ✅ 输入「oolong tea」点提交 → `{id, selected:[], custom}` 到达 DSH 且 accepted → agent 回复「而且是乌龙茶」 |
| ③ ModalBottomSheet | ✅ 提问卡从屏幕底部弹出（UI dump 坐标 y≈1400–2230），含选项/多选/手动输入/跳过 |
| 挂起提问重放 | ✅ 手机断线重连后重拉历史+重新订阅；bridge 对无人订阅时到达的 question/requested 暂存、订阅后重放 |

### 本夜修复的问题

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 11 | 手动输入被 DSH 拒收（accepted:false 被吞掉） | ① `selected` 有默认值，kotlinx 默认省略 → DSH zod 校验失败；② bridge `respond()` 只查 HTTP 200，不透出 accepted | ① `@EncodeDefault` 强制序列化 `selected`；② `dsh.js respond()` 解析响应体，accepted:false 时返回 respond-rejected |
| 12 | 断线重连后 UI 状态错乱（轮次已结束仍显示「运行中」+ 停止按钮） | 重连只重拉历史重建消息，不复算 running/plan 状态 | 重连与首开两条路径都从历史推导 running（最后一个 turn/start\|turn/end） |
| 13 | 会话延迟发消息报 session-not-found | DSH 释放了空白/未持久化会话（host 侧回收），session.prompt 不自动恢复 | bridge `sessions.run`/`steer` 遇 session-not-found 时按原 id + 缓存 cwd 原位 `session.create` 重建/恢复后重试一次 |
| 14 | 手机订阅前到达的提问/审批直接丢失 | 帧只转发给当时已订阅的客户端 | bridge 暂存未订阅会话的 question/requested、approval/requested，客户端 events.subscribe 时重放；respond 成功后清除 |
| 15 | 跳过提问卡后「❓ 提问待回答」残留 | 只清 pendingQuestions 状态，未清消息列表标记 | question/resolved 时过滤掉该 Sys 标记 |

### 关键发现

- **DSH 的 respond 接受/拒绝在响应体里**：`POST /api/respond` 恒 HTTP 200，`{accepted:false, reason:"bad-response"|"not-pending"}` 才是不成功；
- **跳过提问的 DSH 语义**：client-response 用 `ok:false + error.code:"cancelled"`，agent 侧收到 ASK_CANCELLED 错误并继续轮次；
- **提问应答校验**：`sessionId` 必须与挂起提问一致、`answers.length == questions.length`、单选时 custom 与 selected 互斥、selected 必须逐项出现在选项 label 里；
- **空白会话**（无 turn/start）被 host 回收后不可 resume（持久化里没有），bridge 的 session-not-found 重建兜底是远程场景的必需品；
- **ask_user 工具调用有超时**，超时未应答则自动 claimQuestion(cancelled) —— 手机端应答窗口有限，bridge 暂存/重放不能救超时，属预期。

## 2026-08-16 凌晨：会话历史上滑分页（参考 sessioncontrol loadOlder）

链路同前（模拟器 → relay → 本地 bridge → 本机 DSH）。目标：进入对话后滑到最上方，逐页拉取更早历史。

| 项 | 结果 |
|---|---|
| 尾页加载（进入会话，20 条消息，滚到底部） | ✅ 打开后不再误拉分页（修复了"开屏瞬间在顶部触发一页"的时序问题） |
| 滑到顶部触发拉页 | ✅ 顶部出现「加载更早的消息…」指示；发出 `sessions.history {beforeSeq, maxMessages:50}` |
| 游标正确性 | ✅ 首拉 `beforeSeq:629754`，再拉 `beforeSeq:584988`（老事件 seq 边界由 bridge 顶层补 seq 保证） |
| 位置保持 | ✅ 加载后原首条仍锚定在视口顶部（LazyList index 从 0 → 新页条目数，日志 idx=67/75 验证），无跳动 |
| 连续翻页 | ✅ 同一会话连续两页（629754 → 584988），`hasMore` 驱动继续/停止 |
| 到顶停止 | ✅ a6a330c4 会话第二页覆盖 seq 0..6278 后 `hasMore=false`，翻页正确终止 |
| 防死循环 | ✅ 空页/游标未前进时强制 `hasMoreOlder=false` |

### 本夜修复的问题

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 16 | 分页游标失效（beforeSeq 永远发不出去） | DSH history 条目的 seq 在 `event` 信封内，客户端顶层取不到 → 永远重拉尾页 | bridge `sessions.history` 响应在每条目顶层补 `seq`（客户端 `HistoryEntry.seq` 直接可用） |
| 17 | 打开会话瞬间自动多拉一页 | 初始 load 与 scrollToItem(底部) 之间，视图短暂停在顶部，触发条件满足 | `historyLoaded` 延后到滚到底部之后才置 true |
| 18 | 分页请求异常时协程可能挂掉/死循环 | 无 try/catch、无进展检测 | 拉取包 try/catch；游标未前进即停 |

### 关键发现

- **DSH 分页语义**：`paginate(events, beforeSeq, maxMessages)` 按 `event.seq < beforeSeq` 过滤、从尾部按消息数截取（maxMessages 是"消息"数不是事件数，一页 50 消息 ≈ 上百事件），`hasMore = cut > 0`；
- **wire 投影已含分页所需全部字段**：events 顶层 seq（新增）+ hasMore，客户端无需再动协议；
- **大会话单条消息可能极高**（如本会话单条 assistant 消息 >100K px），滚过它才能触发下一页，属正常聊天体验。

## 2026-08-16 凌晨：会话重命名 / 分叉 / 归档 + 会话标题显示

链路同前。DSH 原生支持三件事：`session.rename`、`session.fork`、`workspace.archiveSession`（单向，无 unarchive API）。

| 项 | 结果 |
|---|---|
| bridge `sessions.rename` | ✅ 请求 `{sessionId, title}` → DSH 归一化标题返回 `{title, seq}`；空标题 400 |
| bridge `sessions.fork` | ✅ 默认在最后完成的轮次切（atSeq 省略语义），返回子会话 id |
| bridge `sessions.archive` | ✅ 映射 `workspace.archiveSession`，响应含全量归档集合 |
| sessions.list 附带归档集合 | ✅ `data.archivedSessionIds`（并行取 workspace.list + host/archived-sessions-changed 帧更新缓存） |
| App 列表行 ⋮ 菜单（重命名/分叉/归档） | ✅ 每行操作入口，实机点按全通 |
| App 重命名弹窗（列表 + 会话内点标题） | ✅ 两次实机重命名（a6a330c4、79863fce），DSH 投影 title 更新，列表/顶栏随刷新显示新名 |
| App 分叉 | ✅ 父会话「子会话」折叠数 1→2，子行「└ 同名标题」渲染 |
| App 归档区 | ✅ 归档后行从主列表消失，底部出现「▸ 归档 (N)」，展开可见并可打开 |
| 会话页顶栏显示会话名 | ✅ 左上角显示标题（"今天喝咖啡还是喝茶"→重命名后"提问卡测试"），无标题回退 session id |

### 本夜修复/调整

| # | 项 | 说明 |
|---|---|---|
| 19 | 子会话折叠标签 | 「子代理会话」→「子会话」（分叉的子会话也挂 parentSessionId） |
| 20 | 归档语义 | DSH 归档只进集合不删会话（session.list 照常返回），bridge 透出集合、App 客户端过滤 + 归档区；无 unarchive，归档单向 |

### 关键发现

- **`session.rename` 标题归一化在 host**：空白标题被拒（title-invalid）；响应里的 `title` 才是最终值（App 用它刷新顶栏）；
- **`session.fork` 不要求会话在运行**（readSessionState 直读持久化状态），无已完成轮次时报 fork-unavailable；
- **`session.list` 的 updatedAt 只取 createdAt/lastPromptAt**：重命名/归档不会把会话顶到列表最前；
- **归档对会话内容零影响**：归档后仍可打开、仍可继续对话（只是从主列表隐藏）。

## 2026-08-16 上午：插入对话引导（steer）+ 排队消息管理 + 审批应答修复

链路同前。补齐 web 端已有的"运行中可继续发消息/编辑/删除/引导（插话发送）"能力，并修掉审批卡点按无效的竞态。

| 项 | 结果 |
|---|---|
| 运行中输入栏保留 | ✅ 停止按钮改为输入行内紧凑红图标 + 顶栏中断按钮，不再占用输入栏 |
| 运行中发消息进入排队 | ✅ 消息即时上屏并显示「⏳ 排队中」（session/queue 帧绑定 itemId） |
| 点消息弹 编辑/删除/引导 | ✅ 三种操作实机全通：编辑改文本、删除移除、引导=updateQueue steer 插话 |
| 引导自动插入对话 | ✅ steer 后消息被 agent 中途接纳（显示为正式消息），agent 在当轮响应 |
| 审批卡 拒绝/允许 | ✅ 修复后实机验证：approvals.respond 到达 bridge、DSH 接受、卡片消失、任务继续 |
| 弱网断连循环修复 | ✅ bridge 不再转发 assistant/chunk、step/* 流式碎片（与 history 投影一致），洪峰消失后手机 20s ping/pong 不再超时断连 |

### 本夜修复的问题

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 21 | 审批卡点「允许/拒绝」本地端无反应 | onClick 里 `scope.launch { 读状态 }` 后立刻 `状态=null`：协程读到的 rpcId 已被清空（竞态）。提问卡因从数据对象读 rpcId 而幸免 | 先把 rpcId/approvalId 捕获进局部变量再进协程 |
| 22 | 手机与 relay 每 ~40s 断连循环（1006） | bridge 把 mux 全量帧（数万 assistant/chunk/分钟）转发给手机，洪峰下 OkHttp 20s ping/pong 超时断链 | bridge 实时流同 history 投影：剥离 chunk/step 碎片（手机不渲染它们） |
| 23 | 排队标记偶发缺失 | session/queue 帧可能先于发送响应到达，绑定不到气泡 | 发送成功时直接用当前 pendingQueue 快照绑定 itemId |

### 关键发现

- **DSH updateQueue 语义**：`{sessionId, itemId, action}`，action ∈ edit（仅文本）/ remove / steer；steer 仅对 next-turn 排队项且 agent 运行中有效（否则 steer-unavailable）；
- **队列状态权威来源是 `session/queue` 帧**（items[id, placement: queued|steering|context, message]），每次 inbox 变动都广播；
- **审批可用「重置权限预设 + pwsh 任务」稳定复现**：`/permission workspace-write` 后再发 pwsh 命令即触发 escalation 审批；
- **审批有超时**，长期不处理会自行 abort（卡片消失但工具失败重试）。

## 2026-08-16 午间：手动测试反馈修复（编辑保存无效 / 消息双显）

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 24 | 排队消息「编辑」无法保存，只能取消 | 失败原因只写全局 error，而会话页没有渲染错误行（错误被弹窗遮住，看似无反应）；且消息若已被 agent 消费，DSH 报 queue-item-not-found | ① 会话页加全局错误行；② 编辑对话框内联显示失败原因（如"该消息已不再排队"）；③ repo.updateQueue 返回错误消息 |
| 25 | 发送消息偶发双显（两条相同 prompt） | 上屏有三个来源（doSubmit 立即上屏 / user/message 事件 / 历史重拉），去重依赖的「排队标记」会被后续空 queue 帧提前清掉，事件到达时无匹配 → 再添一条 | 统一去重协议：事件按 ①已绑定气泡→清标记 ②响应未回(inflight)→事件上屏 ③末尾用户气泡同文本→跳过 ④否则追加；doSubmit 只在 inflight 命中时上屏 |

### 关键发现

- **queue 帧是两段式的**：消息入队发一帧（含 item），被消费后发一帧空列表——靠"标记"做事件去重会被第二帧清掉，必须回到"按文本/上屏状态"去重；
- **响应与 user/message 事件到达顺序不保证**：空闲发送时 agent 秒级接纳，事件常先于 HTTP 响应回到手机，双路径上屏必须用一个 inflight 集合仲裁；
- **AlertDialog 会遮住页面底部的全局错误**：弹窗内操作失败必须就地显示原因。

## 2026-08-16 午间：排队消息改为输入栏上方信息条（web 端 QueueDock 语义）

反馈：插入消息以聊天气泡形式进入会话流，会被 agent 新输出顶走、不便操作。参照 web 端
`conversation.input.dock`（QueueDock）改造：**排队消息 = 贴在输入栏上方的可折叠信息条**（行内
编辑/删除/引导），**引导中的消息**才以 ⚡引导中 pending 气泡出现在会话流（web 端 PendingSteeringBubble 语义）。

| 项 | 结果 |
|---|---|
| QueueDock 信息条 | ✅ 排队消息渲染在输入栏正上方（不被会话流冲走），头部「排队消息 (N)」可折叠，行内 编辑/删除/引导 按钮 |
| 引导（插话） | ✅ 点「引导」→ updateQueue steer → 条目移出信息条、以 ⚡引导中气泡进会话流，被接纳后变正式消息 |
| 信息条编辑 | ✅ 对话框就地显示失败原因；成功后信息条文本随服务端 queue 帧更新 |
| 桥接 queue 帧重放 | ✅ bridge 缓存每会话最近一次 session/queue 帧，客户端订阅时重放（重连后信息条不丢） |
| 双显回归 | ✅ 引导后仅一条消息（stale queue 帧按文本/ID 去重） |

### 关键发现

- **web 端两个区域分工**：`conversation.input.dock`（QueueDock，排队）与会话流内 pending steering 气泡（引导中）——手机端对齐这一分工后，双显问题从根上简化（聊天流只由接纳事件上屏，排队态不进流）；
- **queue 帧的到达顺序不保证**：stale 帧可能晚于接纳事件到达，补气泡必须同时按 itemId 和文本去重。

## 2026-08-16 下午：新建会话选择目录（工作区 / 本机目录浏览 / 新建文件夹）

链路同前。目标：新建会话时可点选目录（工作区一键 + 「此电脑」盘符 → 面包屑逐层点开 + 新建文件夹），全程点选不手输路径。

### bridge 侧（目录能力落本机 fs）

| 项 | 结果 |
|---|---|
| `host.listDirectory` 改本机直读 | ✅ 不再依赖 DSH browse 能力（本地部署挂 native 选择器，远程不可用，返回 directory-picker-unavailable）；改用 node:fs `opendir`，与 DSH browse 语义一致：仅子目录+目录符号链接、名称排序、上限 1000、`{path,home,crumbs,entries,truncated}` |
| `host.listDrives` | ✅ 探测 A–Z `X:\`，返回存在的盘符（实测 `C:\`、`D:\`） |
| `host.createDirectory` | ✅ `mkdir(join(resolve(path), name))`，EEXIST → directory-exists，非法名 400 |
| `sessions.create` 支持 workspaceId/cwd | ✅ `workspaceId` 优先，其次 `cwd`，互斥交给 DSH 校验 |
| 目录句柄 bug | ✅ 修掉 `for await` 结束后再 `dir.close()` 导致的 ERR_DIR_CLOSED（"Directory handle was closed"），Node 会在迭代完成时自动关闭句柄 |

### App 端（模拟器 uiautomator 全链路）

| 项 | 结果 |
|---|---|
| 工作区列表加载 | ✅ 弹窗显示 使用默认目录 + 工作区（p → `D:\p`、fpgaproject → `D:\fpgaproject`）+ 浏览目录… |
| 工作区点选建会话 | ✅ `sessions.create {workspaceId}` accepted，返回新会话 id |
| 浏览目录「此电脑」层级 | ✅ 盘符列表 C:\、D:\ 点选进入 |
| 目录列表 + 面包屑 | ✅ 📀（回此电脑）/ 🏠（回 home）/ 祖先链 crumb（D:\ → p）逐级点开、回退均正确 |
| 🏠 home 跳转 | ✅ 面包屑变 C:\ → Users → <user>，列表显示 `.agents`、`.cache` 等隐藏目录（与桌面 browse 一致） |
| 新建文件夹 | ✅ 弹窗输入名 → `host.createDirectory` → 磁盘真实建目录（`D:\dshpickertest` 已验证存在）→ 列表自动刷新 |
| 使用此目录（happy path） | ✅ 在 `D:\p` 点「使用此目录」→ `sessions.create {cwd:"D:\\p"}` → 会话 `session-fb318471…` 建立（bridge 日志 payload 确认）→ App 自动进入「新会话」对话页 |
| 使用此目录（失败路径） | ✅ 盘符根 `D:\` 被 DSH 拒（`EPERM: mkdir 'D:\'`，DSH ensure-project-directory 限制）→ 弹窗不关、就地显示「创建会话失败，该目录不可用（如盘符根目录）」 |

### 修复/调整

| # | 项 | 说明 |
|---|---|---|
| 26 | 目录浏览改为 bridge 本机 fs 直读 | DSH 部署常挂 native 目录选择器（远程 browse API 不可用）；bridge 在目标机器上，直接 `opendir` 等价于 DSH browse 语义，与选择器配置无关 |
| 27 | 建会话失败静默问题 | `onCreateAt` 改为返回 Boolean：失败时目录选择弹窗保持打开并就地显示原因（此前盘符根目录等场景无任何反馈） |
| 28 | `for await` 目录句柄重复 close | 移除 `finally { await dir.close() }`，Node 迭代完自动关闭；显式再关抛 ERR_DIR_CLOSED |

### 关键发现

- **DSH 对盘符根目录建会话会 EPERM**：`session.create {cwd:"D:\\"}` 内部 ensure-project-directory 时 `mkdir 'D:\'` 失败（operation not permitted），非根目录（如 `D:\p`、`D:\p\__dirtest__`）正常——手机端选择器对根目录给出就地错误提示；
- **目录浏览范围 = 整机文件系统**（镜像桌面原生对话框 + DSH browse 策略）：手机账号即电脑所有者，同一信任级别；
- **UI 自动化经验**：Compose AlertDialog 打开瞬间 uiautomator dump 可能采不到内容节点，稍等 2–3 秒再 dump 即完整。

## 2026-08-16 傍晚：⚠️ 本助手会话就在手机端会话列表里（self-cancel 事故记录）

清理"历史探针遗留的运行中会话"时，`sessions.interrupt`/`session.cancel` 导致本助手自己的
工具调用连续 3 次报 `Error: tool call aborted`。排查结论如下，供后续运维避坑：

- **手机端列表里的「deepseek harness 手机端转发 ● 运行中」（`session-be437676…`）就是执行本助手的 DSH 会话**：
  它是当时唯一的 running 会话；`cwd = D:\p`（本助手工作目录）；projections 里的
  `goal.id = goal-656e3b89-30d1-459f-8db5-875b9ed41475 rev 2` 与本助手的 goal 完全一致；
  统计 turns 54 / steps 1861 / ~1M decode tokens（长时间编码会话的特征）。
- **对它发 `session.cancel`（或手机端点「停止」）= 取消本助手当前步骤**：DSH 把正在执行的
  工具调用步骤取消掉，harness 就把该 pwsh 调用返回为 "tool call aborted"（不是超时、不是被
  kill，请求本身都正常到达并执行了——bridge 日志可证 dv9 的 interrupt 已转发）。**这是预期行为，
  不是 bridge/relay/模拟器的故障。**
- **bridge 日志里持续增长的 "live chunks dropped (unrendered)" 是本助手自己的流式输出**（手机未订阅
  该会话，帧被过滤只计数），不是残留任务；"从 1 数到 5000" 的探针会话早已结束。**无需清理。**
- 处置：删除 `test/interrupt-all.mjs`、`test/dsh-local-cancel.mjs`（会自杀的清理脚本）；
  保留 `test/dsh-local-status.mjs`（只读 session.list，查 running 会话身份用）。
- **运维规则**：对手机端会话做任何"中断/停止"操作前，先确认目标不是「deepseek harness 手机端转发」
  （或先看 projections.goal 是否为 harness 自己的 goal）——中断它等于中断正在干活的助手。

## 2026-08-16 晚：新建会话选目录 → web 端「未分组」修复（工作区自动注册）

反馈：手机端选目录建会话后，web 端显示在「未分组」，但与会话交流确认 cwd 确实是所选目录。

### 根因（读 DSH 源码确认）

- **web 端只按工作区分组**：`dsh-client-ui-workspace` 的 `groupByWorkspace` 只认
  `workspace.sessionIds` 账户；不在任何工作区账户里的会话一律进「未分组」桶（i18n `group.ungrouped`）；
- **`session.create` 只接受 workspaceId / cwd 二选一**（`sessions.schema` 注释 "at most one"），
  手机端发 `cwd` 建的会话没有工作区归属 → 必然未分组（cwd 本身生效，所以目录是对的，只是分组不对）；
- **`workspace.create {path}` 对已存在目录幂等注册/解析工作区（不 mkdir）**：已属工作区的路径返回该
  工作区（`created:false`），新路径注册新工作区（`created:true`，标题=目录名）。

### 修复（bridge `sessions.create`）

收到 `cwd`（无 workspaceId）时：先 `workspace.create {path:cwd}` → 成功则改用 `workspaceId`
建会话（会话既在指定目录运行、又被 web 归入同名工作区）；注册失败回退纯 `cwd`（功能不变，仅保持未分组）。
两个防护：

1. **盘符根目录跳过注册**：`D:\` 等根路径 DSH 无法作为项目目录（EPERM），直接走 cwd 让 DSH 报错，
   手机端显示"创建会话失败，该目录不可用（如盘符根目录）"，不产生垃圾工作区；
2. **失败回滚**：为本次新建的工作区（`created:true`）在 `session.create` 失败时自动 `workspace.delete`，
   不留孤儿工作区。

### 验证

| 项 | 结果 |
|---|---|
| cwd=`D:\p`（既有工作区） | ✅ `workspace.create` 解析到「p」（created:false），会话以 workspaceId 建，`p.sessionIds` 计入（4→5） |
| cwd=`D:\p\__grouptest__`（新目录） | ✅ 自动注册工作区「__grouptest__」（created:true），会话计入其 sessionIds；web 端将显示在该分组下 |
| 手机端全链路 | ✅ 模拟器选 `D:\p` → bridge 日志 `cwd mapped to workspace dd3c2f98… (created: false)` → 会话 `session-7812746d…` 以 workspaceId 建 |
| cwd=`D:\`（盘符根） | ✅ 跳过注册 → DSH EPERM 报错透传手机；workspace.list 无 `D:\` 残留（修复前会留下垃圾工作区） |
| 测试残留清理 | ✅ `__grouptest__` 工作区注册与临时目录已删；误注册的 `D:\` 工作区已删 |

### 关键发现

- **web 端「未分组」= 无工作区账户**，与 cwd 无关：目录对了但没分组，正是 cwd-only 创建的固有表现
  （web 自己新建会话若不选工作区同样未分组）；
- **`workspace.create` 是幂等的目录→工作区注册**，是"任意目录建会话且正确分组"的唯一通道
  （DSH 无 session attach-to-workspace API；`insertSessionBefore` 只能在工作区内排序）。
