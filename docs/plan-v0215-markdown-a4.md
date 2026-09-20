# v0.2.15 施工规格：Markdown 渲染（A2c）+ 事件卡片（A4）

> 交接文档。上下文压缩/新会话后，读本文 + `WORKFLOW.md` §7 即可直接开工。
> 决策来源：用户 2026-09-18 拍板 —— ①工具卡只删「复制」按钮（已改源码）；②Markdown **一步到位**（引库，自研扩展不做）；③**0.2.15 一次包含 A2c + A4**（不拆两个版本）。

---

## 0. 当前状态（开工前必读）

- **线上 APK = 0.2.16**（A2c Markdown + A4 卡片 + A3 工具卡归并 + 工具卡去掉复制按钮）；`https://www.deepseek-claudex.cn/dshmobile/DSH-Mobile-0.2.16.apk` 已校验 HTTP 200 且 sha256 与本地一致；落地页 index/pair 均已指向 0.2.16。
- **已完成**：
  - ✅ 工具卡「复制」`TextButton` 删除（查看全文、长按复制保留）；
  - ✅ A4：`RichCards.kt`（`todoItemOf`/`deliverableItemOf`/`noteOf` + `TodoCard`/`DeliverableCard`/`NoteRow` + `dedupeTodos`）接入实时/历史/渲染三处；
  - ✅ A2c：`com.halilibo.compose-richtext:richtext-commonmark`/`richtext-ui-material3` **0.20.0**（catalog 键 `richtext`），`MarkdownBlock()` 渲染非代码段；代码块仍用自研 `CodeBlock`（复制/等宽/折叠）；
  - ✅ A3：`mergeToolCards()` —— 按 `callId` 把 `tool/result` **就地并进** `tool/call` 那张卡（实时与历史重建都走同一纯函数）。边界已覆盖：结果找不到对应调用→独立结果卡；并行/乱序→各归各；调用无结果→保持只有命令；同 call 多结果→后者覆盖；
  - ✅ 单测 `RichContentParseTest` **21/21**、`E2eeCryptoTest` 3/3；`assembleRelease` 成功（APK 12.95 MB）。
- **回归结果**：
  - T4 老 APK(0.2.13) × 新桥 → 会话正常渲染、无崩溃 ✅
  - T5 新 APK(0.2.15) × 老桥（`git show fc71465^:plugins/bridge/adapter.js` 还原的旧代码桥）→ 工具输出正常显示全文、**无 `UNSUPPORTED`**、无崩溃 ✅
  - T3 视觉：临时第二桥 + 模拟器验证工具卡、历史加载、可见节点无 `**`/`#`/`- ` 原始标记；**Markdown 排版细节建议真机确认**
- **可选后续**：`tool/result` 的 `data.meta`（如 `dsh-tool-fs` 的 result-time diff）可用于渲染 diff 卡片——数据结构已确认存在，未实现。
- **测试环境已清理**：临时桥进程、`.dsh-mobile-test`/`.dsh-mobile-oldbridge`/`oldbridge-test`、测试设备（DSH Bridge TEST/OLD）均已清除，正式设备未受影响。
- **遗留小项**：`ToolCard` 中已无用的 `val context`（仅告警）；npm 发布 `0.1.0-beta.22` 由用户执行。

---

## 1. A2c：Markdown 一步到位

### 1.1 为什么必须做（实测频次，单会话 assistant 正文）
| 语法 | 会话 A | 会话 B |
|---|---|---|
| 粗体 `**x**` | 4025 | 2254 |
| 行内代码 `` `x` `` | 2485 | 2700 |
| 表格 `\|` | 1428 | 792 |
| 无序列表 `- ` | 1135 | 785 |
| 标题 `#` | 898 | 625 |
| 有序列表 `1.` | 726 | 529 |
| 围栏代码块（已支持） | 110 | 414 |
| 引用 / 链接 / 分割线 | 62 / 28 / 23 | 46 / 40 / 26 |

→ 现状：除围栏代码块外**全部原样显示**（用户实测看到 `-**本地已生效**：`）。统计脚本：`D:\p\pw-check\census-markdown.mjs`。

