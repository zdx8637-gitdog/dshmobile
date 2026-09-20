# PC 面板 v3 落地记录（2026-09-20）

> 设计资产与施工单来自另一个智能体的工程 `D:\p\dshmobile-landing\ui-design\`（`DEPLOY-LIST.md` + `02-bridge-panel/spec.md` + 两个可点原型）。
> 本文记录**接入时复核出的问题、我方如何修正、以及验收证据**——因为施工单里有 3 处按字面实施会出故障。

## 1. 复核发现（按严重度）

### 1.1 ⚠️ DEPLOY-LIST 第五节的 `drawQr` 会裁掉 e2ee 二维码（致命）

施工单给的"加固后实现"：

```ts
const cell = Math.max(3, Math.floor(canvas.width / (n + QUIET * 2)));   // canvas 固定 135
const off  = Math.floor((canvas.width - n * cell) / 2);
```

用插件同款 `qrcode-generator` + 真实 URL 实测（`D:\p\pw-check\qr-module-math.mjs` 可复现）：

| 码 | 字符数 | 模块 n | 上式 cell | 内容 px | off | 结果 |
|---|---|---|---|---|---|---|
| `pair`（`?mode=pair&code=638039`） | 64 | 37 | 3 | 111 | 12 | ✅ 静区 4.0 模块 |
| `grant`（+ `pid` uuid） | 106 | 41 | 3 | 123 | 6 | ❌ 静区仅 2.0 模块 |
| `e2ee`（+ deviceId + 43 字符 pk + 43 字符 ps + pid） | 238 | **61** | 3 | 183 | **−24** | ❌❌ 溢出 48px、被裁，扫不出来 |

根因：`Math.max(3, …)` 这个下限把"静区 ≥4 模块"的前提破坏了——当 `n + 8 > canvas/3` 时，被抬到 3 的 cell 让 `n*cell > canvas`，`off` 变负。**设计稿只在 n=37 的码上验过**（原型里三张码都是 37 模块），而真实 e2ee 码是 61 模块。

**修正**（`spec.md` §2 的思路其实是对的，是 DEPLOY-LIST 的简化版丢了 `maxN`）：

```ts
const maxN = 所有码模块数的最大值;                       // 两码取大者 → 两卡同尺寸
const cell = clamp(floor(QR_TARGET / (maxN + 8)), 3, 6); // 目标 138px，允许长到 6px/模块
const side = cell * (maxN + 8);                          // 瓦片边长随真实数据增长
canvas 像素 = side × DPR（DPR 感知），CSS = side          // 任意缩放下都是整数模块
绘制偏移 off = (canvas − n*cell)/2 → 静区恒 ≥4 模块
```

实测结果（jsQR 逐张解码，`pw-check/panel-harness/run-panel-tests.mjs`）：`pair` n=37、`e2ee` n=61、cell=3（整数）、静区 **16 / 4** 模块、两卡同为 **207×207**、两张码内容解码与期望 URL 逐字符相同。

**副作用与取舍**：真实 e2ee 码 61 模块 ⇒ 要满足"cell ≥3px + 静区 4 模块"，瓦片必须 **207px**（不是设计稿的 135px；135 只在 n=37 时成立）。因此二维码卡内部改为**竖排**（码在上、码值/复制/说明/按钮在下），否则 360px 面板里右侧只剩 ~85px，文字与按钮会被挤碎。这是对"真实数据"的必要适配，不是随意改设计。

### 1.2 ⚠️ "密码框不回填明文"若只改 UI 会清空已存密码

施工单第六节把它列为验收项，但宿主 `src/index.ts` 的 save 分支是：

```ts
for (const k of [...]) if (payload && payload[k] !== undefined) state[k] = payload[k];   // 没有"空=不改"语义
```

而当前面板能安全保存，正是因为它**预填了真实密码**（`form.password === value.password` → 不进 patch）。只做"不回填"，空密码就会 `"" !== 真实值` → 进 patch → **宿主把已存密码清空、桥掉线**。

**修正**：UI 不回填（占位「留空表示不修改」）+ `save()` 里 **`password` 为空则跳过该字段**。已用 harness 断言三种情形：未改动不调用 save；只改设备名时 patch 无 `password` 键；填了密码才提交（`pw-check/panel-harness/run-panel-tests.mjs` §3）。

### 1.3 ⚠️ `tokens.css` 的主题方向与 DSH 实际相反

`tokens.css` 声明"暗色为默认，`[data-theme="light"]` 为浅色"。DSH 实际是 **浅色为默认、暗色由 `body[data-ds-dark-theme]` 切换**（`@deepseek-ai/dsh-client-ui-theme` 的 `client.js`；我此前用 playwright 探 `:root` 得"令牌不存在"，是被 401 页面误导，实测**存在 86 个 `--dsw-alias-*`**）。

**修正**：不自己判断主题，一律 `var(--dsw-alias-*, 兜底字面量)` —— 令牌随 DSH 主题翻转，浅/暗自动成立。harness 用"浅色默认 + `body[data-ds-dark-theme]`"两套真实令牌值各渲染一遍，断言面板底色分别取自令牌、二维码瓦片恒为纯白。

## 2. 本次实现（`plugins/src/client.tsx`）

- **入口按钮**：鲸鱼瓦片（内联 SVG，path 由 `pw-check/inject-whale-path.mjs` 从 App 图标注入，避免手抄 6 KB 出错）+ 名称 + 状态点 + 箭头；窄轨 36×36 + 角标状态点；hover/focus/展开态按规格（样式在注入的 `<style>` 里，因为内联 style 表达不了 `:hover`）。
- **面板**：`状态 / 登录 / 二维码` 三块 + 1px 分隔线、界面无编号；行网格 52px + gap 10；面板 360、内边距 0 16、圆角 12；错误条、底部「帮助文档 ・ 退出登录」；面板相对入口按钮定位并做视口内收敛。
- **状态**：未连接也保留 ① 授权码（`mode=grant`），② 登录后才可用（占位一行）；状态点映射 ok/warn/off/err。
- **删除**：旧的 `debug: channel=... status=...` 调试行（界面上不该出现）。

## 3. 验收证据（可复现）

```powershell
# 1) 插件桥/宿主侧回归（我没改桥，仍全量跑）
cd D:\p\dshmobile-plugin
node scripts/smoke-dsh-v2.mjs ; node scripts/smoke-dsh-legacy.mjs
node scripts/smoke-host-token.mjs ; node scripts/smoke-e2ee-restart.mjs      # 4/4 ALL PASS

