# 落地页维护文档（dshmobile landing）

> 自 **2026-09-20** 起，落地页由本工作区维护（原设计/实现由另一个智能体的工程 `D:\p\dshmobile-landing\` 完成，已收编）。
> **唯一源**：`dshmobile-repo/landing/`（本仓库，纳入 git）。
> **线上目录**：`/opt/session-control-relay/web/dshmobile/`（nginx root = `/opt/session-control-relay/web`）。

---

## 1. 线上文件构成

| 文件 | 作用 | 谁维护 |
|---|---|---|
| `index.html` | 落地页主页面（单文件内联 CSS/JS，零构建） | 本仓库 `landing/index.html` |
| `pair.html` | **遗留文件**（页面已不再引用；保留仅以防旧书签/缓存链接） | 不再维护 |
| `qrcode.min.js` | davidshimjs QR 库（本地，无第三方 CDN 依赖） | 随 `landing/` 同步 |
| `icon/*` | 品牌资源（当前为 **icon-v4-traced 代**，12 个文件）：`favicon.ico`(16/32/48) / `dsh-mobile-app.svg`(白底圆角 App 图标) / `app-180.png` / `favicon-16.png` / `favicon-32.png` / `icon-192.png` / `icon-512.png` / `dsh-mobile-mark.svg`(透明底) + 上一代遗留(未引用)：`app-192.png` / `app-512.png` / `*-dark.svg` | **产出方是另一个智能体的工程**（素材 `D:\p\dshmobile-landing\icon-v4-traced\`，清单 `DEPLOY-LIST.md` + `manifest.json`）；本仓库只做**部署/合并**，不编辑其内容 |
| `shots/*.webp` | 脱敏截图 6 张 | 随 `landing/` 同步 |
| **`latest.json`** | **版本真相源**：`{version,file,size,sha256,releasedAt,notes}` | 每次发版由发布方更新 |
| `DSH-Mobile-<ver>.apk` | 各历史版本 APK（扫码/按钮的下载目标） | 发布时上传 |

---

## 2. 不变量（改动前必读，破坏任一条都会造成线上问题）

1. **二维码内容 = 落地页绝对 URL（带 `#download`），不要编 APK 直链。**
   两个理由：
   - **微信会拦 `.apk` 直链**：微信内置浏览器识别到文件下载会弹"该网页可能存在文件下载内容…如需浏览，请长按网址复制后使用浏览器访问"，用户被迫长按复制，常把多余文字一起选进去，链接不可靠（2026-09-20 用户实拍反馈）。
   - **一张码永久有效**：码里是页面地址，换版本只改 `latest.json`，**旧二维码永远能下到最新版**；编直链则每次发版旧码全废。
   页面对应的处理：微信 UA 下隐藏所有 `.apk` 按钮（并移除 `href`，避免点进拦截页）、显示右上角引导 + 可整段选中的链接 + 「复制下载链接」一键精确复制；非微信直接落到 `#download` 点按钮下载。
   *历史事故（2026-09-20 上午）*：二维码内容写成 `"./" + APK_FILE` 相对路径 → 扫码只显示字面文本、无法下载（"按钮好用、扫码不行"）。修成绝对 URL 后微信里又被拦，最终改成"指向本页下载区"。
2. **版本号只认 `latest.json`**：`index.html` 里内置的 `APK_VERSION` 只是 `file://` 预览/网络失败时的兜底。改版本号请改 `latest.json`，不要只改 HTML（改了也会被覆盖）。
3. **`latest.json.version` 与 `file` 必须和实际 APK 一致**（`file` 默认按 `DSH-Mobile-<version>.apk` 推导，可显式指定）。
4. **`pair.html` 的下载按钮同样跟随 `latest.json`**（不要写死版本号）。
5. **单页设计：扫任何码都落在同一个页面**（`/dshmobile/`）。
   - 带 `?mode=pair|grant|e2ee`（PC 面板二维码就是这么编码的）→ 页面顶部显示**配对卡**：配对码/提示 + 「打开 App 完成配对」（`dshmobile://…` 深链，600ms 后自动拉起）+ 「还没装 App？去下载」；微信内 UA 隐藏「打开 App」并显示兜底提示。
   - 不带参数 → 普通落地页（下载/注册），不显示配对卡。
   - **不要**再写"跳转到 pair.html"的逻辑：`pair.html` 已退化为遗留文件（仅保留，页面不再引用），历史上"先闪落地页再跳旧样式页"就是这条重定向造成的。
6. **不要运行** `D:\p\dshmobile-landing\scripts\deploy-dshmobile.py`（旧部署脚本）：它会把 `index.html` 的版本退回 0.2.14、`pair.html` 退回 `DSH-Mobile-0.2.9.apk`。该脚本已废弃。
7. **页面只有一份源，部署入口有两个 → 必须镜像。**
   *事故（2026-09-20 10:21）*：另一个智能体做完品牌资源后，用新写的 `dshmobile-landing/scripts/deploy-landing-only.py` 把**它自己那份 `site/` 整目录**推上服务器，直接盖掉了我们 09:39 的部署——线上因此回到"页面显示 0.2.14 + 二维码是相对路径扫了不下载"。两版是同一设计的分叉：他们那版有新 logo 资源但没有功能修复，我们那版有修复但没有 logo。
   处置与预防：
   - 已完成**合并**：以本仓库 `landing/index.html`（含全部修复）为基线，并入他们的品牌资源（head 图标链接、页头 `<svg class="mark">` logo、`.brand .mark` 样式、`icon/` 8 个文件）——合并脚本 `D:\p\pw-check\merge-brand.mjs`（可复现）。
   - 已**镜像**：`landing/{index.html,latest.json,pair.html}` 复制到 `D:\p\dshmobile-landing\site\`，因此即便有人再跑一次旧脚本，推上去的也是正确内容。
   - 规矩：**改完落地页，除了上传服务器，还要重新镜像一次**（见 §3 末）；改品牌资源只改本仓库 `landing/icon/`。
8. **包体大小与更新日期同样来自 `latest.json`**（`data-size` ← `size` 字节换算、`data-date` ← `releasedAt`）。HTML 里的文案只是兜底；不要手写日期，否则页面会显示旧日期、让人以为没发新版。
9. **微信内绝不暴露 `.apk` 链接**：`applyDownloadTargets()` 在 `IS_WECHAT` 时隐藏 `#dlBtn`/`#dlBtnHero` 并移除 `href`。**每次 `applyVersion()`（latest.json 回来）都会重跑它**——曾经踩过"守卫先跑、版本刷新又把 href 挂回去"的坑，改这段务必保持"赋值集中在 `applyDownloadTargets()` 一处"。
10. **下载区紧跟 hero**（`#download` 是第 2 个区块，导航第一项也是「下载」）：扫码进来的人第一眼就是下载入口。手机端（≤780px）隐藏二维码（扫自己屏幕没意义）、默认展开 hero 卡的「手机端下载」并显示按钮。

---

## 3. 发布流程（发新 APK 时）

```powershell
# 0) 构建（版本号在 app/build.gradle.kts）
cd D:\p\dsh-mobile; .\gradlew.bat assembleRelease

# 1) 上传 APK（文件名必须与 latest.json 的 file 一致）
cd D:\p\srv-tools
node run.mjs --put D:\p\dsh-mobile\app\build\outputs\apk\release\app-release.apk `
  /opt/session-control-relay/web/dshmobile/DSH-Mobile-<ver>.apk

# 2) 更新 landing/latest.json（version/file/size/sha256/releasedAt/notes）

# 3) 同步页面与清单（页面通常不需要改，只有在改样式/文案时才传）
node run.mjs --put D:\p\dshmobile-repo\landing\latest.json /opt/session-control-relay/web/dshmobile/latest.json

# 4) 校验：HTTP 200 + 哈希一致
node run.mjs "sha256sum /opt/session-control-relay/web/dshmobile/DSH-Mobile-<ver>.apk | cut -c1-32"
(Get-FileHash D:\p\dsh-mobile\app\build\outputs\apk\release\app-release.apk -Algorithm SHA256).Hash.Substring(0,32).ToLower()
Invoke-WebRequest https://www.deepseek-claudex.cn/dshmobile/DSH-Mobile-<ver>.apk -Method Head | Select StatusCode

# 5) 端到端验证（含二维码真实内容）
node D:\p\tools\pwt\verify-qr.mjs
```

改页面（样式/文案/截图）时：编辑 `landing/` 下的文件 → 传 `index.html` / `pair.html` / `qrcode.min.js` / `shots/*` / `icon/*`，**不要传任何 APK**。

```powershell
# 改页面/品牌资源后（index.html + icon/*）
cd D:\p\srv-tools
node run.mjs --put D:\p\dshmobile-repo\landing\index.html /opt/session-control-relay/web/dshmobile/index.html
Get-ChildItem D:\p\dshmobile-repo\landing\icon -File | ForEach-Object {
  node run.mjs --put $_.FullName "/opt/session-control-relay/web/dshmobile/icon/$($_.Name)"
}
node run.mjs "md5sum /opt/session-control-relay/web/dshmobile/index.html"
(Get-FileHash D:\p\dshmobile-repo\landing\index.html -Algorithm MD5).Hash.ToLower()   # 两边必须一致

# 必做：镜像回旧工程 site/，防止旧脚本把旧版推回线上（§2 第 7 条）
foreach ($f in @("index.html","latest.json","pair.html")) {
  Copy-Item "D:\p\dshmobile-repo\landing\$f" "D:\p\dshmobile-landing\site\$f" -Force
}

# 部署前本地验收（品牌/版本/二维码/配对卡 22 项）：先起本地服务再跑
node D:\p\pw-check\serve-landing.mjs 8099        # 后台，root=landing/
node D:\p\pw-check\preview-landing.mjs http://127.0.0.1:8099/

# 下载链路专测（扫码落地 / 微信引导 / 手机端默认栏 / 复制按钮 / APK 可达 12 项）
node D:\p\pw-check\verify-download-flow.mjs http://127.0.0.1:8099/
```

**发新版时二维码不用动**：码里是页面地址，只需上传新 APK + 改 `latest.json`（§3 步骤 1–3），页面与码都自动指向新版。

---

## 4. 验证脚本（可复现）

**页面与二维码**：`node D:\p\tools\pwt\verify-qr.mjs [url]`（playwright-core + 系统 Chrome，headless）会：
1. 加载线上页面，打印 `latest.json` 的 HTTP 状态；
2. **拦截 `window.QRCode` 构造调用，抓出二维码真正编码的字符串**；
3. 输出页面显示版本、下载按钮 href、`data-apk-url`；
4. 断言所有二维码内容都以 `https://` 开头，并列出 4xx 资源。

**单页配对**：`node D:\p\tools\pwt\verify-pair-inline.mjs`（仓库副本：`landing/tools/verify-pair-inline.mjs`）覆盖 6 组：
`mode=pair`（不跳 pair.html + 配对码 + `dshmobile://pair` 深链 + 版本号）、`mode=e2ee`、`mode=grant`、无参数（不显示卡片）、微信 UA（隐藏打开 App + 显示兜底）、等待自动拉起后仍在同页。
> 期望版本从站点 `latest.json` 动态读取，发版不用改脚本。

**下载链路**：`node D:\p\pw-check\verify-download-flow.mjs [url]`（仓库副本 `landing/tools/verify-download-flow.mjs`）12 项：
1. **扫码落地**（手机视口开 `#download`）：自动滚到下载区、标题不被吸顶导航遮挡、`reveal` 动画已显现、手机端隐藏二维码、hero 卡显示按钮、默认展开「手机端下载」；
2. **微信 UA**：引导条可见、两个 `.apk` 按钮隐藏且 `href` 已移除、链接框显示、点「复制下载链接」后剪贴板**逐字符相等**、全程**零 `.apk` 请求**；
3. **APK 可达**：`HEAD` 200 + `Content-Length` 与 `latest.json` 一致 + 前 64KB 是 ZIP 魔数 `PK`（完整 sha256 由服务器侧 `sha256sum` 保证）。

**最近一次验证结果（2026-09-20 19:1x，APK 0.2.18 上线后）**：
```
=== preview-landing.mjs（线上 22 项）===
期望：版本 0.2.18 / DSH-Mobile-0.2.18.apk / 二维码=https://www.deepseek-claudex.cn/dshmobile/#download / 约 13 MB / 2026-09-20
✅ 所有 [data-ver] 均为 v0.2.18（来自 latest.json）        ✅ 全部通过

=== verify-download-flow.mjs（线上 12 项）===
✅ APK HEAD 200   ✅ Content-Length 与 latest.json 一致（13600617 == 13600617）
✅ 前 65536 字节是 APK/ZIP 魔数（PK）                     ✅ 下载链路全部通过

=== verify-qr.mjs ===
页面显示版本 v0.2.18 ×4；下载按钮 href = …/DSH-Mobile-0.2.18.apk
二维码实际编码内容 = "https://www.deepseek-claudex.cn/dshmobile/#download"（两个码都是）
✅ 所有二维码都是绝对 https URL

=== verify-pair-inline.mjs ===
[1] mode=pair PASS ×4   [2] e2ee PASS   [3] grant PASS   [4] 无参数 PASS   [5] 微信 UA PASS   [6] 自动拉起仍同页 PASS
ALL PASS
```
> 线上已无 404：`/auth/registration-status` 随 relay 部署上线（见 §5 待办 a）。

---

## 5. 已知待办

| # | 事项 | 现状 | 动作 |
|---|---|---|---|
| a | relay `GET /auth/registration-status`（注册名额上限 `MAX_USERS`） | ✅ **已部署（2026-09-20 12:50）**：dist 差异 5 文件上传（备份 `dist.bak-regstatus-20260920-125040`）→ 重启服务 → 线上 `{"ok":true,"data":{"open":true,"limit":53,"remaining":20}}`，页面显示"剩余 20 / 53" | 已完成。**`MAX_USERS` 是账号总上限**：本次按"现有 33 + 新增 20 = 53"写入 `.env`；以后加名额改这个值再重启 |
| b | 页面"电脑端安装"命令用 `@zdx8637/dshmobile-bridge@latest` | ✅ **已解决（2026-09-20）**：`0.1.0-beta.22` 已发布，`latest`=`beta`=`0.1.0-beta.22`；已下载 tarball 校验 `bridge/adapter.js` 含 `stripReasoning`/`toolSummary`/`toolResult.full`、`bridge/relay.js` 含 `transfer.deliver` 白名单 | — |
| c | 旧工程 `D:\p\dshmobile-landing\` | `site/` 已在 2026-09-20 **镜像为权威内容**；其 `icon/` 仍由该工程（另一智能体）产出，我们只读取合并 | `deploy-dshmobile.py` 仍禁止执行；改完落地页记得重新镜像（§3） |
| e | 品牌资源（icon / logo） | **v4-traced 代已于 2026-09-20 部署到网站**（另一智能体出素材 + `DEPLOY-LIST.md`；我方用 `D:\p\pw-check\apply-web-icons.mjs` 落盘）：A-1 覆盖 `favicon.ico`/`dsh-mobile-app.svg`(白底版)/`app-180.png`，A-2 新增 `favicon-16/32.png`+`icon-192/512.png`+`dsh-mobile-mark.svg` 并补两行 `<head>`，A-3 导航 logo 换成白底版内联 SVG。素材 6 件 sha256 与 `manifest.json` 逐一校验一致 | 网站已上线；**App 图标已进工程并构建验证，但要让用户看到需发布新 APK（见 f）** |
| f | App 启动图标（原本完全没有 `android:icon`） | ✅ 随 **APK 0.2.17** 发布（2026-09-20 12:5x）：图标资源 + `mipmap-anydpi-v26/ic_launcher.xml` + manifest `android:icon`；`versionCode 28` | 已完成（App 工程不在 git，改动只在本机 `D:\p\dsh-mobile`） |
| g | **APK 0.2.18 上线（E2EE 自愈）** | ✅ **已上线（2026-09-20 19:1x）**：`versionCode 29 / versionName 0.2.18`，`DSH-Mobile-0.2.18.apk` sha256 前 32 `65db623d50edf75b4856bf04f7380498`、13,600,617 字节，服务器与本地一致；`latest.json`/`index.html` 兜底版本同步为 0.2.18；线上 **22 项 + 下载链路 12 项 + 二维码 + 单页配对 6 组** 全绿 | 已完成。内容是"对端安全身份变化时自动丢过期 pin 并回退明文"，替代此前必须手动「取消加密」的卡死行为（详见 `dsh-session-archive.md` 同目录的 `e2ee-identity-issues.md`） |

> relay 侧的安全事项单独登记在 **`D:\p\dshmobile-private\docs\security-findings.md`**（**SEC-001：JWT 签名密钥仍是示例默认值**，影响=任意账号接管；用户 2026-09-20 决定暂缓处理，已落账）。改 relay 前先读那一条。
| d | 静态兜底文案 | `index.html` 里 `<span data-ver>v0.2.x</span>` 为静态兜底，运行时由 JS 覆盖 | 无需处理（无 JS 环境才可见） |
