// 生成跨平台 golden vectors：固定输入 → 期望输出（Node 计算），Android 端据此断言逐字节一致。
// 用法：node scripts/gen-golden.mjs  （输出写到 scripts/e2ee-golden.json）
import { writeFileSync } from "node:fs";
import {
  computeSharedSecret, connectionContext, deriveConnectionKeys, canonicalAAD,
  encryptPayload, nonceFor, keyIdOf, toB64url, DIR,
} from "../bridge/crypto.js";

const hex = (s) => Buffer.from(s, "hex");
const b64 = (s) => toB64url(hex(s));

// 固定身份密钥（RFC 7748 Alice/Bob 原始值）
const phonePriv = b64("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const phonePubRaw = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const bridgePriv = b64("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
const bridgePubRaw = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
const phoneKeyId = keyIdOf(phonePubRaw);
const bridgeKeyId = keyIdOf(bridgePubRaw);

const ms = computeSharedSecret(phonePriv, toB64url(bridgePubRaw));
const cNoncePhone = toB64url(hex("01".repeat(16)));
const cNonceBridge = toB64url(hex("02".repeat(16)));

const connCtx = connectionContext({ keyIdPhoneHex: phoneKeyId, keyIdBridgeHex: bridgeKeyId, cNoncePhoneB64url: cNoncePhone, cNonceBridgeB64url: cNonceBridge });
const keys = deriveConnectionKeys(ms, connCtx);

const meta = { subscriptionId: "s-1", sequence: 7, now: "2026-08-23T00:00:00.000Z" };
const aad = canonicalAAD({ type: "sessions.run", requestId: "req-1", targetDeviceId: "dev-1", keyIdHex: phoneKeyId, version: 1, dir: DIR.p2b, seq: 1, meta });
const nonce = nonceFor(DIR.p2b, 1);
const plaintext = "hello e2ee";
const { ct } = encryptPayload({ key: keys.p2b, dir: DIR.p2b, seq: 1, aad, plaintext });

const golden = {
  note: "E2EE v1 golden vectors（Node 计算，Android 端逐字节断言）",
  inputs: {
    phonePriv_b64url: phonePriv,
    phonePub_hex: phonePubRaw.toString("hex"),
    bridgePriv_b64url: bridgePriv,
    bridgePub_hex: bridgePubRaw.toString("hex"),
    cNoncePhone_b64url: cNoncePhone,
    cNonceBridge_b64url: cNonceBridge,
    keyIdPhone_hex: phoneKeyId,
    keyIdBridge_hex: bridgeKeyId,
    type: "sessions.run",
    requestId: "req-1",
    targetDeviceId: "dev-1",
    dir: DIR.p2b,
    seq: 1,
    meta,
    plaintext,
  },
  expected: {
    ms_hex: ms.toString("hex"),
    connCtx_hex: connCtx.toString("hex"),
    K_ctrl_p2b_hex: keys.p2b.toString("hex"),
    K_ctrl_b2p_hex: keys.b2p.toString("hex"),
    aad_hex: aad.toString("hex"),
    nonce_hex: nonce.toString("hex"),
    ct_b64url: ct,
  },
};

writeFileSync(new URL("./e2ee-golden.json", import.meta.url), JSON.stringify(golden, null, 2));
console.log(JSON.stringify(golden, null, 2));