# 2) 面板渲染验收（真源码 + 真 React + 真浏览器 + jsQR 真解码）
cd D:\p\pw-check\panel-harness
node bundle.mjs            # 把 src/client.tsx 打进 harness
node run-panel-tests.mjs   # 结构/对齐/密码语义/二维码几何+解码/状态映射/主题/入口按钮
#   截图：..\panel-B-connected-dark.png / panel-A-disconnected-dark.png / panel-B-light.png
#         ..\entry-wide-dark.png / entry-rail-dark.png / qr-e2ee-zoom3x.png

# 3) 构建产物校验（转义还原后查文案 + 不变量 + 旧痕迹已移除）
cd D:\p\pw-check ; node check-client-bundle.mjs
```

> **未覆盖**：DSH GUI 需要 `dsh web` 打印的带 token URL（我这边访问 127.0.0.1:3080 得 401），因此"在真实 GUI 里的最终观感"由用户刷新页面确认；harness 已把令牌值与 280px 侧栏宽度按真实情况还原。

## 4. 业务不变量（本次未改，验收脚本会断言）

槽位 `name: "sidebar.footer.action"` / `id: "dshmobile"` / `order: 10`；本地通道 `http://127.0.0.1:17653` 的 `/state` 与 `/action`；动作名 `refreshPairing` / `save` / `register` / `logout`；`/state` 全部字段名；三种二维码 URL 的拼装逻辑（`pair` / `grant` / `e2ee`）。
