# 手机端需求文档（dsh-remote mobile）

> 状态：需求讨论稿 v0.1。参照项目：`sessioncontrol-ref/apps/mobile`（React Native + Expo），
> 后端改为 DeepSeek Harness（`docs/02-protocol.md` 的映射表为单一事实来源）。

## 1. 产品定位

手机端是 DSH 的**完整远程客户端（除插件管理）**：

- 本地 DSH 实例是唯一状态真源；手机端不落盘会话数据（列表/历史/模型目录均为内存缓存）；
- 服务器只做认证与转发；
- 手机可操作本地会话：新会话、模式、模型/思考强度、权限预设、中途介入、审批/提问应答。

参考项目（sessioncontrol-ref）已验证的 UX 骨架直接沿用，后端语义换成 DSH。

## 2. 参考项目（sessioncontrol-ref/apps/mobile）的可复用资产

| 资产 | 内容 | 复用度 |
|---|---|---|
| 路由结构 | auth → navigator（设备→项目→会话三级）→ conversation（右滑返回） | 复用（DSH 无 project 概念，改为 设备→会话树 两级） |
| AuthScreen | 登录/注册 + 服务器地址可配置 + SecureStore token | 完全复用（relay 认证面一致） |
| RemoteClient | 自动重连、token 刷新、订阅、request/response 归属、诊断 | 完全复用（信封协议一致，见 docs/02） |
| ConversationScreen | 会话块渲染、工具卡折叠、附件、中断、权限卡、滑动返回 | 复用（块模型换为 DSH SessionEvent 投影） |
| composer controls | 模型/模式/思考强度/feature 选择器 + changeEffect 语义 | 复用交互（映射到 session.selectModel 等） |
| 无状态策略 | 每次打开会话全量重拉 + 订阅增量 + 断线重拉 | 完全复用（正是"手机不存数据"） |

## 3. 功能需求（映射到 DSH API）

### 3.1 P0 — 核心链路

