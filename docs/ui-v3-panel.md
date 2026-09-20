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
- **弹窗（2026-09-20 第二轮，用户反馈"面板太长、下面被挡住"后改）**：从"贴着按钮的下拉"改成**屏幕居中模态** —— 点入口按钮弹出、点遮罩空白处或按 `Esc` 关闭、内容超高时**面板内部滚动**（`overscroll-behavior: contain`），面板 `max-height` 由遮罩内边距决定，**任何视口高度都不会被裁**。
  - 同时修掉原实现的定位 bug：旧代码按固定 `height = 640` 估算并据此夹 `top`，900px 视口 + 868px 内容必然溢出被切；新实现不再做高度估算。
  - **祖先裁剪兜底**：DSH 侧栏祖先可能带 `transform`（会让 `position: fixed` 的包含块变成该祖先、遮罩被裁）。打开时自检遮罩是否铺满视口，不满足则退回锚定定位并 `console.warn` 提示。harness 里不会触发（无 transform 祖先），真 GUI 若触发可在控制台看到该警告。
- **布局（2026-09-20 第三轮，用户要求"横版"）**：从竖排三块改为
  **顶部细状态栏（44px）+ 下方三栏（登录 / 配对二维码 / E2EE 二维码）**，面板 **920px 宽**；窗口宽度 ≥ **1000px** 才用横版，更窄自动回退竖排（避免挤坏）。
  - **对齐规则**（用户反馈"层次不齐"后定稿）：三栏等宽（`grid: 320px 1fr 1fr`）**等高**（`align-items:stretch` + 卡片 `flex:1`）；每栏同构＝栏标题（右侧带状态/倒计时）→ 卡片 → 底部动作；底部动作用 `.dsm-actions{margin-top:auto}` **压到同一基线**；二维码 `.dsm-tilewrap` **卡内居中**，两张同为 207×207 且同顶边。
  - **帮助文档进状态栏**、**退出登录进登录栏按钮行（右对齐，未登录不显示）**，**外部那行整体删除**；relay 地址不再放状态栏（登录栏输入框可读），避免挤掉账号/设备显示。
  - 实测（验收断言）：三栏卡片 顶边 292/292/292、底边 633/633/633、高 341/341/341；栏标题同基线；底部动作底边 620/620/620；二维码 207×207@305 居中偏差 0/0。面板尺寸 **920×432**（已连接）／**920×372**（未连接）。
  - 踩坑记录：① 重命名 `loginBody→loginRows` 时把说明与按钮留在里面 → 登录区**重复渲染两遍**（截图发现）；② 内联 `marginTop:12` 覆盖 `.dsm-actions{margin-top:auto}`（内联优先级更高）→ 按钮没贴底；③ `<p>` 默认下边距把尾部注释顶高 12px → 补 `marginBottom:0`。**三处都是"量出来/看出来"的，不是推理出来的。**
- **状态**：未连接也保留 ① 授权码（`mode=grant`），② 登录后才可用（占位一行）；状态点映射 ok/warn/off/err。

## 3. 验收证据（可复现）

```powershell
# 1) 插件桥/宿主侧回归（我没改桥，仍全量跑）
cd D:\p\dshmobile-plugin
node scripts/smoke-dsh-v2.mjs ; node scripts/smoke-dsh-legacy.mjs
node scripts/smoke-host-token.mjs ; node scripts/smoke-e2ee-restart.mjs      # 4/4 ALL PASS

# 2) 面板渲染验收（真源码 + 真 React + 真浏览器 + jsQR 真解码）
cd D:\p\pw-check\panel-harness
node bundle.mjs            # 把 src/client.tsx 打进 harness
node run-panel-tests.mjs   # 11 组断言，全绿
#   1  布局：横版三栏（面板 920 / 状态栏 45 / 三栏同行 / 栏标题 / 关闭按钮）＋ 窄窗口竖版回退
#   2  对齐：栏标题 17px、卡内元素 = +13、输入框在网格第二列（+62）；横竖两版各测一次
#   2b 三栏对齐：等宽等高、标题同基线、底部动作同基线、二维码同尺寸同顶边且居中
#   3  密码语义：不回填明文 / 留空不进 patch / 填了才提交
#   4  二维码：几何实测 + jsQR 解码（pair 37 / e2ee 61 模块，静区 16/4，cell=3 整数）
#   5-7 状态 A/C/D：未连接仍有 grant 授权码；登录失效红点+错误条；通道不可达仍渲染
#   8  入口按钮：宽栏 256×36（图标+名称+状态点+箭头）/ 窄轨 36×36（角标）
#   9  主题：浅色（默认）/ 暗色（body[data-ds-dark-theme]）都成立，二维码瓦片恒纯白
#   9b 帮助文档在状态栏 / 退出登录在登录栏同一行右对齐 / 外部无独立行
#   10 模态：5 分辨率（1440×1000…900×520）×（遮罩铺满 + 四角命中 + 面板完整可见 + 居中 + 可滚到底）
#      ＋ 点遮罩关闭 / Esc 关闭 / 面板内按下外边松开不误关
#   截图：..\preview-*.png（暗/浅 × 已连接/未连接/登录失效 + 窄窗口回退）；像素采样 ..\sample-shot-pixels.mjs
#         四角 rgb(12,12,13)=遮罩已压暗、面板中心 rgb(35,35,36)=暗色令牌

# 3) 构建产物校验（转义还原后查文案 + 不变量 + 旧痕迹已移除 + 横版标记必须在产物里）
cd D:\p\pw-check ; node check-client-bundle.mjs
#   注意：esbuild 会把数字字面量规范化（1000 → 1e3），断言文本要跟着写
```

> **未覆盖**：DSH GUI 需要 `dsh web` 打印的带 token URL（我这边访问 127.0.0.1:3080 得 401），因此"在真实 GUI 里的最终观感"由用户刷新页面确认；harness 已把令牌值与 280px 侧栏宽度按真实情况还原。

## 4. 业务不变量（本次未改，验收脚本会断言）

槽位 `name: "sidebar.footer.action"` / `id: "dshmobile"` / `order: 10`；本地通道 `http://127.0.0.1:17653` 的 `/state` 与 `/action`；动作名 `refreshPairing` / `save` / `register` / `logout`；`/state` 全部字段名；三种二维码 URL 的拼装逻辑（`pair` / `grant` / `e2ee`）。
