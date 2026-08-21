# 任务 2 执行文案（durable brief，防上下文丢失）

> 本文是任务 2 的**自包含执行契约**：对话中断、上下文压缩、换人执行，都以此文件为准。
> 详细设计见 `docs/plan-task2-files-images.md`；协议单一事实来源见 `docs/02-protocol.md` §7。
> 状态：文案已定稿 → 下一步按 §5 执行顺序开工。

## 1. 目标（一句话）

**手机 ↔ PC 双向文件与图片：手机上传文件/照片进 DSH 工作区（模型可看可用），
会话里的图片在手机上直接显示。** 一次做「文件 + 图片」全量。

## 2. 基线（执行前的事实，勿重复验证）

- relay 生产（146.56.197.38，systemd `session-control-relay`，端口 48730，nginx 443 域名
  www.deepseek-claudex.cn）**已部署 Data Plane**（Task 1，commit `28fc015` 对应代码）：
  `POST /transfers`（announce，用户 token，归属校验）、`PUT /transfers/:id/chunks`
  （X-Chunk-Offset 强校验）、`GET /transfers/:id`、`POST /transfers/:id/complete`
  （sha256 校验 → ready → 控制面 `transfer.deliver` 到 bridge）、
  `GET /transfers/:id/download`（**目前仅设备 token**）；
- bridge（插件包内 `bridge/`）：已实现 `transfer.deliver` 处理（拉流下载 + SHA-256 校验 +
  `resolveInRoot` workspace 边界落盘，9/9 用例过）；`workspaceRoot` 默认 `<stateDir>/deliveries`；
- 手机 App：v0.1.3（安全修复版），`CloudApi` 仅认证/设备/配对；**无传输方法、无上传 UI、无图片渲染**；
- 插件 npm：beta.7；本机工作树 `D:\p\dshmobile-plugin`、Android 工作树 `D:\p\dsh-mobile`、
  仓库 `D:\p\dshmobile-repo`（工作树 → 仓库同步后提交推送）；
- 视觉模型事实（DeepSeek 官方文档）：模型名 `deepseek-v4-flash-vision-exp`（需手动选择）；
  图片仅限 user 消息；单图 ≤32MiB、单边 ≤8192px、请求体 ≤48MiB、≥15 图时 ≤4096px；
  服务端缩至 ~800×800 计 token（每图 ≤384 token）。

## 3. 协议增量（执行时先落到 `docs/02-protocol.md` §7，再写代码）

1. **用户侧下载**：`GET /transfers/:transferId/download` 增加用户 Bearer 面（owner 校验
   transfer.userId === userId），与设备 token 面并存；
2. **`upload.commit`**（client → bridge 请求）：payload `{transferId, fileId, name, size,
   sha256, targetPath, sessionId|null}` → 响应 `{ok, data:{path, messageId?}}`；
   bridge 落盘复核（文件已由 relay 投递到 workspace）后按 §4-L1/L2 进会话；
3. **`attachment.resolve`**（client → bridge 请求）：payload `{sessionId, attachmentId}` →
   响应 `{ok, data:{transferId, width, height, mediaType, bytes}}`；
   bridge 内部：读 DSH 附件字节 → sha256 → 以用户身份 announce+分块 PUT+complete
   （反向传输）→ 回 transferId；relay 对同 attachmentId 懒缓存（TTL 10 分钟）；
4. **`transfer.deliver` 增加 sessionId 透传**（可选）：手机带 sessionId 时，bridge 投递落盘后
   由手机侧再发 `upload.commit` 决定进会话（保持职责单一，默认此方案）。

## 4. 进会话策略（L1 默认 / L2 门禁）

- **L1（默认，无任何侦查依赖）**：bridge 落盘后向 session 发 `sessions.run` 文本消息
  「已上传 <name> → <path>」；任何模型可用工具读文件。
- **L2（增强，默认关，可配置）**：`session.models` 当前模型 == `deepseek-v4-flash-vision-exp`
  时，bridge 把图片登记为 DSH attachment（**依赖侦查 6.1**：附件公共 API）并以
  image 块注入 user content；否则回落 L1。
