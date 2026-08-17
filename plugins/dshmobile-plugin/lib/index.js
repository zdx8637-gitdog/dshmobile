// src/index.ts
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
var name = "dshmobile-bridge";
var HERE = path.dirname(fileURLToPath(import.meta.url));
var STATE_DIR = process.env.DSHMOBILE_STATE_DIR || path.join(HERE, "..", "state");
var BRIDGE_MAIN = path.join(HERE, "..", "bridge", "main.js");
var CONFIG_FILE = path.join(STATE_DIR, "config.json");
var KEY_FILE = path.join(STATE_DIR, "machine-key.txt");
var SESSION_FILE = path.join(STATE_DIR, "session.json");
var PANEL_FILE = path.join(STATE_DIR, "panel.json");
var HTTP_PORT = parseInt(process.env.DSHMOBILE_HTTP_PORT ?? "17653", 10);
function defaultState() {
  return {
    enabled: true,
    relayUrl: "https://www.deepseek-claudex.cn",
    username: "",
    password: "",
    deviceLabel: "DSH Bridge",
    mode: "grant",
    pairingCode: "",
    pairingExpiresAt: "",
    grantPairingId: "",
    bridgeStatus: "stopped",
    pairError: "",
    registerError: ""
  };
}
function loadPanelState() {
  try {
    if (!existsSync(PANEL_FILE)) return {};
    const v = JSON.parse(readFileSync(PANEL_FILE, "utf8"));
    const out = {};
    for (const k of ["enabled", "relayUrl", "username", "password", "deviceLabel"]) {
      if (typeof v[k] === "string" || typeof v[k] === "boolean") out[k] = v[k];
    }
    return out;
  } catch {
    return {};
  }
}
function savePanelState(s) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      PANEL_FILE,
      JSON.stringify({
        enabled: s.enabled,
        relayUrl: s.relayUrl,
        username: s.username,
        password: s.password,
        deviceLabel: s.deviceLabel
      })
    );
  } catch (err) {
    console.error("[dshmobile] persist panel state failed:", err?.message);
  }
}
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
function apply(_ctx, _config = {}) {
  let state = { ...defaultState(), ...loadPanelState() };
  let child = null;
  let stopped = false;
  let session = loadSession();
  let grantSecret = "";
  let pollTimer = null;
  let lastConfig = null;
  if (!state.username && session?.username) {
    state = { ...state, username: session.username };
  }
  function patchState(patch) {
    state = { ...state, ...patch };
  }
  let chain = Promise.resolve();
  function scheduleConfig() {
    chain = chain.then(() => onConfig()).catch((err) => console.error("[dshmobile] config error:", err?.message ?? err));
  }
  function stopBridge() {
    if (child) {
      const p = child;
      child = null;
      try {
        p.kill();
      } catch {
      }
    }
    patchState({ bridgeStatus: "stopped" });
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
          patchState({ bridgeStatus: `exited:${code}` });
        }
      });
      child.on("error", (err) => {
        patchState({ bridgeStatus: `error:${err.message}` });
      });
      patchState({ bridgeStatus: "running" });
    } catch (err) {
      patchState({ bridgeStatus: `error:${err?.message ?? err}` });
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
    if (!state.username || !state.password) {
      throw new Error("\u672C\u673A\u5C1A\u672A\u767B\u5F55\uFF1A\u8BF7\u7528\u624B\u673A App \u626B\u7801\u6388\u6743\uFF0C\u6216\u5728\u5361\u7247\u586B\u5199\u8D26\u53F7\u5BC6\u7801");
    }
    const login = await restJson(base, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: state.username, password: state.password })
    });
    return login.data.accessToken;
  }
  async function ensurePairCode() {
    const base = state.relayUrl.replace(/\/$/, "");
    const hasValid = state.mode === "pair" && state.pairingCode && state.pairingExpiresAt && new Date(state.pairingExpiresAt).getTime() > Date.now() + 3e4;
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
      patchState({
        mode: "pair",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: "",
        pairError: ""
      });
    } catch (err) {
      patchState({
        pairError: `\u8D26\u53F7\u5BC6\u7801\u9519\u8BEF\uFF08${String(err?.message ?? err)}\uFF09\uFF0C\u5DF2\u5207\u6362\u4E3A\u6388\u6743\u4E8C\u7EF4\u7801\uFF1A\u7528\u624B\u673A App \u626B\u7801\u5373\u53EF\u6388\u6743\u672C\u673A\u767B\u5F55`
      });
      await ensureGrantCode();
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
          patchState({
            username: state.username || session.username,
            mode: "pair",
            pairingCode: "",
            pairingExpiresAt: "",
            grantPairingId: "",
            bridgeStatus: "granted"
          });
          if (state.enabled) startBridge(state);
          ensurePairCode().catch(() => {
          });
        }
      } catch {
      }
    }, 2e3);
  }
  async function ensureGrantCode() {
    const base = state.relayUrl.replace(/\/$/, "");
    const hasValid = state.mode === "grant" && state.pairingCode && state.pairingExpiresAt && new Date(state.pairingExpiresAt).getTime() > Date.now() + 3e4 && state.grantPairingId && grantSecret;
    if (hasValid && pollTimer) return;
    stopPolling();
    try {
      const created = await restJson(base, "/pairing-codes/device", { method: "POST", body: "{}" });
      grantSecret = created.data.requestSecret;
      patchState({
        mode: "grant",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: created.data.id,
        pairError: ""
      });
      startPolling(base, created.data.id);
    } catch (err) {
      const msg = String(err?.message ?? err);
      patchState({ pairError: msg });
      if (/too many/i.test(msg)) {
        setTimeout(() => {
          ensureGrantCode().catch(() => {
          });
        }, 15e3);
      }
    }
  }
  async function ensureQr() {
    if (session || state.username && state.password) {
      await ensurePairCode();
    } else {
      await ensureGrantCode();
    }
  }
  async function handleRegister(username, password) {
    try {
      const base = state.relayUrl.replace(/\/$/, "");
      await restJson(base, "/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      patchState({ registerError: "" });
    } catch (err) {
      const msg = String(err?.message ?? err);
      const friendly = /already exists/i.test(msg) ? "\u8BE5\u8D26\u53F7\u5DF2\u5B58\u5728\uFF1A\u8BF7\u70B9\u300C\u4FDD\u5B58\u5E76\u8FDE\u63A5\uFF08\u5DF2\u6709\u8D26\u53F7\uFF09\u300D\u76F4\u63A5\u767B\u5F55" : msg;
      patchState({ registerError: friendly });
    }
  }
  async function handleLogout() {
    session = null;
    grantSecret = "";
    stopPolling();
    try {
      rmSync(SESSION_FILE, { force: true });
    } catch {
    }
    stopBridge();
    patchState({
      username: "",
      password: "",
      mode: "grant",
      pairingCode: "",
      pairingExpiresAt: "",
      grantPairingId: "",
      registerError: "",
      pairError: ""
    });
    savePanelState(state);
    scheduleConfig();
  }
  async function onConfig() {
    const next = { ...state };
    const prev = lastConfig;
    lastConfig = next;
    const shouldRun = next.enabled && (session !== null || Boolean(next.username && next.password));
    const prevShouldRun = prev ? prev.enabled && (session !== null || Boolean(prev.username && prev.password)) : false;
    const cfgChanged = !prev || prev.relayUrl !== next.relayUrl || prev.username !== next.username || prev.password !== next.password || prev.deviceLabel !== next.deviceLabel || prev.enabled !== next.enabled;
    if (cfgChanged || !child && shouldRun) {
      if (shouldRun) startBridge(next);
      else stopBridge();
    }
    const credsChanged = !prev || prev.username !== next.username || prev.password !== next.password;
    if (credsChanged || !next.pairingCode) {
      await ensureQr();
    }
  }
  async function handleAction(action, payload) {
    switch (action) {
      case "save": {
        for (const k of ["relayUrl", "username", "password", "deviceLabel", "enabled"]) {
          if (payload && payload[k] !== void 0) state[k] = payload[k];
        }
        savePanelState(state);
        scheduleConfig();
        break;
      }
      case "register": {
        const u = String(payload?.username ?? "").trim();
        const p = String(payload?.password ?? "");
        if (!u || !p) throw new Error("\u8D26\u53F7/\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A");
        state.username = u;
        state.password = p;
        savePanelState(state);
        handleRegister(u, p).catch((err) => console.error("[dshmobile] register error:", err?.message ?? err));
        scheduleConfig();
        break;
      }
      case "logout": {
        await handleLogout();
        break;
      }
      case "refreshPairing": {
        patchState({ pairingCode: "", pairingExpiresAt: "" });
        scheduleConfig();
        break;
      }
      default:
        throw new Error("unknown action: " + action);
    }
  }
  function startServer() {
    const server2 = createServer((req, res) => {
      const origin = String(req.headers.origin ?? "");
      const corsOk = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
      const headers = {
        "Access-Control-Allow-Origin": corsOk ? origin : "null",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      const send = (code, body) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/state") {
        send(200, { ok: true, data: state });
        return;
      }
      if (req.method === "POST" && url.pathname === "/action") {
        let raw = "";
        req.on("data", (c) => {
          raw += c;
        });
        req.on("end", () => {
          (async () => {
            try {
              const body = JSON.parse(raw || "{}");
              await handleAction(body.action, body.payload);
              send(200, { ok: true });
            } catch (err) {
              send(200, { ok: false, error: { message: String(err?.message ?? err) } });
            }
          })();
        });
        return;
      }
      send(404, { ok: false, error: { message: "not found" } });
    });
    server2.on("error", (err) => {
      console.error(`[dshmobile] panel http server error (port ${HTTP_PORT}):`, err?.message ?? err);
    });
    server2.listen(HTTP_PORT, "127.0.0.1");
    return server2;
  }
  const server = startServer();
  scheduleConfig();
  return () => {
    stopped = true;
    stopPolling();
    stopBridge();
    try {
      server.close();
    } catch {
    }
  };
}
export {
  apply,
  name
};
