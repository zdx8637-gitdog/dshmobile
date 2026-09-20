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

1. **二维码内容必须是绝对 `https://` URL。**
   二维码没有 base URL，相对路径扫出来只会显示字面文本、不下载。
   *历史事故（2026-09-20）*：改版页面把二维码内容写成 `"./" + APK_FILE`，用户扫码只看到 `./DSH-Mobile-0.2.16.apk`，无法下载；而页面上的下载按钮正常（浏览器会按页面 URL 解析相对路径）——所以"按钮好用、扫码不行"是这条不变量被破坏的典型症状。
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

# 部署前本地验收（品牌/版本/二维码/配对卡 17 项）：先起本地服务再跑
node D:\p\pw-check\serve-landing.mjs 8099        # 后台，root=landing/
node D:\p\pw-check\preview-landing.mjs http://127.0.0.1:8099/
```

---

## 4. 验证脚本（可复现）

**页面与二维码**：`node D:\p\tools\pwt\verify-qr.mjs [url]`（playwright-core + 系统 Chrome，headless）会：
1. 加载线上页面，打印 `latest.json` 的 HTTP 状态；
2. **拦截 `window.QRCode` 构造调用，抓出二维码真正编码的字符串**；
3. 输出页面显示版本、下载按钮 href、`data-apk-url`；
4. 断言所有二维码内容都以 `https://` 开头，并列出 4xx 资源。

**单页配对**：`node D:\p\tools\pwt\verify-pair-inline.mjs`（仓库副本：`landing/tools/verify-pair-inline.mjs`）覆盖 6 组：
`mode=pair`（不跳 pair.html + 配对码 + `dshmobile://pair` 深链 + 版本号）、`mode=e2ee`、`mode=grant`、无参数（不显示卡片）、微信 UA（隐藏打开 App + 显示兜底）、等待自动拉起后仍在同页。

**最近一次验证结果（2026-09-20）**：
```
=== verify-qr.mjs ===
latest.json → 200
页面显示版本: ["v0.2.16","v0.2.16","v0.2.16","v0.2.16"]
二维码实际编码内容: [ "https://www.deepseek-claudex.cn/dshmobile/DSH-Mobile-0.2.16.apk", "…同上（Hero 卡第二个二维码）" ]
✅ 所有二维码都是绝对 https URL
HTTP 404 https://www.deepseek-claudex.cn/auth/registration-status   ← 见 §5 待办 a

=== verify-pair-inline.mjs ===
[1] mode=pair   PASS ×4（不跳 pair.html / 配对码 123456 / dshmobile://pair 深链 / 版本 v0.2.16）
[2] mode=e2ee   PASS   [3] mode=grant  PASS   [4] 无参数 PASS   [5] 微信 UA PASS   [6] 自动拉起后仍同页 PASS
ALL PASS
```

---

## 5. 已知待办

| # | 事项 | 现状 | 动作 |
|---|---|---|---|
| a | relay `GET /auth/registration-status`（注册名额硬上限 `MAX_USERS`） | **代码已改（本工作区 `dshmobile-private/relay/src`：`config.maxUsers`、`routes/auth.ts` 路由、`RegistrationClosedError`、`auth-service.register()` 双校验），未部署**；页面 404 时降级显示"名额有限"，不阻断 | 需重建 + 重启 relay 服务（**生产动作，先经用户确认**） |
| b | 页面"电脑端安装"命令用 `@zdx8637/dshmobile-bridge@latest` | ✅ **已解决（2026-09-20）**：`0.1.0-beta.22` 已发布，`latest`=`beta`=`0.1.0-beta.22`；已下载 tarball 校验 `bridge/adapter.js` 含 `stripReasoning`/`toolSummary`/`toolResult.full`、`bridge/relay.js` 含 `transfer.deliver` 白名单 | — |
| c | 旧工程 `D:\p\dshmobile-landing\` | `site/` 已在 2026-09-20 **镜像为权威内容**；其 `icon/` 仍由该工程（另一智能体）产出，我们只读取合并 | `deploy-dshmobile.py` 仍禁止执行；改完落地页记得重新镜像（§3） |
| e | 品牌资源（icon / logo） | **v4-traced 代已于 2026-09-20 部署到网站**（另一智能体出素材 + `DEPLOY-LIST.md`；我方用 `D:\p\pw-check\apply-web-icons.mjs` 落盘）：A-1 覆盖 `favicon.ico`/`dsh-mobile-app.svg`(白底版)/`app-180.png`，A-2 新增 `favicon-16/32.png`+`icon-192/512.png`+`dsh-mobile-mark.svg` 并补两行 `<head>`，A-3 导航 logo 换成白底版内联 SVG。素材 6 件 sha256 与 `manifest.json` 逐一校验一致 | 网站已上线；**App 图标已进工程并构建验证，但要让用户看到需发布新 APK（见 f）** |
| f | App 启动图标（原本完全没有 `android:icon`） | 已落盘到 `D:\p\dsh-mobile\app\src\main\res\`：5 档 `mipmap-*/ic_launcher{,_foreground}.png` + `mipmap-anydpi-v26/ic_launcher.xml` + `values/colors.xml(ic_launcher_background=#FFFFFF)` + manifest `android:icon="@mipmap/ic_launcher"`。构建后 `aapt2 dump badging` 显示 `icon='res/BW.xml'`（全密度自适应）；模拟器桌面/应用详情页肉眼确认圆鲸图标、App 启动无崩溃 | ⬜ **需发新 APK 才能触达用户**（版本号未动，仍 0.2.16/27） |
| d | 静态兜底文案 | `index.html` 里 `<span data-ver>v0.2.x</span>` 为静态兜底，运行时由 JS 覆盖 | 无需处理（无 JS 环境才可见） |
