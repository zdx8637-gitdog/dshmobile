// E2EE 明文策略（bridge 侧）：e2ee-policy.json =「本机是否要求端到端加密」。
// 语义：require=true（默认，文件不存在即视为 true）＝ 要求 E2EE；
//       require=false ＝ 用户已**明确选择**「永久非加密」（e2ee.allowPlaintext mode=permanent / e2ee.clear）。
// 位置：stateDir 下，与 device-key.json 同级。写盘原子（tmp+rename，同 e2ee.js #save），读坏按默认 true 且不抛。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 策略文件名（stateDir 下）。 */
export const POLICY_FILE_NAME = "e2ee-policy.json";

/** 明确要求 E2EE 所需的最低客户端 appVersion（低于此版本/未上报版本 → fail-open 放行明文，老 App 不被卡死）。 */
export const REQUIRE_E2EE_MIN_VERSION = "0.2.21";

/** 数字段形式的最低版本（与 REQUIRE_E2EE_MIN_VERSION 一一对应）。 */
const MIN_SEGMENTS = [0, 2, 21];

/**
 * 解析版本号的前导数字段："0.2.21-beta.1" → [0,2,21]；"v1.0" → [1,0]。
 * 非字符串 / 空 / 无前导数字（"abc"）/ 段超出安全整数 → null（调用方按「未知版本」处理）。
 */
export function parseVersionSegments(version) {
  if (typeof version !== "string") return null;
  const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(version);
  if (!m) return null;
  const segments = m[1].split(".").map((s) => Number(s));
  if (segments.length === 0 || segments.some((n) => !Number.isSafeInteger(n))) return null;
  return segments;
}

/** 版本比较：a >= b → true（缺失的段按 0 补齐，例如 "1.0" >= "0.2.21"）。 */
export function versionAtLeast(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * §5 版本闸门：该客户端 appVersion 是否明确支持「E2EE 默认强制」新协议。
 * 非字符串/空/无法解析 → false（= 未知版本 → fail-open 放行明文）。
 * 预发布后缀只取前导数字段："0.2.21-beta.1" → 按 ≥0.2.21 处理 → true；"0.2.20-rc.1" → false。
 */
export function supportsRequireE2ee(version) {
  const segments = parseVersionSegments(version);
  if (!segments) return false;
  return versionAtLeast(segments, MIN_SEGMENTS);
}

/**
 * 持久化策略：{ require: boolean }。
 * 只做「读/写一个布尔」这一件事，由 E2eeSession 持有（e2ee.require / e2ee.setRequire）。
 */
export class E2eePolicy {
  constructor({ stateDir } = {}) {
    this.stateDir = stateDir ?? null;
    this.file = this.stateDir ? join(this.stateDir, POLICY_FILE_NAME) : null;
    this.require = this.#load();
  }

  /** 读：文件不存在/不可读/坏 JSON/字段类型不对 → 默认 true（要求加密），绝不抛。 */
  #load() {
    if (!this.file) return true;
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof d?.require === "boolean") return d.require;
      this.loadWarning = `${POLICY_FILE_NAME} 缺少布尔字段 require，按默认 true 处理`;
    } catch (err) {
      // 文件不存在是正常情况（默认 true）；文件存在却读坏才留痕（便于诊断"谁把策略写坏了"）。
      if (existsSync(this.file)) this.loadWarning = `${POLICY_FILE_NAME} 解析失败：${err?.message ?? err}`;
    }
    return true;
  }

  /** 写：原子（tmp+rename）+ 容错（写失败不影响内存态）。返回落定后的布尔值。 */
  setRequire(value) {
    this.require = value === true;
    if (!this.file) return this.require;
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const body = JSON.stringify({ require: this.require }, null, 2);
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* 写盘失败：内存态仍生效（本次运行按新策略执行），下次启动回到文件里的旧值 */
    }
    return this.require;
  }
}
