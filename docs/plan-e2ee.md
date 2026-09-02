# E2EE v1 设计（精简版）：控制面内容加密

> 状态：**已实现（E2EE v1）**，随 PC Bridge（npm `@zdx8637/dshmobile-bridge`）与 Android App 一起发布。
> 原则：现在做到**简单、可靠、安全及格**；未来上规模可升级（crypto v2），不提前实现未来能力。

## 1. 威胁模型与明确不解决

**威胁**：relay 被攻破/恶意，试图读取或篡改 DSH 业务内容，或做中间人/重放/降级攻击。

**目标**：relay 只能看到路由与流量元数据，**读不到、改不了 DSH 业务内容**。

**明确不解决（v1）**：
- 流量侧信道（大小/时序/时长仍可被 relay 观察）——文档明示，不缓解。
- 端点安全（手机/电脑本身被攻破则失效）。
- 前向保密（PFS）：长期 X25519 身份密钥派生的 master secret 是**静态的**；
  连接 nonce 只做 per-connection 密钥分离，**不提供 Forward Secrecy**——master secret 一旦
  泄露，配合捕获的连接 nonce 即可解密历史。此边界写进文档与代码注释。
- 不做：Double Ratchet / Signal 全套 / MLS / 群组密钥 / Key Transparency / 流量 padding /
  隐藏 deviceId/时间/大小 / 云端 key backup / HSM / PCS / 复杂自动轮换。

## 2. relay 明文可见 vs E2EE 边界

**relay 明文可见（完成路由所需）**：
- 用户/设备身份：userId、deviceId、clientId；
- 信封路由：schemaVersion、kind、type、requestId、sentAt、actor、target；
- 控制 meta：subscriptionId、afterSequence、sequence、eventId、now；
- 连接态与心跳；数据大小、时间等流量元数据；
- E2EE 的明文头：`crypto.version / keyId / dir / seq` 与连接 hello 的 `cNonce`。

**E2EE 加密（DSH 业务内容）**：
- prompt / 用户消息、assistant 输出、session 内容、tool call / tool result、
  approval / AskUserQuestion 业务内容、thinking/event 业务内容；
- （Phase 2）文件字节与敏感文件 metadata（filename/targetPath/明文 hash）。

**思想不变**：`routing/meta 明文 + DSH content 加密`。

## 3. 密码学参数与库

| 项 | 选择 |
|---|---|
| 身份密钥 | X25519（长期 static） |
| 派生 | HKDF-SHA256 |
| 对称 | AES-256-GCM（12B nonce，16B tag） |
| 配对认证 | HMAC-SHA256 |
| keyId | `hex(sha256(pubkey))[0:8]` |
| Node | 内置 `crypto`（X25519 / HKDF / AES-GCM / HMAC 均原生） |
| Android | **Tink subtle**：`com.google.crypto.tink.subtle.X25519` + `subtle.Hkdf` + `subtle.AesGcmJce` + `subtle.Hmac` |

**Android 事实核验（2026-08 官方口径）**：
- 平台 `KeyAgreement.getInstance("XDH")` 标注 **API 33+**（`KeyPairGenerator("X25519")` 虽是
  API 28，但 XDH 密钥协商需 33）；minSdk 26 远低于 33，**平台方案不可用**。
- Tink Android 官方支持 **API 24+**，minSdk 26 可用。
- **Tink primitive 取舍**：不用高层 `HybridEncrypt`（单向公钥加密，不适合双向 static DH 握手）；
  用 **subtle 原语**——`X25519.computeSharedSecret` 拿 32B 共享 secret，再自管 HKDF + AES-GCM + HMAC。
  subtle 是 low-level API（需自管 nonce/密钥分离），这正是独立 review 要兜底的点。

## 4. Identity Key 生成、存储、pinning

- **Bridge**：启动时若无则生成 X25519 身份密钥对，存 `~/.dsh-mobile/device-key.json`
  （权限 600；存 pubkey b64url + privkey b64url）。
- **Android**：Tink `X25519` 生成密钥对（`X25519.generateKeyPair()`），私钥存 Tink Keyset
  入 Keystore（或私有存储），公钥/私钥各自持有。
