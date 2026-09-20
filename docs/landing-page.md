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

改页面（样式/文案/截图）时：编辑 `landing/` 下的文件 → 传 `index.html` / `pair.html` / `qrcode.min.js` / `shots/*`，**不要传任何 APK**。

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
| c | 旧工程 `D:\p\dshmobile-landing\` | 其 `site/` 副本陈旧（0.2.14）、`deploy-dshmobile.py` 会回退线上版本 | 视为只读参考资料，**不要执行其部署脚本** |
| d | 静态兜底文案 | `index.html` 里 `<span data-ver>v0.2.x</span>` 为静态兜底，运行时由 JS 覆盖 | 无需处理（无 JS 环境才可见） |
