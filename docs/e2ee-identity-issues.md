# E2EE 身份/配对问题调研（2026-09-12）

> 调研结论存档。触发症状：① 加密配对码 800s（900s TTL）过期后"token 对不上"；
> ② 手机取消 E2EE 后进入会话提示"该设备安全身份已变化，请重新扫码配对"。
> 本文档只记录结论与修复方向，未修改任何代码。

## 手机端提示的触发点（App 源码）

`RemoteClient.kt` 的 E2EE hello 握手，两条分支都会弹"该设备安全身份已变化"：

1. 桥 hello 响应里的 `keyId` ≠ 手机本地 pin 的 keyId（`E2eeSession.establishConnection` 返回 false）；
2. 桥回错误码 `key-mismatch`（桥未 pin 或 pin 与手机 keyId 不符）。

即：**桥的 `pinnedPeer` 被换/被清，或桥的身份密钥改变**，都会显示这条（文案把三类原因混为一谈）。

## 三种真实来源

### 1. 测试探针顶掉 pin（已确认，当前状态即此）

relay-probe / relay-live-test 多次执行 `key.exchange` 配对，把桥的 `pinnedPeer` 换成探针身份。
实测 `device-key.json` 中 `pinnedPeer.keyId = 9668c59367a665bb`（探针身份）。
此时手机任何 E2EE 连接都会收到 key-mismatch 提示；手机重扫面板②加密码即可恢复。
**约定：后续不再用探针做真实配对测试（改为只读验证或对仿 DSH 测试）。**

### 2. "取消加密"后的不对称

App `clearE2ee` 先清手机本地 pin，再发 `e2ee.clear` 给桥。若该请求因断线/时序丢失，
桥端 pin 残留 → 手机下次 hello 被桥回 `key-mismatch` → 显示同一条"身份已变化"。
属于提示文案误报：pin 被清 ≠ 身份变化，App 侧应区分。

### 3. 产品缺陷：桥身份密钥被宿主静默再生（核心）

`device-key.json` 由**两个进程**共同管理，且双方都有"文件坏就重新生成"逻辑：

- **宿主** `src/index.ts` `ensureIdentityKey()`：文件存在但 JSON 解析失败/字段缺失时，
  **重新生成新密钥对并覆盖文件**，且写入 `pinnedPeer: null`（清 pin）。
  加密码过期刷新（900s TTL）时会重新读取该文件。
- **桥** `bridge/e2ee.js` `#load()`：同样的"存在但坏 → 静默重生"逻辑。

竞态链：桥配对成功写文件（含 `pinnedPeer`）↔ 宿主刷新码读文件 → **撕裂读**（Windows 下
读到半截 JSON 的概率不低）→ 宿主解析失败 → 生成新密钥覆盖（pin 也清掉）。

后果（与用户症状逐条吻合）：

- **运行中的桥仍是旧密钥**，而新二维码 pk 是新密钥 → 手机扫码配对 auth 必然失败
  （"800s 过期后 token 对不上"）；
- **DSH 重启后桥加载新身份且 pin 已丢** → 手机 hello → key-mismatch → "设备安全身份已变化"。

## 修复实施记录（2026-09-20，其它用户升级后反馈后落地）

**触发**：其他用户反馈"**升级后刷新不出会话**"。⚠️ **2026-09-20 晚更正**：原文在这里写成"Android 端必须点一下「取消加密」才能刷新"——那是**疑问/推断，不是用户原话**，**用户本人从未执行过这一步**，请勿再当作已确认现象引用（详见 `D:\p\WORKFLOW.md` §6 归因更正）。
**复现**（`D:\p\pw-check\repro-e2ee-stuck.mjs`，直接驱动桥的 E2EE 状态机，无需真机）：

```
桥配对成功（pinned）→ 身份文件丢失/损坏（升级、换目录、撕裂写）→ 桥重建身份且 pin=null（legacy）
手机仍留 pin → 业务请求加密发出 → 桥回 E2EE_RESTARTED → 手机重握手
            → 桥 establishConnection 因 !pinnedPeer 返回 false → key-mismatch
            → 旧 App：保留 pin + 提示 + 断连 ⇒ 业务请求永远发不出去，会话列表一直空
手动「取消加密」（App 发明文 e2ee.clear）→ 两端清 pin → 明文恢复
            ⇒ 这是**这条代码路径上的唯一出路（脚本推演，非用户实测步骤）**
```

