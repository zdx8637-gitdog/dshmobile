// src/index.ts
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
var name = "dshmobile-bridge";
var inject = ["settings"];
var NS = settingsNamespace("dshmobile");
var HERE = path.dirname(fileURLToPath(import.meta.url));
var STATE_DIR = path.join(HERE, "..", "state");
var BRIDGE_MAIN = path.join(HERE, "..", "bridge", "main.js");
var CONFIG_FILE = path.join(STATE_DIR, "config.json");
var KEY_FILE = path.join(STATE_DIR, "machine-key.txt");
var SESSION_FILE = path.join(STATE_DIR, "session.json");
var schema = z.object({
  enabled: z.boolean().default(true),
  relayUrl: z.string().default("https://www.deepseek-claudex.cn"),
  username: z.string().default(""),
  password: z.string().default(""),
  deviceLabel: z.string().default("DSH Bridge"),
  // 常驻二维码（两种模式共用一个码位，内容按登录态切换）
  mode: z.string().default("grant"),
  // "pair" | "grant"
  pairingCode: z.string().default(""),
  pairingExpiresAt: z.string().default(""),
  grantPairingId: z.string().default(""),
  refreshPairing: z.boolean().default(false),
  bridgeStatus: z.string().default("stopped"),
  pairError: z.string().default(""),
  registerRequest: z.string().default(""),
  registerError: z.string().default(""),
  // 退出登录通道：清除本机会话（含手机授权登录的）并转回 grant 模式
  logoutRequest: z.boolean().default(false)
});
function machineGuid() {
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    if (m) return m[1];
  } catch {
  }
  return null;
}
function stableMachineKey() {
  const guid = machineGuid();
  if (guid) return `dsh-bridge-${guid}`;
  try {
    if (existsSync(KEY_FILE)) {
      const v2 = readFileSync(KEY_FILE, "utf8").trim();
      if (v2) return v2;
    }
    mkdirSync(STATE_DIR, { recursive: true });
    const v = `dsh-bridge-${crypto.randomUUID()}`;
    writeFileSync(KEY_FILE, v);
    return v;
  } catch {
    return `dsh-bridge-${Math.random().toString(36).slice(2)}`;
  }
}
function loadSession() {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const s = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (s?.accessToken && s?.refreshToken && s?.username) return s;
  } catch {
  }
  return null;
}
function saveSession(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s));
}
function apply(ctx, _config = {}) {
  const scope = ctx.settings.register(NS, schema, { applies: "live" });
  let child = null;
  let stopped = false;
  let session = loadSession();
  let grantSecret = "";
  let pollTimer = null;
  let current = null;
  let busy = false;
  function stopBridge() {
    if (child) {
      const p = child;
      child = null;
      try {
        p.kill();
      } catch {
      }
    }
    scope.update({ bridgeStatus: "stopped" }).catch(() => {
    });
  }
  function startBridge(value) {
    stopBridge();
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const cfg = {
        relay: {
          url: value.relayUrl,
          username: value.username || session?.username || "",
          password: value.password || "",
          // 手机授权模式：token 直用（无密码）；账号密码模式：这两个为空
          accessToken: session?.accessToken ?? "",
          refreshToken: session?.refreshToken ?? "",
          deviceLabel: value.deviceLabel || "DSH Bridge",
          platform: "windows",
          clientDeviceKey: stableMachineKey()
        },
        dsh: { url: "http://127.0.0.1:3080" },
        stateDir: STATE_DIR
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      child = spawn(process.execPath, [BRIDGE_MAIN], {
        env: { ...process.env, DSHMOBILE_BRIDGE_CONFIG: CONFIG_FILE },
        stdio: "ignore"
      });
      child.on("exit", (code) => {
        if (!stopped && code !== null) {
          scope.update({ bridgeStatus: `exited:${code}` }).catch(() => {
          });
        }
      });
      child.on("error", (err) => {
        scope.update({ bridgeStatus: `error:${err.message}` }).catch(() => {
        });
      });
      scope.update({ bridgeStatus: "running" }).catch(() => {
      });
    } catch (err) {
      scope.update({ bridgeStatus: `error:${err?.message ?? err}` }).catch(() => {
      });
    }
  }
  async function restJson(base, pathname, options = {}) {
    const res = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers ?? {} }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
  async function obtainAccessToken(base) {
    if (session?.accessToken) return session.accessToken;
    const v = current;
    if (!v?.username || !v?.password) {
      throw new Error("\u672C\u673A\u5C1A\u672A\u767B\u5F55\uFF1A\u8BF7\u7528\u624B\u673A App \u626B\u7801\u6388\u6743\uFF0C\u6216\u5728\u5361\u7247\u586B\u5199\u8D26\u53F7\u5BC6\u7801");
    }
    const login = await restJson(base, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: v.username, password: v.password })
    });
    return login.data.accessToken;
  }
  async function ensurePairCode(value) {
    const base = value.relayUrl.replace(/\/$/, "");
    const hasValid = value.mode === "pair" && value.pairingCode && value.pairingExpiresAt && new Date(value.pairingExpiresAt).getTime() > Date.now() + 3e4;
    if (hasValid) return;
    try {
      const accessToken = await obtainAccessToken(base);
      let created;
      try {
        created = await restJson(base, "/pairing-codes", {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
          body: "{}"
        });
      } catch (err) {
        if (session?.refreshToken && (err.status === 401 || err.status === 403)) {
          const rf = await restJson(base, "/auth/refresh", {
            method: "POST",
            body: JSON.stringify({ refreshToken: session.refreshToken })
          });
          session = {
            ...session,
            accessToken: rf.data.accessToken,
            refreshToken: rf.data.refreshToken ?? session.refreshToken
          };
          saveSession(session);
          created = await restJson(base, "/pairing-codes", {
            method: "POST",
            headers: { authorization: `Bearer ${rf.data.accessToken}` },
            body: "{}"
          });
        } else {
          throw err;
        }
      }
      await scope.update({
        mode: "pair",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: "",
        pairError: ""
      });
    } catch (err) {
      await scope.update({
        pairError: `\u8D26\u53F7\u5BC6\u7801\u9519\u8BEF\uFF08${String(err?.message ?? err)}\uFF09\uFF0C\u5DF2\u5207\u6362\u4E3A\u6388\u6743\u4E8C\u7EF4\u7801\uFF1A\u7528\u624B\u673A App \u626B\u7801\u5373\u53EF\u6388\u6743\u672C\u673A\u767B\u5F55`
      });
      await ensureGrantCode(value);
    }
  }
  async function ensureGrantCode(value) {
    const base = value.relayUrl.replace(/\/$/, "");
    const hasValid = value.mode === "grant" && value.pairingCode && value.pairingExpiresAt && new Date(value.pairingExpiresAt).getTime() > Date.now() + 3e4 && value.grantPairingId && grantSecret;
    if (hasValid && pollTimer) return;
    stopPolling();
    try {
      const created = await restJson(base, "/pairing-codes/device", { method: "POST", body: "{}" });
      grantSecret = created.data.requestSecret;
      await scope.update({
        mode: "grant",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: created.data.id,
        pairError: ""
      });
      startPolling(base, created.data.id);
    } catch (err) {
      const msg = String(err?.message ?? err);
      await scope.update({ pairError: msg });
      if (/too many/i.test(msg)) {
        setTimeout(() => {
          ensureGrantCode(current ?? value).catch(() => {
          });
        }, 15e3);
      }
    }
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function startPolling(base, pairingId) {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!grantSecret) return;
      try {
        const res = await restJson(
          base,
          `/pairing-codes/${pairingId}/status?secret=${encodeURIComponent(grantSecret)}`,
          { method: "GET" }
        );
        if (res.data?.status === "granted") {
          stopPolling();
          grantSecret = "";
          session = {
            accessToken: res.data.accessToken,
            refreshToken: res.data.refreshToken,
            username: res.data.user?.username ?? ""
          };
          saveSession(session);
          const v = current;
          await scope.update({
            username: v?.username || session.username,
            mode: "pair",
            pairingCode: "",
            pairingExpiresAt: "",
            grantPairingId: "",
            bridgeStatus: "granted"
          });
          if (v && v.enabled) startBridge(v);
          ensurePairCode(current).catch(() => {
          });
        }
      } catch {
      }
    }, 2e3);
  }
  async function ensureQr(value) {
    if (session || value.username && value.password) {
      await ensurePairCode(value);
    } else {
      await ensureGrantCode(value);
    }
  }
  async function handleRegister(request) {
    try {
      const { username: u, password: p } = JSON.parse(request);
      if (!u || !p) throw new Error("\u8D26\u53F7/\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A");
      const base = (current?.relayUrl ?? "").replace(/\/$/, "");
      await restJson(base, "/auth/register", {
        method: "POST",
        body: JSON.stringify({ username: u, password: p })
      });
      await scope.update({ registerRequest: "", registerError: "" });
    } catch (err) {
      const msg = String(err?.message ?? err);
      const friendly = /already exists/i.test(msg) ? "\u8BE5\u8D26\u53F7\u5DF2\u5B58\u5728\uFF1A\u8BF7\u70B9\u300C\u4FDD\u5B58\u5E76\u8FDE\u63A5\uFF08\u5DF2\u6709\u8D26\u53F7\uFF09\u300D\u76F4\u63A5\u767B\u5F55" : msg;
      await scope.update({ registerRequest: "", registerError: friendly });
    }
  }
  async function onConfig(next) {
    const prev = current;
    current = next;
    if (busy) return;
    busy = true;
    try {
      const shouldRun = next.enabled && (session !== null || Boolean(next.username && next.password));
      const prevShouldRun = prev ? prev.enabled && (session !== null || Boolean(prev.username && prev.password)) : false;
      const cfgChanged = !prev || prev.relayUrl !== next.relayUrl || prev.username !== next.username || prev.password !== next.password || prev.deviceLabel !== next.deviceLabel || prev.enabled !== next.enabled;
      if (cfgChanged || !child && shouldRun) {
        if (shouldRun) startBridge(next);
        else stopBridge();
      }
      if (next.registerRequest) {
        await handleRegister(next.registerRequest);
      }
      if (next.logoutRequest) {
        session = null;
        grantSecret = "";
        stopPolling();
        try {
          rmSync(SESSION_FILE, { force: true });
        } catch {
        }
        stopBridge();
        await scope.update({
          logoutRequest: false,
          username: "",
          password: "",
          mode: "grant",
          pairingCode: "",
          pairingExpiresAt: "",
          grantPairingId: "",
          registerError: "",
          pairError: ""
        });
      }
      if (next.refreshPairing) {
        await scope.update({ refreshPairing: false, pairingCode: "", pairingExpiresAt: "" });
      }
      const credsChanged = !prev || prev.username !== next.username || prev.password !== next.password;
      if (next.refreshPairing || credsChanged || !next.pairingCode) {
        await ensureQr(next);
      }
    } finally {
      busy = false;
    }
  }
  const offWatch = scope.watch((next) => {
    onConfig(next).catch(() => {
    });
  });
  onConfig(scope.get()).catch(() => {
  });
  return () => {
    stopped = true;
    offWatch();
    stopPolling();
    stopBridge();
  };
}
export {
  apply,
  inject,
  name
};
