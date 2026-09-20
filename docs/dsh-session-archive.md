# DSH 会话"归档"机制与一次误归档事故复盘（2026-09-20）

> 本文记录：**DSH 的归档集合是怎么工作的**、**一次把"正在使用的会话"误归档的事故全过程**、
> **如何恢复**，以及为此加固的脚本与检查清单。面向后续接手的人/智能体，避免重犯。
> 相关工具都在 `plugins/scripts/`（随 npm 包发布）。

---

## 1. 机制：归档集合只增不减，且**没有取消归档**

| 事实 | 证据/出处 |
|---|---|
| 归档会话在 GUI **主列表里被隐藏** | 前端 `dsh-client-ui-workspace`：`state.archivedSessionIds` + `archived.includes(...)` 过滤；菜单只有 `menu.archiveSession` |
| 唯一的归档接口是 `archiveSession`（**append**） | 宿主实现 `dsh-client-connection/lib/client.js`：`archivedSessionIds.push(request.sessionId)`；客户端服务 `IWorkspaces` 也只暴露 `archiveSession(sessionId)` |
| **没有** unarchive / restore 接口 | 全仓检索 `unarchive|restoreSession` 无命中；前端也没有"已归档"分组或恢复入口 |
| 也**没有**"重新加载工作区"接口 | 检索 `reloadWorkspace|workspace/reload|reloadRegistry` 无命中 |
| 归档集合是**宿主进程内存**里的权威状态 | `workspaceRegistry.archivedSessionIds`；GUI/桥都通过 `workspace/follow` 基线的 `{items, archivedSessionIds}` 取值 |
| 持久化在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` | 该文件在宿主状态变化时被写回；**只在 DSH 启动时读取** |
| 会话日志本身与会话列表无关 | `~/.dsh/sessions/<工作区分桶>/<sessionId>/session.v3.jsonl.zstd`（持续追加；归档**不删数据**） |

### 由此推出的关键结论

1. **改 `workspace.json` 不会影响正在运行的 DSH** —— 宿主内存态优先，必须**重启 DSH**（`dsh web`）才会从磁盘重载；
2. **重启前不要在 GUI 里做任何归档动作** —— 宿主会把它的内存态写回文件，覆盖你手工做的修改；
3. 判断"改文件到底生效没"的**权威方法**是读宿主内存态，而不是看文件：用
   `node scripts/probe-session-archive.mjs <sessionId>`（走与桥相同的 `workspace/follow` 订阅）。

---

## 2. 事故复盘：我把用户**正在使用的会话**归档了

### 经过（时间线）

| 时刻 | 动作 | 结果 |
|---|---|---|
| 18:0x | 跑 `node scripts/verify-history-projection.mjs`（**没带 sessionId**，想"对真实 DSH 做只读投影校验"） | 脚本内部当时是 `const target = sessions.find(...) ?? sessions[0]` —— **列表第一个＝最新活跃会话**，也就是用户**当前正在对话的那个会话**；打印 `session: session-ef6cba06-…` |
| 18:07 | 我误以为那是"探针自己创建的临时会话"，执行 `node scripts/archive-session.mjs session-ef6cba06-…` | `✅ 已归档 session-ef6cba06-…`；该 id 进入 `global.archivedSessionIds`（第 23 条）；`workspace.json` mtime = 18:07:10 与归档时刻吻合 |
| 之后 | 用户在 PC 端反馈 **"pc 端找不到你了"** | 因为归档会话在 GUI 主列表被隐藏 —— **注意：只有 PC GUI 隐藏**，桥的 `sessions.list` 并不过滤归档，所以**手机 App 里一直能看到并打开这个会话**（事后日志证实：手机 `android-vmw9j` 一直在读 `sessions.list` / `session-ef6cba06…` 的历史）。"看不见"仅限 PC GUI 的列表 |
| 排查 | `pw-check/check-my-session.mjs`：定位到 `session-ef6cba06…` 属于工作区 `D:\p`（workspace id `dd3c2f98-…`）且**在归档集合里**；对比 `~/.dsh/sessions/--D-p--/` 的写入时间，确认它正是**正在实时写入**的会话（日志 21 MB，mtime 持续更新 ⇒ 数据没丢，只是被藏） | 结论：不是数据损坏，是"可见性"问题 |

### 根本原因（三条，都在我这边）

1. **探针脚本的默认目标选择**：`?? sessions[0]` —— 不带参数时选中"最新活跃会话"。这类只读探针**绝不该默认碰用户正在用的会话**；
2. **我把探针的输出当成了"它自己建的临时会话"**，没有核对"这个 id 是不是正在被写入"就归档；
3. **归档脚本当时没有任何护栏**（没有"活跃会话禁止归档"的检查）。

---

## 3. 恢复过程（可复用）

```powershell
# 1) 先确认现状：该会话是否在归档集合、是否仍在写入
node scripts/unarchive-session.mjs --list          # * = 最近 10 分钟仍在写入（= 可能正在使用）
node D:\p\pw-check\check-my-session.mjs            # 逐条核对"是否已归档 / 属于哪个工作区"