> ⚠️ **该反馈的真实成因仍未坐实（2026-09-20 晚）**：从 relay 日志另查到一条**与 E2EE 无关**、证据更充分的原因——某用户 PC 上同一设备存在两条桥连接互相顶替的死循环（每 ~10s 踢一次，请求会丢），足以解释"刷新不出会话"。见 `D:\p\WORKFLOW.md` §7.0 第 3 项与 §6。本节的修复对这些路径依然有效，但**别把它当成那位用户问题的唯一解释**。

### 已修（PC 侧，npm 插件）

| # | 改动 | 位置 |
|---|---|---|
| 1 | **原子写** `device-key.json`（tmp + rename），杜绝撕裂读 | `bridge/e2ee.js` `#save` |
| 2 | 文件存在但损坏 → **先备份 `.broken-<ts>` 再重建**并打印告警（不再静默丢 pin）；新增 `pinState` 供诊断 | `bridge/e2ee.js` `#load` / `get pinState` |
| 3 | 宿主**不再覆盖**该文件：存在但读不出来时只告警并返回空，交给桥按"备份+重建"处理（落实本文档"修复方向 1/2"） | `src/index.ts` `ensureIdentityKey` |
| 4 | hello 失败时**错误码保持不变**（`key-mismatch`），在 `error.data` 补 `{ reason: "no-pin"｜"peer-key-changed", pinned, bridgeKeyId, peerKeyId }` —— 老版 App 行为不回退，新版 App 可据此自愈 | `bridge/adapter.js` `#e2eeHello` |
| 5 | 新增回归测试 `scripts/smoke-e2ee-peer-changed.mjs`（16 项：自愈信息、备份、原子写、正常配对回归） | `scripts/` |

> 为什么**不**新增错误码：老版 App 只识别 `key-mismatch`，换成新码它们会**静默卡住、连提示都没有** —— 实测过的兼容约束。

### 已修（App 侧，需新版 APK）

- 新增 `E2eeRecoveryPolicy`（纯逻辑 + 单测 4 例）：`key-mismatch`（新老桥两种来源）都判定为
  "对端身份已变化"。
- `RemoteClient.startE2eeHandshake` 失败分支：**丢弃该设备过期 pin → 自动回退明文 → 重发未决请求 → 释放握手闩锁**，
  并只给一条非阻塞提示（`onE2eeDowngraded`）；**不再 `disconnect()`、不再要求用户手动「取消加密」**。
- 提示文案：`端到端加密配对已失效（对端安全身份已变化），已自动切换为明文连接；重新扫描 ② 码即可恢复加密。`

### 现状对老用户的处置建议（新版发布前）

受影响用户**不要点「取消加密」**（那会永久降级为明文），应**重新扫一次面板 ② 加密配对码**：
两端重新 pin，加密恢复且会话立即可用。

## 修复方向（原始调研，1/2/3 已实施）

1. **桥独占 `device-key.json`**：宿主只读、绝不写、绝不生成；拿不到 pubKey 时等桥写入
   （桥启动即保证写）。→ **已实施**（宿主不再 regenerate）
2. 宿主/桥"存在但解析失败"改为**告警 + 等待重试，永不覆盖**；仅在"文件确实不存在"时生成。→ **桥侧改为备份+告警后重建**（不静默）；宿主侧已不覆盖
3. 文件写入原子化（tmp + rename），杜绝撕裂读。→ **已实施**
4. （App 侧）区分"取消加密后的 key-mismatch"与"真身份变化"：已清 pin 则不再自动 hello，
   或 e2ee.clear 后忽略 key-mismatch 提示；桥端也可对"未 pin"回不同错误码。
   → **部分实施**：桥端改为在 `data.reason` 里给"no-pin/peer-key-changed"（不改码）；App 端改为
   **一律自愈**（丢 pin + 明文），不再要求用户手动操作
5. 桥 `completePairing` 成功后删除已用 pairing 条目（同一码 TTL 内可被重放配对）。→ **未实施**（低危，待办）

## 附：与"手机看不到审批/提问卡片"的关系

无关。卡片不弹出的根因另见：桥转发 `approval/requested` / `question/requested` /
`approval/resolved` / `question/resolved` 帧**缺少帧内 `sessionId` 字段**，而 App
`ConversationScreen.kt` 按 `frame["sessionId"] == 当前会话` 过滤事件，导致卡片被丢弃。