- **pinning**：首次配对成功后，双方各自持久化「对方 pubkey + keyId」，之后重连直接复用。

## 5. QR 首次安全配对完整流程（含 MITM 分析）

**配对新字段**：bridge 本地生成一次性 `pairing_secret`（32B 随机），**只进二维码，不进 relay**。
二维码内容扩展：
```
https://<relay>/dshmobile/?mode=pair&code=<pairing_code>
  &pk=<IKb_pub b64url>&ps=<pairing_secret b64url>&cv=1
```

**握手**：
1. Bridge：有 IKb；生成 pairing_secret；出二维码；内存保留 `code → pairing_secret`（TTL 120s，一次性）。
2. Phone：扫码 → 得 `IKb_pub` + `ps` + code；生成 IKp；走既有 code 流程拿 accessToken。
3. Phone → Bridge（经 relay WS，新控制消息 `key.exchange`）：
   ```json
   { "type": "key.exchange",
     "payload": { "pairingId": "...", "deviceId": "...", "pub": "<IKp_pub b64url>",
                  "role": "phone", "auth": "<HMAC b64url>" } }
   ```
   - `auth = HMAC-SHA256(K_ps, pairingCtx)`，`K_ps = HKDF(ikm=ps, salt="dshmobile-e2ee-pairing", info="pairing-auth", L=32)`。
   - **pairingCtx 绑定完整上下文**（防 relay 把 auth 重放到别的配对）：
     ```
     pairingCtx = "dshmobile-e2ee-pairing-v1"
       || u8(1)                                # cryptoVersion
       || u16(len(pairingId)) || pairingId
       || u16(len(deviceId))  || deviceId
       || u16(len(IKb_pub))   || IKb_pub
       || u16(len(IKp_pub))   || IKp_pub
       || u16(len(role))      || role          # "phone"
     ```
4. Bridge：用 `ps` 重算 `auth` 校验（失败即拒，且用后即焚 `ps`）；算 `MS = X25519(IKb_priv, IKp_pub)`；
   pin `IKp_pub`；回应 `ok`。
5. Phone：算 `MS = X25519(IKp_priv, IKb_pub)`；pin `IKb_pub`；双方进入 **pinned-e2ee** 态。

**MITM 分析**：
- bridge→phone 走二维码（视觉 OOB），relay 看不到也改不了 → `IKb_pub`/`ps` 安全到达。
- phone→bridge relay 可替换 `IKp_pub`，但算不出绑定了 pairingId/deviceId/双公钥/role 的 `auth`
  （无 `ps`）→ 替换必被 bridge 拒。
- 结论：双向公钥均认证，`MS` 为两方独有，relay 无法 MITM。**无需每次重连 SAS 人工比对**。
- SAS（`HKDF(MS, info="sas")` 转 6~8 位）保留为**高级验证/异常排查**，非普通流程。

## 6. 首次握手与后续重连（连接 hello + 每连接密钥）

**首次配对**：如上，`key.exchange` 一次完成，pin 后进入 E2EE。

**每次 WS 连接**（E2EE 态）——「连接 hello」建立本连接密钥，**无握手状态持久化**：
1. 双方各自生成一个**新鲜 16B 连接 nonce**：`cNonce_phone`、`cNonce_bridge`。
2. 连接建立后，双方发一条**明文 hello**：`{ "cryptoVersion": 1, "keyId": "...", "cNonce": "<16B b64url>" }`。
   - 明文可被 relay 读取，但 nonce 非机密（只作密钥分离盐），篡改会导致两端密钥不一致 → AEAD 失败 → 硬停止。
3. 双方收到对端 hello 后，用 pinned 公钥 + 自身私钥算静态 `MS`，再配合**双向 nonce** 派生本连接密钥（§7）。
4. 本连接内 `cryptoSeq` 从 0 起，方向单调（§10）。
- **keyId 不符 pinned** → 拒收 + 要求重新配对（§12）。
- 重连即重新 hello + 重新派生密钥，**不持久化 counter、不跨连接复用 key**。

## 7. HKDF / Key Separation（每连接派生）

