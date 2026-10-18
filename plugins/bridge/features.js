/**
 * 产品功能开关。
 *
 * ## E2EE 为什么整层停用（2026-10-18 拍板）
 *
 * 桥端 E2EE 是「**单设备 + 全局连接密钥**」结构：`E2eeSession` 只有一个 `pinnedPeer`、一个 `conn`，
 * 而 `relay.send()` 只要 `isConnectionEstablished` 就整包加密、**不看收件人**，`events.forward` 又是
 * 扇出到该设备所有客户端。于是它和「手机 + 虚拟机 + 以后平板同时连」在结构上互斥：
 *   · 手机配过对以后，任何明文客户端（重装 App 的手机、第二台设备、模拟器）都拿不到业务响应；
 *   · 策略层（require / allowPlaintext / E2EE_REQUIRED）还带来"放行后请求被静默丢弃"这类故障
 *     （`relay.decryptEnvelope` 已建立分支缺 `return env`），排查成本极高。
 *
 * 产品上 E2EE 从来不是用户需求（自己脑补的），所以先停用：
 *   · 不构造 `E2eeSession` → relay 的加解密全程透传，策略层自然失效；
 *   · 代码（`e2ee.js` / `crypto.js` / 信封 `crypto` 字段 / App 侧 `E2eeSession`）**全部保留**，
 *     将来若要做「每客户端密钥 + 每客户端事件」的 E2EE v2，直接在这个开关上重做。
 *
 * ⚠ 重新打开前必须满足：每客户端独立密钥、事件按客户端分别加密、且拒绝路径必须回显式错误
 *   （绝不允许出现"放行了却没回包"）。
 */
export const E2EE_ENABLED = false;