- 手机上传页提示文案（按模型动态）：
  - 视觉模型：「图片将直接交给模型查看」
  - 文本模型：「当前模型不支持看图，图片已存为文件 <path>；可切换 deepseek-v4-flash-vision-exp 后重发」

## 5. 执行顺序（Phase A → B → C，每阶段测试后提交）

### Phase A：上传主链（手机 → PC）
1. 协议文档增量（§3 的 1、2、4）；
2. relay：用户侧下载端点 + 测试（owner 隔离）；
3. bridge：`upload.commit` 处理（复核落盘 → L1 会话提及；L2 留 TODO 锚点）；
4. Android：`CloudApi` 增 transfers 三方法；上传 UI（入口：相册/拍照/系统分享 Intent；
   目标设备/路径/进度/续传）；图片压缩（长边 2048、q80）；
5. 测试：relay vitest + bridge 单测 + 真机冒烟（发一张照片 → PC workspace → 会话提及）；
6. 发布：手机 **0.1.4**、插件 **beta.8**（relay 已生产，直接热部署）。

### Phase B：图片回显（PC → 手机）
1. 协议增量（§3 的 3）；
2. relay：懒缓存（attachmentId→transferId，TTL 10min）+ 用户侧下载复用；
3. bridge：`attachment.resolve`（读 DSH 附件字节——**执行前先做侦查 6.1**）；
4. Android：`ChatItem` 增 Image 类型（user/message 与 tool/result 的 image 块解析）；
   渲染（缩略图/全屏/缓存/失败重试）；
5. 验证：桌面发带图消息/触发截图工具 → 手机显示；
6. 发布：手机 **0.1.5**、插件 **beta.9**。

### Phase C：打磨（可与 B 合并发布）
上传队列（多文件）、失败分类重试、缩略图预生成、缓存 LRU、移动网络流量确认提示。

## 6. 侦查清单（执行前完成，零代码成本；结果记入本文件 §6 备忘）

1. **DSH 附件公共 API**：Web UI 上传图片走的 HTTP 端点；bridge 能否按 attachmentId 读字节
   （决定 L2 与 Phase B 的读法）。方法：浏览器 F12 抓上传请求 / 搜 `dsh-web-app` 源码；
2. **history 事件 image 块实态**：桌面带图会话抓 `session.history`，确认 user/message 与
   tool/result 的 content 数组里 image 块的 JSON 结构；
3. **工具读图返回形态**：让 agent 读一张图，看 tool/result 是 image 块还是文本（决定 L1 是否视觉原生）；
4. Android 图片加载依赖选型（Coil vs 自写，minSdk 26、无 GMS）。

## 7. 验收清单（全部通过才算完成）

- [ ] 手机相册/拍照/分享任一入口发文件 → PC `~/.dsh-mobile/deliveries` 出现，SHA-256 一致
- [ ] 断网中断后重试：从断点续传成功
- [ ] 带 sessionId 上传 → DSH 会话出现「已上传 …」提及
- [ ] 视觉模型会话（deepseek-v4-flash-vision-exp）上传照片 → 模型看图回复正确（L2 或 L1+工具）
- [ ] 桌面会话中的图片 → 手机渲染显示，点按全屏
- [ ] relay 测试套件全绿；用户侧下载 owner 隔离测试通过
- [ ] 两台电脑插件升级后功能一致

## 8. 发布与回滚

- relay：热部署脚本 `dsh-remote/scripts/deploy-relay-dataplane.py`（先备份 dist）；
- 插件：`cd D:\p\dshmobile-plugin && npm.cmd publish --tag beta --access public` +
  `npm.cmd dist-tag add @zdx8637/dshmobile-bridge@<ver> latest`；
- 手机 APK：`gradle :app:assembleRelease` → `D:\p\release\DSH-Mobile-<ver>.apk` →
  `python dsh-remote/scripts/deploy-dshmobile.py`；
- 回滚：relay `dist.bak-dataplane-*` 恢复；插件 npm 版本 pin；APK 服务器保留上一版。

## 9. 成本与协作备注

- 每 Phase 完成 → 跑 relay `npm test`（应保持全绿）→ 提交并推送 → 再进下一 Phase；
- 与上下文压缩无关：**一切决策先写进本文件或 plan 文档，再动代码**。
