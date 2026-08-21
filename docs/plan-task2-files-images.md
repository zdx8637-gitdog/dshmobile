# 任务 2 执行计划：文件/图片上传 + 图片回显（手机 ↔ PC）

> 状态：**计划定稿，待谷电时段执行**。本文件是执行蓝图，执行时按 Phase 顺序推进，
> 每个 Phase 有验收标准；预研清单（§6）可在任何时段零成本完成。

## 0. 已验证的事实基础（2026-08-19 实测）

| 事实 | 结论 |
| :-- | :-- |
| DSH 附件体系：`ImageBlock` 角色中立（用户/助手消息、工具结果均可携带），png/jpeg/webp/gif | 类型层完备 |
| Web UI 渲染管线：`dsh-client-ui-attachment`（缩略图轨道/画廊/灯箱 + `resolveImage`） | UI 层完备 |
| Web 界面显示图片实测（Markdown + 本机 HTTP，banner 清晰可见） | ✅ Agent→Web 看图可行 |
| 生产适配器输出纯文本（assistant 侧图片为 forward compatibility），无内置截图工具 | 差距=缺工具，非缺管线 |
| **手机够不到 PC 的 127.0.0.1**——Web 界面的 Markdown 图片技巧对手机无效 | 手机图片必须经 relay 中转字节 |
| Task 1 已落地：transfer 传输（announce/分块 PUT offset 强校验/complete/download）+ bridge 投递（workspace 落盘） | 复用，方向只有 user→device |

## 1. 目标与范围

1. **上传（手机 → PC）**：照片/相册/任意文件（微信分享等）→ relay 分块上传 → bridge 落盘到 workspace → 进入 DSH 会话可用；
2. **回显（PC → 手机）**：会话消息/工具结果中的图片（用户发的、截图工具的、未来的助手图）在手机 App 里直接渲染显示；
3. 复用 Task 1 的传输通道，**控制面/数据面分离原则不变**。

## 2. Phase 划分（执行顺序）

### Phase A：上传主链（最大价值，先行）

**A1. 协议增量**（`docs/02-protocol.md` §7 追加）：
- 上传方向复用现有端点，无需改动：
  `POST /transfers`（announce，用户 token）→ `PUT /transfers/:id/chunks`（X-Chunk-Offset）→
  `POST /transfers/:id/complete` → relay 控制面 `transfer.deliver` → bridge 落盘；
- 新增控制面请求：`upload.commit`（client → bridge）：
  ```json
  { "kind": "request", "type": "upload.commit", "requestId": "…",
    "payload": { "transferId": "…", "fileId": "…", "name": "…", "size": 123,
                 "sha256": "…", "targetPath": "docs/test.pdf", "sessionId": "…|null" } }
  ```
  响应：`{ ok: true, data: { path, messageId? } }`——bridge 落盘后**决定如何进入会话**（见 A3）。

**A2. Android 上传面**：
- 入口三合一：相册选图、拍照、系统分享 Intent（`ACTION_SEND`，微信/文件管理器等）；
- 上传页：设备选择（默认当前选中设备）→ 目标路径（默认 workspace 根/docs/）→ 进度条（分块进度）→ 断点续传（记录 transferId + offset，失败可续）→ 完成回执；
- 网络层：`CloudApi` 新增 `transfers.announce/putChunk/complete`（OkHttp 流式 body 上传）；
- 依赖：图片压缩（长边 ≤2048，JPEG q80——附件限额内）→ 需评估引入 Coil/自写压缩；minSdk 26 无 GMS。

**A3. bridge 落盘后的「进入会话」路径（两级策略，2026-08-19 定稿）**：

- **L1（默认）——落盘自取**：落盘 + 回执带绝对路径；手机若带 `sessionId`，
  bridge 向该会话发一条 `sessions.run` 文本消息「已上传 <name> → <path>」——任何模型
  （含视觉与纯文本）都能顺着路径用工具读文件。零依赖、无附件限额、今天可用。
- **L2（增强，可配置开关，默认关）——图片直达视觉模型**：bridge 经 DSH 公开/Web 同款
  附件 API 把图片登记为 attachment，再以 `[{type:"text"...},{type:"image",attachment:{...}}]`
  注入 `session.prompt`，视觉模型无需工具调用直接看到。
  **启用前提（侦查门禁）**：① DSH 附件上传/读取存在公共 API 且可被 bridge 调用；
  ② 会话当前模型声明 image 输入。二者缺一不启用。
- **L1 与 L2 关系**：L1 是保底主线；若侦查发现 DSH 文件读取工具对图片返回 image 块
  （tool-result 带图），则 L1 本身即视觉原生，L2 可永久搁置。
  反之（工具只返回路径/文本），L2 才有决定性价值。

**验收**：手机发一张照片 → PC workspace 出现文件 → DSH 会话里能看到提及（L1）；全部断网重试一次成功（续传）。

### Phase B：图片回显（PC → 手机）

**B1. 反向传输设计**（复用 Task 1 通道，加 device→user 方向）：
- bridge 是上传方：bridge 持有用户 accessToken（账号模式从 config、授权模式从 session）→ 以用户身份
  announce → 分块 PUT → complete，`direction: "download"`；
- 新增**用户侧下载端点**：`GET /transfers/:transferId/download` 接受用户 Bearer token（owner 校验），
  与设备 token 下载并存；
