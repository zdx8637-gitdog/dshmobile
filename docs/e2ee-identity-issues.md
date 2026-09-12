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

## 修复方向（待确认后实施）

1. **桥独占 `device-key.json`**：宿主只读、绝不写、绝不生成；拿不到 pubKey 时等桥写入
   （桥启动即保证写）。
2. 宿主/桥"存在但解析失败"改为**告警 + 等待重试，永不覆盖**；仅在"文件确实不存在"时生成。
3. 文件写入原子化（tmp + rename），杜绝撕裂读。
4. （App 侧）区分"取消加密后的 key-mismatch"与"真身份变化"：已清 pin 则不再自动 hello，
   或 e2ee.clear 后忽略 key-mismatch 提示；桥端也可对"未 pin"回不同错误码。
5. 桥 `completePairing` 成功后删除已用 pairing 条目（同一码 TTL 内可被重放配对）。

## 附：与"手机看不到审批/提问卡片"的关系

无关。卡片不弹出的根因另见：桥转发 `approval/requested` / `question/requested` /
`approval/resolved` / `question/resolved` 帧**缺少帧内 `sessionId` 字段**，而 App
`ConversationScreen.kt` 按 `frame["sessionId"] == 当前会话` 过滤事件，导致卡片被丢弃。
