# 移动端富内容渲染 + 下行瘦身 方案（v1，2026-09-18）

> 目标：让手机端能"看到并复制"PC 端 Agent 答复里的功能性内容（代码块、工具输出、待办、产物…），
> 同时把"传了但手机根本不显示"的字节砍掉。
> 本文件是施工依据；实测数据与脚本见文末「复现方式」。

---

## 0. 实测结论（本机真实数据）

### 0.1 为什么代码段在手机上"体现不出来"（三层根因）
1. **DSH 数据模型里没有"代码块"类型**：代码是 `assistant/message` 里 `text` 块中的 Markdown 围栏（```lang … ```）。PC 上的"代码卡片 + 复制按钮 + Shiki 高亮"是**前端渲染器**的产物。
2. **App 端纯文本渲染**：`textOf()` 只把顶层 `type=="text"` 的块拼成字符串，用 Compose `Text` 显示；工程无任何 Markdown/高亮库 → 围栏、标题、表格原样显示；无等宽、无高亮、无分块复制（仅长按复制整条消息）。
3. **桥端投影有截断且其中一处是死代码**（见 0.3）。

### 0.2 工具输出：**传了但一个字都不显示**
- 真实结构（日志 + 实时 API 双向确认）：`data.message.content = [{ type:"tool-result", toolCallId, content:[{type:"text", text}] }]`
- App 的 `textOf()` 与桥的 500 字符截断**都只判断顶层 `type=="text"`** → 都取不到 → App 那条 item 根本不上屏（`txt.isBlank() && images.isEmpty()`）。

### 0.3 死代码确证
- `bridge/adapter.js` 的截断规则 + `scripts/smoke-dsh-v2.mjs` 的夹具用的是**扁平形状** `content:[{type:"text"}]`（与真实 DSH 不符）→ **测试假绿、生产从未生效**。
- 实测：`tool/result` 事件 4277 条，顶层 text 块 **0 个**；嵌套 text **8267 KB**，其中 >500 字符 1798 个，最大单块 49 KB。

### 0.4 下行体积实测（真实 DSH 一页：200 条消息 / 1037 记录 / 3952 KB）