### 1.2 选型（已定：引库，自研不扩展）
| 方案 | 坐标 | 备注 |
|---|---|---|
| **首选** `compose-richtext` | `com.halilibo.compose-richtext:richtext-commonmark`（+ `richtext-ui-material3`） | 基于 `org.commonmark`，支持标题/粗体/行内代码/列表/引用/表格/链接；代码块可自定义渲染器 |
| 备选 | `com.mikepenz:multiplatform-markdown-renderer*` | 基于 JetBrains markdown，含表格扩展；样式定制弱一些 |

> 联网时先查最新稳定版并写入 `gradle/libs.versions.toml`（本项目用 version catalog，见 `app/build.gradle.kts` 的 `libs.*` 引用风格）。

### 1.3 集成点（文件级）
| 位置 | 改动 |
|---|---|
| `gradle/libs.versions.toml` + `app/build.gradle.kts` | 新增依赖（版本目录 + `implementation`） |
| `ConversationScreen.kt` → `RichText(text)` | **替换为 Markdown 渲染**；`splitCodeFences` 保留为**纯文本降级兜底**（库初始化失败/异常时回退） |
| `ConversationScreen.kt` → `CodeBlock` | 决定：库自带代码块 or 继续用我们的 `CodeBlock`（**必须保留「复制」按钮** —— 用户核心诉求）。若用库的渲染器，需在其 code block 回调里挂我们的复制按钮 + 等宽字体 + 超行折叠 |
| `Bubble` 的长文防护 | **必须保留** `LONG_LIMIT=2000` / `HARD_LIMIT=20000` 策略（或改为按消息末尾分块懒渲染），否则大会话会卡（历史上有过"超长回复刷新卡死"的事故） |

### 1.4 验收（视觉）
粗体、行内代码、无序/有序列表、标题、引用、分割线、链接（可点）、表格（可读）、围栏代码块（等宽 + 复制 + 折叠）在手机上均正确渲染；长消息（>2000 字符）点击仍能展开且不卡顿。

---

## 2. A4：把"手机端没显示"的事件做成卡片

桥已转发这些事件，**纯 App 端渲染**（不改桥、不改协议）。

### 2.1 已实测/已查证的真实结构（2026-09-18，三份真实会话日志 + DSH 类型定义）

| 事件 | 真实 data 结构 | 出现频次（样本会话） |
|---|---|---|
| `todo/write` | `{ todos: [{ content: string, status: "pending"\|"in_progress"\|"completed" }] }` | 35 / 49 / 7 次 |
| `goal/change` | `{ kind, version, operation, goal: { id, revision, objective, phase, maxGoalRounds, blockedReason? }, roundsStarted, createdAt, updatedAt, cleared, clearedAt }` | 43 / 17 次 |
| `compaction/summary` | `{ compactionId, summary: [{type:"text",text}], shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens, usage }` | 8 / 4 / 3 次 |
| `deliverables/presented` | `{ turn: number, callId: string, files: [{ path: string, description?: string }] }`（来自 `@deepseek-ai/dsh-tool-present` 类型定义；三个样本会话中未出现，解析需容错） | 0（样本内） |
| `plan/mode` | `data.active: boolean` 已在使用；**计划正文结构未抓到样本** → 首步需抓样本或按 `{active, plan?}` 容错 | — |

> 抓样本脚本（只读）：`D:\p\pw-check\probe-a4-events.mjs <session.jsonl.zstd>`（逐帧 zstd 解压 + 按类型汇总 data 键与样例）。

### 2.2 卡片规格

| 事件 | 目标卡片 | 建议渲染 |
|---|---|---|
| `todo/write` | 待办清单 | `☑ 已完成` / `▶ 进行中`（高亮）/ `☐ 待办`；整卡可折叠（超过 6 条时默认折叠）；同会话重复出现时**原地替换**上一张（`todo/write` 是全量重写，不是增量） |
| `goal/change` | 目标进度条 | `operation` 决定文案（create/resume/complete/paused/blocked…）+ `goal.objective` 首行（截断）+ `phase` + `roundsStarted/maxGoalRounds`；`blockedReason` 有则红字一行 |
| `compaction/summary` | 一行提示条 | 只显示"上下文已压缩 · 折叠 N tokens"（`shadowedTokenCount`）；**绝不渲染 `summary` 正文**（很长且与已有内容重复） |
| `deliverables/presented` | 产物卡 | 每个 `files[i]`：文件名（`path` 末段）+ `description` + 点击复制完整路径；多文件列出前 N 个 + "还有 M 个" |
| `plan/mode` | 计划状态 | `active=true` 时一行提示"计划模式"（现有标记保留即可），拿到正文样本后再补文档卡 |