- 新增控制面请求：`attachment.resolve`（client → bridge）：
  ```json
  { "type": "attachment.resolve",
    "payload": { "sessionId": "…", "attachmentId": "…" } }
  ```
  响应：`{ ok: true, data: { transferId, width, height, mediaType, bytes } }`——
  bridge 内部：读 DSH 附件存储 → 算 sha256 → announce+上传到 relay spool → 返回 transferId；
- relay 侧懒缓存：同 attachmentId 已有未过期 spool → 直接复用 transferId（避免重复上传），TTL 默认 10 分钟；
- 手机端：`GET /transfers/:transferId/download`（用户 token）拉字节 → 内存/磁盘缓存（attachmentId 键）→ 渲染。

**B2. 手机渲染**：
- `ChatItem` 增加 `Image` 类型：历史/流式事件的内容块解析（`user/message` 与 `tool/result` 的
  content 数组中的 `type:"image"` 块）——当前 `textOf` 会丢弃，需重构为块级解析；
- 渲染组件：网格缩略图（多图 tile）、点按全屏（捏合缩放）、加载失败重试、会话内缓存；
- 流式到达的 image 块：先占位后懒加载。

**B3. 截图工具配套（可选，验证闭环）**：
- 桌面端装 `dsh-browser-playwright`（或 PowerShell 截图脚本）→ Agent 产出截图 → 工具结果带图；
- 手机能看到该截图 = 完整对标 Codex 的「Agent 截图给用户看」。

**验收**：手机发图 → 会话历史里看到自己发的图；桌面端触发一次带图工具结果 → 手机上看到该图。

### Phase C：打磨
- 上传队列（多文件）、失败分类重试、大文件进度（MB/s 显示）、缩略图预生成；
- 回显缓存策略（磁盘 LRU）、附件过期清理、流量提示（移动网络确认）；
- 错误码对齐（手机端对 relay 409 offset / 422 checksum 的恢复动作）。

## 3. 协议文档增量清单（执行时落到 `02-protocol.md`）

1. §7.2 表新增：`GET /transfers/:id/download` 用户 token 面（owner 校验）；
2. §7.4 新增信封：`upload.commit`、`attachment.resolve`（请求/响应格式）；
3. §7.5 新增：反向传输方向语义、懒缓存 TTL、附件大小/格式限制（沿用 dsh-attachment 限额）。

## 4. relay 侧改动清单（Task 1 基础上）

| 改动 | 说明 |
| :-- | :-- |
| 下载端点双鉴权 | `verifyDeviceToken` 或 `verifyAccessToken` + owner 校验（transfer.userId === userId） |
| 懒缓存 | attachmentId → transferId 映射（内存 Map + TTL，重启即失效可接受） |
| 进度事件 | bridge 上传时的 transfer.progress 已支持（fanout）——上传方向手机侧进度由 HTTP 返回的 received 驱动，无需改 |
| 测试 | 新增：用户 token 下载 owner 隔离、懒缓存复用、TTL 清理 |

## 5. bridge 侧改动清单

| 改动 | 说明 |
| :-- | :-- |
| `upload.commit` 处理 | 校验 transferId/大小/哈希（relay 已校验，桥复核文件已落盘）→ 按 §A3 路径进会话 |
| `attachment.resolve` 处理 | 读 DSH 附件字节（侦查 §6-1 决定读法）→ sha256 → 用户身份 announce/上传 → 回 transferId |
| 上传为 bridge 侧上传函数 | 复用 fetch 流式 PUT 分块（4MB/块），支持续传（先 GET 状态拿 received） |
| 路径安全 | 沿用 `resolveInRoot`（已测 9/9） |

## 6. 预研清单（侦查项——不写代码，谷电前可完成）

1. **DSH 视觉链路实态（最高优先级，决定 L1/L2 取舍）**：
   ① 桌面 DSH 用视觉模型开一个带图会话，抓 history 看 `user/message` 中 image 块的
   wire 形态；② 让 agent 读一张图片文件，抓 `tool/result` 的返回形态——返回 image 块
   （视觉原生）还是路径/文本（需 L2）；③ DSH 附件上传端点的公共面（Web UI 同款）。
2. **history 事件里 image 块的 JSON 实态**：用一个带图会话抓 history，确认
   `user/message` 与 `tool/result` 的 content 数组结构（bridge 目前 `textOf` 丢图）；
3. **工具结果带图的实态**：装截图插件后抓一个 tool/result 事件样本；
4. **视觉模型可用性**：当前 adapter 列表里哪些声明 image 输入（决定路径 2 的优先级）；
5. **Android 图片依赖选型**：Coil vs 自写（minSdk 26、无 GMS、包体积）；
6. **附件限额数值**：dsh-attachment 的 maxImageBytes/maxImagesPerMessage 默认值（手机压缩参数依据）。

## 7. 明确的「不做」

- 不做大文件点对点直传（NAT 打洞），全部走 relay 中转；
- 不做视频/任意二进制预览（仅图片渲染，其余文件只传不显）；
- 不在本 Phase 做 E2EE（任务 3 独立推进，加密层设计已预留：spool 字节加密不影响控制面）。

## 8. 成本提示（执行时段）

- 谷电时段建议按 Phase A → B 顺序执行；每 Phase 完成后跑 relay 测试套件 + 单机冒烟；
- 发布节奏：Phase A 完成发手机 0.1.4 + 插件 beta.8（relay 已在生产）；Phase B 完成发 0.1.5 + beta.9。