```
MS = X25519(own_priv, peer_pub)              # 32B 静态 master secret

connCtx = "dshmobile-e2ee-v1"
        || u8(1)                              # cryptoVersion
        || keyId_phone(8B)                    # 固定序：phone 在前
        || keyId_bridge(8B)
        || cNonce_phone(16B)
        || cNonce_bridge(16B)

K_ctrl_p2b = HKDF(salt="dshmobile-e2ee-conn", ikm=MS, info=connCtx || "control:phone->bridge", L=32)
K_ctrl_b2p = HKDF(salt="dshmobile-e2ee-conn", ikm=MS, info=connCtx || "control:bridge->phone", L=32)
# Phase 2 预留（现在不派生不实现，只留 info 约定）：
# K_file_p2b = HKDF(..., info=connCtx || "file:phone->bridge", L=32)
# K_file_b2p = HKDF(..., info=connCtx || "file:bridge->phone", L=32)
```
- `keyId_phone/keyId_bridge` 按**角色固定顺序**（phone 前、bridge 后），两端算出的 `connCtx` 逐字节一致。
- `pairing_secret` 只用于一次性配对认证，不进 `MS`（否则换 secret 就要换全量密钥）。
- domain separation：`salt` 固定、`info` 里含 `connCtx + 方向 + 用途`，杜绝跨方向/跨用途/跨连接复用 key。

## 8. 信封与 AES-GCM payload 格式

E2EE 态信封（在现有 canonical envelope 上加 `crypto`，`payload` 变密文容器）：
```json
{
  "schemaVersion": 1, "kind": "request", "type": "sessions.run",
  "requestId": "...", "sentAt": "...", "actor": {...}, "target": {...},
  "crypto": { "version": 1, "keyId": "<8B hex>", "dir": "p2b", "seq": 7 },
  "meta": { "subscriptionId": "...", "sequence": 7, "eventId": "...", "afterSequence": 0, "now": "..." },
  "payload": { "enc": "aes-256-gcm", "ct": "<b64url: ciphertext||tag>" }
}
```
- `nonce` 不随包传：由 `(dir, seq)` 确定性派生——`nonce = 0x00*3 || u8(dir) || seq 大端 8B`（12B）。
- `ct` = AES-256-GCM 密文 + 16B tag（base64url）。
- `meta`：把 relay 现读的 `subscriptionId/afterSequence/sequence/eventId/now` 从 payload 上移至此（明文）。
- `key.exchange` 与 `hello` 是**明文信封**（无 `crypto`/加密 payload），是仅有的两类例外。

## 9. AAD 确切组成（字节级确定，两端一致）

AAD 覆盖所有 relay 可读、需防篡改的明文字段。**固定顺序、长度前缀二进制拼接**（禁止 JSON）：
```
AAD = "dshmobile-e2ee-aad-v1"
    || u16(len(type)) || type
    || u16(len(requestId)) || requestId
    || u16(len(target.deviceId)) || target.deviceId
    || crypto.keyId(8B raw)
    || u8(crypto.version) || u8(crypto.dir) || u64be(crypto.seq)
    || u16(len(metaCanonical)) || metaCanonical
```
- `metaCanonical` = 对 `meta` 的键做**字典序排序**后，每个键值按
  `u16(len(key)) || key || u16(len(valueStr)) || valueStr` 拼接（值统一转字符串；
  数字用十进制 ASCII，时间用 ISO-8601 原样）。
- `u16/u64` 均**大端**；字符串按 UTF-8 字节；`dir` 编码 `p2b=1, b2p=2`。
- Node 与 Android 各写一个 `canonicalAAD()`，用**同一组测试向量**锁死一致性（§15）。

## 10. nonce/counter 与 replay protection（每连接，不持久化）

- 每连接、每方向一个 **64-bit 单调 counter**：发送 `send_seq`、接收 `recv_seq`（本连接已见最大）。
- 发送：`seq = ++send_seq`，nonce 由 `(dir, seq)` 派生，AES-GCM 加密，`crypto.seq = seq`。
- 接收：`seq <= recv_seq` → 丢弃（防重放）；否则校验 keyId → 解密成功后才 `recv_seq = seq`。
- **连接内**靠 seq 单调防重放；**跨连接**靠每次全新 `cNonce` 派生新 key——旧连接密文在新 key 下
  AEAD 必失败，天然防重放。