# 2) 改状态文件把它移出归档集合（自动备份 workspace.json.bak-<ts>）
node scripts/unarchive-session.mjs session-<id>

# 3) 用"宿主内存态"确认是否还需要重启（关键一步）
node scripts/probe-session-archive.mjs session-<id>
#   宿主仍视为已归档 → 必须重启 DSH；宿主已不含它 → 刷新页面即可

# 4) 重启 DSH（dsh web），宿主从磁盘重载；会话重新出现在工作区列表（历史完整）
```

本次实况：第 2 步 23 → 22 条（移除成功，备份 `workspace.json.bak-1789900001908`）；
第 3 步当时显示**宿主仍是 23 条**（内存态未重载）→ 结论是"必须重启"；
**用户重启 DSH 后实测**：宿主内存变为 **22 条 = 磁盘一致**，`probe-session-archive.mjs <id>` 报
"宿主视为已归档：否 ✅"，会话回到 `D:\p` 工作区列表；日志内容完好（归档从不删数据）。
旁证宿主确实重启：监听 3080/17653 的 node 进程 PID 与启动时间变化，且面板 `bridgeVersion`
从 `0.1.0-beta.22` 变为 `0.1.0-beta.23`（宿主重启时会重新读 `package.json`）。

> 如果你只想"暂时还能聊"，其实不必立刻重启：**手机端一直能打开它**（桥不过滤归档），
> PC GUI 的列表才会隐藏。

---

## 4. 加固（已落地并实测）

| 工具 | 变更 | 实测 |
|---|---|---|
| `scripts/verify-history-projection.mjs` | 默认**跳过最近 10 分钟仍活跃的会话**；要用活跃会话须显式给 id + `--allow-live`；并打印"本次只读分析目标 + 只读不写状态" | ✅ 无参数运行时自动改判到旧会话 |
| `scripts/archive-session.mjs` | **默认拒绝归档活跃会话**（`--force` 才允许）；新增 `--list`（`*` 标活跃）、`--newest-idle`（只清理闲置会话） | ✅ 对活跃会话被拒：`拒绝：… 在 1s 前仍在写入…`（退出码 1） |
| `scripts/unarchive-session.mjs`（新） | DSH 无取消归档接口 → 本脚本改状态文件（带备份）并提示需重启；对活跃会话只**提示**不拦（取消归档是安全动作） | ✅ 已用它完成恢复 |
| `scripts/probe-session-archive.mjs`（新） | 读宿主内存归档集合（桥同款 `workspace/follow` 路径），并对比磁盘文件差异 | ✅ 给出"宿主 23 / 磁盘 22 ⇒ 未重载"的判定 |
| `pw-check/check-my-session.mjs` | 定位当前/指定会话的归属与归档状态 | ✅ 事故排查时用它定位 |

### 加固过程中我自己又踩的两个坑（一并记录，说明"护栏本身也要验证"）

1. **护栏静默失效**：第一版用"脚本自己的 `process.cwd()`"推算会话分桶（`--D-p--`）——但 DSH 的分桶取决于**会话自己的工作目录**；在 `dshmobile-plugin` 目录下运行时算成了 `--D-p-dshmobile-plugin--`，找不到日志 → 活跃会话被误判为"闲置"而放行。
   **修正**：在 `~/.dsh/sessions` 的**各分桶下直接搜该会话的日志文件**，不推算。
2. **文档注释把文件搞坏**：给脚本写说明时 JSDoc 里出现了 `*/<sessionId>`，其中 `*/` **提前结束了块注释** → 文件语法错误。
   **修正**：注释里不出现 `*/` 字面量（写"各分桶"），改完立刻 `node --check`。

---

## 5. 检查清单（以后要清理临时会话时照做）

1. 先 `node scripts/archive-session.mjs --list` 看清哪些是活跃的（带 `*`）；
2. 只清**非活跃**的：`node scripts/archive-session.mjs --newest-idle`（或显式给一个旧会话 id）；
3. 绝不 `--force` 归档你正在用的会话；真要归档自己，先确认你已经不需要在列表里找到它；
4. 归档后若发现"藏错了"：按 §3 恢复（改文件 + `probe-session-archive.mjs` 判定 + 必要时重启 DSH）；
5. 只读探针（`probe-real-dsh.mjs` / `verify-history-projection.mjs` / `probe-session-archive.mjs`）**只读不写**；任何写操作前先确认目标 id 不是你自己的会话。