| 事件类型 | 条数 | 体积 | 占下行 |
|---|---|---|---|
| `assistant/message` | 182 | 3078 KB | **77.9%** |
| **`tool/result`（手机上 100% 不显示）** | 188 | **576 KB** | **14.6%** |
| `tool/call` | 189 | 169 KB | 4.3% |
| 其它（request/header、step/*…） | — | ~130 KB | ~3.2% |

**"传了但不显示"占比**：本页 `tool/result` 14.6% + `reasoning` 11.4% = **26.0%**；
整会话口径（占桥实际下发体积）：`tool/result` **23.7%~29.0%**、`reasoning` **11.2%~14.9%** → **合计 ≈38%~40%**。

### 0.5 已确认无需处理的
- `assistant/chunk`（流式增量，占事件体积 21%~24%）**桥已经丢弃** ✓
- `assistant/message` 内 reasoning 占 content 字节 **63%~70%**（会话 A/B 实测）

---

## 1. 施工方案

### 1.1 桥端（先做，改动小、立刻见效）

| 编号 | 内容 | 预计收益 | 状态 |
|---|---|---|---|
| **B1** | **历史 + 实时双向剥离 `assistant/message` 里的 `reasoning` 块** | 事件体积 −11%~15%，assistant 消息 −2/3 | 待做 |
| **B2a** | **修正 `tool/result` 截断层**：按真实嵌套结构截断内层 `tool-result.content[].text`（默认前 500 字符 + `…[截断]`） | −14%~29% | 待做 |
| **B2b** | **新增摘要字段**（additive）：`data.toolSummary = { callId, name?, bytes, truncated, preview }`；新 App 读它渲染工具卡片 | 功能（老 App 无感） | 待做 |
| **B2c** | **新增 `toolResult.full` 请求**：按 `{sessionId, seq}` 返回完整工具输出；桥内 LRU 缓存最近若干条全文（含字节上限），未命中则回 `not-cached` | 功能（按需拉，不占常态带宽） | 待做 |
| **B4** | （可选）`request/header`、`agent/inbox/spliced`、`compaction/*` 摘要化 | −2%~3% | 暂缓 |

### 1.2 App 端（原生 Compose，方案 C 已废弃）

| 编号 | 内容 | 状态 |
|---|---|---|
| **A1** | 修 `textOf()`/`imagesOf()` 层级 → 工具输出可显示（摘要 + 展开全文 + 长按复制）；兼容老桥的原样嵌套（全文） | 待做 |
| **A2** | **代码块渲染**：解析三反引号围栏 → 等宽字体 + 灰底卡片 + 每块「复制」按钮 + 长代码折叠 | 待做 |
| **A3** | **工具卡片**：工具名 + 参数摘要 + 输出摘要 + 退出码/diff（参数里有则渲染） | 待做 |
| **A4** | 已到手机但被忽略的事件卡片化：`todo/write`、`deliverables/presented`、`plan/mode`、`goal/change`、`compaction/summary` | 待做 |
| ~~A5~~ | ~~reasoning 折叠展示~~ | **不做**（用户决策：手机不需要） |
| **A6** | （可选，最后）流式输出：仅会话页订阅时开、~200ms 合并转发 `assistant/chunk` | 暂缓 |

### 1.3 执行顺序
1. B1 + B2a/B2b/B2c（桥端）→ 全量 smoke + 热重载验证
2. A1 + A2（App）→ 模拟器验证（工具输出可见 + 代码可复制）
3. A3 + A4
4. 兼容性回归（见 §3）→ 发布（APK 0.2.14 / 插件 beta.22）
5. B4 / A6 视反馈再定

---

## 2. 兼容性铁律（必须遵守）

1. **只增不减（对老 App 而言）**：
   - ✅ 删除老 App 不渲染的字节（reasoning、被忽略事件）——老 App 本来就不显示，**无感**；
   - ✅ 新增字段（`toolSummary`）——老 App `ignoreUnknownKeys` 已开，**忽略**；
   - ❌ **绝不把工具输出扁平化成顶层 `text` 块**——老 App 的 `textOf()` 会抓走它，导致老 APK "突然开始显示半截输出"（行为变更）。摘要必须走新字段。
2. **新 App 必须兼容老桥**：
   - 请求 `toolResult.full` 若返回 `{ok:false,error:{code:"UNSUPPORTED"}}` → **静默降级**（只显示已有摘要，隐藏"查看全文"）；
   - 同时解析两种 `tool/result` 结构：老桥的原样嵌套（全文可直接展开）与新桥的摘要字段。
3. **老 App 实际只消费 8 种事件**（据此判断影响面）：
   `user/message`、`assistant/message`（仅顶层 text/image 块）、`tool/call`、`tool/result`、`turn/start`、`turn/end`、`plan/mode`、`session/queue`。
   其余（`request/header`、`agent/inbox/spliced`、`compaction/*`、`todo/write`、`deliverables/presented`、`goal/change`…）App 全文未引用。
4. 队列数据来自 `session/control` 流（不是 `agent/inbox/spliced`）——摘要化不影响 QueueDock。
5. E2EE / relay / 鉴权链路**不动**。

---

## 3. 验证清单

| # | 验证 | 方法 | 通过标准 |
|---|---|---|---|
| V1 | 桥端全量 smoke | `smoke-dsh-v2` / `smoke-dsh-legacy` / `smoke-host-token` / `smoke-e2ee-restart` | 全绿；**含修正后的 tool/result 夹具断言**（真实嵌套形状） |
| V2 | B1/B2 实测 | `probe-downlink.mjs`（真实 DSH 一页）+ 桥日志 | reasoning 块为 0；tool/result 内层文本 ≤500+标记；下行体积下降 |
| V3 | 老 APK × 新桥 | 装机版 APK 连热重载后的桥 | 会话列表/历史/发送/审批/提问/图片/长按复制全部正常；无空白、无异常 |
| V4 | 新 APK × 老桥 | 保留旧桥副本连新 APK | 工具输出降级正常、无 `UNSUPPORTED` 弹错 |
| V5 | 功能验收 | 模拟器 | 代码块可复制；工具输出可见并可展开全文；待办/产物卡片出现 |

---

## 4. 复现方式（调研脚本，均为本地只读）

| 脚本 | 作用 |
|---|---|
| `D:\p\pw-check\probe-downlink.mjs` | 取真实 DSH 一页 `session/page`，统计事件构成与"传了但不显示"占比 |
| `D:\p\pw-check\analyze-session.mjs` | 会话日志（多 frame zstd）逐帧解析：事件/流记录分类、reasoning 占比、体积演进 |
| `D:\p\pw-check\analyze-toolresult.mjs` | 验证 `tool/result` 层级与 500 字符截断是否生效 |

> 会话日志位置：`C:\Users\zdx86\.dsh\sessions\<cwd 编码>\<sessionId>\session.jsonl.zstd`（上万独立 zstd frame 顺序拼接，需逐帧解压）。