- **不持久化 counter**：`send_seq/recv_seq` 仅连接内存态，连接关闭即弃；重连重新 hello、seq 归 0。
- 无需 sliding window：WS 单连接有序，乱序消息直接拒。

## 11. downgrade protection

三态状态机：
- `legacy`（无 E2EE pin）：明文，**仅用户显式选择**，UI 明示「relay 可读内容」。
- `first-pair`：握手进行中。
- `pinned-e2ee`：已 pin。**E2EE 失败 = 硬停止，绝不自动回退明文**。

- 已 pin 设备，relay 无法通过破坏握手/断线/伪造 keyId/篡改 hello 来静默降级：
  重连直接用 pinned key + 新 nonce；keyId 不符或 AEAD 失败 → 拒收 + 提示重配对，不回退明文。
- 旧版本兼容走 `legacy` 模式（显式、有告警），不与 E2EE pin 混用。

## 12. key 改变 / 重装 / 换机 / 解除绑定

- **重装/换机**：新身份密钥 → `keyId` 变 → 对端拒收并提示「需重新配对」；重走 §5 握手。
- **解除绑定/设备吊销**：沿用 relay 现有吊销流程；两端清除 pinned 公钥，回 `legacy`/待配对。
- **主动轮换（可选）**：生成新密钥对 → 重走 §5（即重新配对），v1 不做自动轮换。
- 连接 nonce/counter 是连接内存态，随连接关闭自然失效，无残留状态。

## 13. crypto / schema versioning

- `schemaVersion`（既有，=1）：信封结构版本，未来 v2 仍复用本信封。
- `crypto.version`（=1）：crypto 协议版本，覆盖握手 + hello + record。未来 v2（Noise/PFS）=`2`，
  仅替换 §5/§6/§7/§8 实现，信封 `crypto` 头 + `meta/payload` 结构不变。
- `keyId`：密钥标识，支持未来多 key/轮换。
- `dir` + `seq`：方向与重放计数，独立于业务 sequence。
- 握手版本：v1 由 `crypto.version` 一并表达（二维码 `cv=1`），不单独设。

## 14. Phase 边界

- **Phase 1（本次）**：WS/control plane 的 DSH content E2EE —— 握手、pin、每连接密钥、加解密、AAD、replay、downgrade。
- **Phase 2**：文件层 —— 文件字节加密、filename/targetPath/明文 hash 处理、relay spool 只存密文；
  KDF 已预留 `file:phone->bridge` / `file:bridge->phone` 两个 info 口。
- **Future v2**：ephemeral DH / PFS / Noise，`crypto.version=2`，不重构信封。

## 15. Node ↔ Android 互操作测试

- **KDF/AAD/加解密测试向量**：固定 `(MS, connCtx, dir, seq, type, requestId, targetDeviceId, keyId, meta)`
  的已知向量，Node 与 Android 各自实现，断言输出**逐字节一致**（connCtx、AAD、nonce、AES-GCM 密文）。
- **握手 roundtrip**：Node bridge 与 Android 各走一次 `key.exchange`（含 pairingCtx HMAC），断言 `MS` 一致、互解成功。
- **连接 hello + 密钥派生**：给定双方 keyId + 双向 cNonce，断言两端算出的 `connCtx` 与 `K_ctrl_*` 一致。
- **恶意 relay 注入**：替换 `IKp_pub`（不重算 auth）→ 断言 bridge 拒收；重放旧 `seq` → 丢弃；
  篡改 AAD 明文字段 / 篡改 hello cNonce → 断言 AEAD 失败硬停止（不回退明文）。

## 16. 安全测试与独立 review

- 单元：HKDF/AES-GCM/HMAC 已知向量；nonce 唯一性；每连接 seq 单调；连接关闭后状态清零。
- 集成：§15 全链路；relay 在加密态下无法解析 payload、只能看到 routing/meta + crypto 头 + hello。
- **独立 review（必做）**：威胁模型、密码学参数、pairingCtx/AAD 的 canonicalization、每连接密钥派生、
  replay/downgrade 状态机、密钥存储（Keystore/文件权限）、Tink subtle 用法的 nonce/密钥管理正确性
  —— 至少一次独立评审后放行，不做"自审即通过"。