### 2.3 实现要求
- 解析逻辑写成**纯函数**（输入 `JsonObject?` → 输出数据类），进 `RichContentParseTest` 单测；
- 新增 `ChatItem` 子类型（如 `Todo` / `Goal` / `Deliverable` / `Note`），在 `when(item)` 中渲染；
- `todo/write` 需按会话**去重替换**（不能每次追加新卡片）；
- 卡片样式克制：`compaction` / `plan` 只用一行小字，不抢正文视觉；
- 与 Markdown 渲染共存时注意性能（todo 可能较长）。


---

## 3. 测试计划（0.2.15）

| # | 项目 | 方法 | 通过标准 |
|---|---|---|---|
| T1 | 纯函数单测 | 扩展 `app/src/test/.../RichContentParseTest.kt` | 新增 Markdown 前置处理、todo/deliverable/plan 解析断言全绿 |
| T2 | 构建 | `gradlew.bat assembleRelease testReleaseUnitTest` | BUILD SUCCESSFUL，全部单测通过 |
| T3 | 模拟器视觉回归 | **临时第二桥技巧**（见 WORKFLOW §7）：`DSHMOBILE_BRIDGE_CONFIG=<临时 config> node bridge/main.js` → 模拟器连它（独立设备、无 E2EE，不碰用户手机配对） | Markdown 各语法正确；代码块可复制；待办/产物卡片出现；长消息展开不卡 |
| T4 | 老 APK × 新桥 | 装 0.2.13/0.2.14 连当前桥 | 无异常、无空白（铁律：桥只增字段） |
| T5 | 新 APK × 老桥 | 保留旧桥副本或回退 adapter.js 运行 | 工具输出/代码块正常降级，不弹 `UNSUPPORTED` 错误 |

---

## 4. 发布步骤（0.2.15）

1. 版本号：`app/build.gradle.kts` → `versionCode = 26`、`versionName = "0.2.15"`；
2. 构建：`cd D:\p\dsh-mobile && gradlew.bat assembleRelease`；
3. 部署 APK：
   `cd D:\p\srv-tools && node run.mjs --put D:\p\dsh-mobile\app\build\outputs\apk\release\app-release.apk /opt/session-control-relay/web/dshmobile/DSH-Mobile-0.2.15.apk`
4. 落地页：
   `node run.mjs 'cd /opt/session-control-relay/web/dshmobile && sed -i "375s/0\.2\.14/0.2.15/" index.html && sed -i "s/0\.2\.14/0.2.15/g" pair.html'`
5. 校验：`Invoke-WebRequest .../DSH-Mobile-0.2.15.apk -Method Head` → 200；并比对本地/服务器 sha256 一致；
6. GitHub：同步仓库副本（App 不在 git，仅插件/文档）→ commit → push；
7. npm：本版本**不改桥**，无需再发插件包（若桥有改动另论）。

---

## 5. 坑与禁忌（血泪版）

1. **含中文的文件一律用 write/edit 工具**，严禁 PowerShell `Get-Content | Set-Content`（本会话已踩两次：README、package.json 描述串被 GBK 重编码破坏）。
2. **UI 验证用"临时第二桥"**，不要点面板「取消加密」——那会清掉用户手机的 E2EE 配对（用户需重新扫码）。
3. **别把工具输出扁平化成顶层 `text` 块**（兼容性铁律）：老 App 的 `textOf()` 会抓走并显示半截内容。
4. 桥的 `tool/result` 真实结构是 `data.message.content=[{type:'tool-result',content:[{type:'text'}]}]`（**嵌套**）——历史与实时都必须按这一层处理。
5. `git push` 依赖本机代理 `127.0.0.1:7890` 通 GitHub；不通时提交安全留在本地（`ahead N`），恢复后再推。
6. 会话日志是**上万个独立 zstd frame 顺序拼接**，Node 需按 magic(`28b52ffd`) 逐帧解压。