| # | 功能 | DSH API | 备注 |
|---|---|---|---|
| F1 | 登录/注册/登出，token SecureStore | relay /auth/* | 同参考项目 |
| F2 | 设备列表 + 在线状态 + 切换 | relay /devices + host 流 | 多电脑各一 bridge |
| F3 | 会话树（主会话 + 折叠子代理） | session.list + parentSessionId | 桌面 GUI 同款语义 |
| F4 | 会话详情：消息 + 工具卡（可折叠） | session.history（bridge wire 投影）+ mux 流 | 内容模型见 §4 |
| F5 | 新会话 | session.create | 进入即可对话 |
| F6 | 发消息（文本） | session.prompt {mode:'queue'} | 任意会话；运行中排队不打断 |
| F7 | 流式实时渲染（chunk 逐块出现） | mux `session/event` → `assistant/chunk` | |
| F8 | 中断当前轮次 | session.cancel | 任意会话（显式停止按钮） |
| F9 | 断线重连 + 状态自愈 | 重开 WS + 重拉 history | 参考项目同款 |

### 3.2 P1 — 智能体控制面（"本地端所有功能"的主体）

| # | 功能 | DSH API | 说明 |
|---|---|---|---|
| F10 | 模型选择器（提供方→模型→思考强度） | session.models（目录）+ session.selectModel | 参考项目 composer controls 的 model 面板；强度=reasoningEffort |
| F11 | 计划模式开关 | `/plan`、`/plan off` 命令（session.prompt） | 或后续新增 plan 专用消息；当前投影从 history/mux 读 |
| F12 | 权限预设 | `/permissionPresets <name>` 命令 | workspace-write/ask、danger-full-access/never；当前值显示 |
| F13 | 中途介入（steer） | session.prompt {mode:'steer'} | 运行中插入引导消息 |
| F14 | 审批应答卡 | approvals/requested 帧 + POST /api/respond | allowed-once / rejected |
| F15 | 提问应答卡 | questions/requested 帧 + respond | 选项按钮 |
| F16 | 队列编辑（编辑/删除待处理消息） | session.updateQueue | 参考项目有对应 UI |
| F17 | 附件（图片/文件） | session.prompt content image 块 | 接口预留；DeepSeek 纯文本线路，见 §9 |

### 3.3 P2 — 增强

| # | 功能 | DSH API | 备注 |
|---|---|---|---|
| F18 | 会话改名 | session.rename | |
| F19 | 会话分叉 | session.fork | |
| F20 | 目标（goal）管理 | goal.create/edit/pause/resume/complete/clear | DSH 特有，桌面端重要功能 |
| F21 | 会话搜索 | session.search | |
| F22 | 任务状态可视化（todo/jobs） | mux `session/queue`、`session/jobs` 帧 | |
| F23 | 设备条目删除（无效设备清理） | `POST /devices/:id/revoke` | 服务器软删除（吊销），所有端同步消失；电脑重新登录自动重新注册回来（误删可恢复） |

## 4. 会话内容模型（渲染约定）

DSH 事件 → 手机渲染映射（bridge 不做二次投影，客户端自己 fold）：

| DSH 事件 | 渲染 |
|---|---|
| `user/message` | 用户气泡（text/image content） |
| `assistant/message` | 助手气泡（文本 + 内嵌工具调用声明） |
| `tool/call` + `tool/result` | 可折叠工具卡（名称/参数摘要/结果截断 500 字） |
| `assistant/chunk` | 流式追加到当前气泡（不落盘） |
| `turn/start` / `turn/end` | 轮次分隔线 |
| `todo/write` | 任务清单卡 |
| `plan/mode`、`permissionPresets/preset` | 会话头部状态条 |
| `goal/change` | 目标卡 |

**无状态原则**：进入会话 = `history(maxMessages≈20)` 建基线 → 订阅 mux 增量 →
chunk 仅存内存 → 离开/断线即弃，重进重拉。

## 5. 写权限模型（2026-08-15 修订）

**进入会话即可对话，与桌面 GUI 一致。无"获取控制权"动作。**

- 所有会话（本地既有 + 远程新建）对手机端均可读可写；
- DSH 的 `session.prompt` queue 语义天然安全：对运行中的会话发消息是排队（FIFO），
  不打断当前轮次；只有显式 `session.cancel`（UI 上的停止按钮）才中断；
- 会话完整性由 opaque id 不变式（docs/03 §2）+ relay 设备归属校验保障，
  与"写权限"无关；
- 手机端能力面收窄照旧：插件管理、settings/credentials 写面不存在。

## 6. 技术栈

- Kotlin + Jetpack Compose + Material 3（用户已确认）；
- OkHttp WebSocket + kotlinx.serialization（协议模型照 docs/02 手写）；
- DataStore（设备选择/白名单镜像）+ EncryptedSharedPreferences/Keystore（token）；
- minSdk 26；无 GMS 依赖（小米/vivo/OPPO/华为卓易通可用）；
- 前台服务 + 常驻通知保活（国内 ROM）；
- 服务器地址可配置（参考项目 AuthScreen 同款）。

## 7. 决策记录

| # | 决策项 | 结论 | 日期 |
|---|---|---|---|
| D1 | 写权限模型 | **进入会话即可对话**（与桌面 GUI 一致，无"获取控制权"动作）。安全靠：DSH queue 语义（发消息排队不打断）+ opaque id 不变式 + relay 设备归属校验 + 能力面收窄 | 2026-08-15 |
| D2 | 版本节奏 | P0 先行，P1 随后；P0 阶段架构按 P1 预留（协议层、composer 控制面、渲染模型） | 2026-08-15 |
| D3 | 附件 | 首版不做图片专用逻辑；**保留接口**（content 块支持 image 类型）。图片暂按普通文件处理；DeepSeek adapter 当前对 image 块显式拒绝（`UNSUPPORTED_CONTENT`），多模态上线后无需改协议即可启用 | 2026-08-15 |
| D4 | 代码位置 | 独立仓库，与 `dsh-remote` 同一根目录（`D:\p\dsh-mobile`） | 2026-08-15 |
| D5 | 协议风格 | 按 DSH 语义重新定义消息名（`sessions.*` 等），RemoteClient 骨架移植（重连/token 刷新/订阅逻辑照抄，消息类型重新映射） | 2026-08-15 |
| D6 | 无效设备删除（F23，2026-08-16 修订） | 删除 = 服务器吊销（`POST /devices/:id/revoke`，软删除）：revoked_at + 设备 token 全吊销 + 踢掉在线连接；`/devices` 过滤已吊销行。误删自愈：bridge 收到 4003 后清 token 重新注册（`findByDedupKey` 排除已吊销行 → 建新行）。手机端不落任何删除状态 | 2026-08-16 |
| D7 | 设备身份标识（2026-08-16） | `clientDeviceKey` = 机器稳定标识（Windows MachineGuid，退化为持久化随机 UUID），与电脑名/显示名解耦。改名只更新服务器同一行的 label（同 key 重注册时 updateLabel），不再产生僵尸行。旧版 exe 用 hostname 当 key 是历史僵尸的根因 | 2026-08-16 |

## 8. 两个"权限"概念（易混淆，明确区分）

**A. 操作权限**：手机能不能往某个会话注入 prompt/中断/切模型。
修订后：**进入会话即可对话**，与桌面 GUI 一致，无额外动作。

**B. 执行权限（DSH 沙箱预设，DSH 自身功能）**：agent 跑工具时的文件系统权限与审批策略。
三档 sandbox：`read-only` → `workspace-write` → `danger-full-access`（只能升级不能降级，
有审批策略配合：workspace-write 默认 ask、danger-full-access 默认 never）。
手机通过 `/permissionPresets <name>` 命令切换（F12），属于"设置权限"功能，且要求先有 A 权限。

两层正交：一个会话可以"手机有控制权 + 沙箱 workspace-write"，也可以"手机只读 + 沙箱 full-access"。

## 8. 依赖的前置桥接工作（bridge 端待实现）

| 消息 | bridge 现状 |
|---|---|
| sessions.run 增加 steer mode 与 image content | 需实现 |
| session.models / session.selectModel | 需实现 |
| session.updateQueue / session.rename / session.fork | 需实现 |
| goal.* | 需实现 |
| 命令通道（/plan、/permissionPresets） | 可走 sessions.run（已通），建议封装独立消息 |
| 审批/提问 rpcId 透传 | 已实现（移除 remoteOwned 限制即可） |

## 9. 附件与多模态（2026-08-15 调查结论）

- DSH 协议层已支持图片：`session.prompt` 的 content 块含 `image` 类型
  （PNG/JPEG/WebP/GIF，base64），DSH 另有持久附件服务（`dsh-attachment`）。
- **DeepSeek adapter 当前是纯文本线路**：`dsh-llm-deepseek` 在序列化前对
  image 块显式抛 `UNSUPPORTED_CONTENT`（"does not support image content"），
  不是静默丢弃——所以图片发过去会得到明确错误，符合"模型自己说读不了"的预期。
- 结论：协议接口照常预留（F17 接口化），DeepSeek 上线多模态后无需改手机端协议。
  手机端暂不发 image 块，文件走文本路径（用户口述路径 + agent 自己读盘）。
