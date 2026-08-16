// Electron 主进程：窗口 + 托盘 + 状态桥接。真实 bridge 逻辑经 bridge-runtime.mjs 接入。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

let win = null;
let tray = null;
let runtime = null; // BridgeRuntime 实例（登录后创建）
let currentState = {
  view: "login",            // login | running
  server: "https://www.deepseek-claudex.cn",
  username: "",
  deviceLabel: "DSH Bridge (windows-p)",
  dshUrl: "http://127.0.0.1:3080",
  relayOnline: false,
  relayConnecting: false,
  dshOnline: false,
  dshConnecting: false,
  lastEvent: "",
  error: "",
};

function sendState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("state", currentState);
  }
  updateTray();
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 620,
    resizable: false,
    frame: true,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("close", (e) => {
    // 关闭窗口 = 最小化到托盘（运行态）或退出（登录态）
    if (currentState.view === "running") {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => { win = null; });
}

function updateTray() {
  if (!tray) return;
  const online = currentState.relayOnline && currentState.dshOnline;
  const label = currentState.view === "running"
    ? (online ? "DSH Bridge · 在线" : "DSH Bridge · 连接中")
    : "DSH Bridge · 未登录";
  tray.setToolTip(label);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: "separator" },
    {
      label: "打开窗口",
      click: () => { if (win) { win.show(); win.focus(); } },
    },
    ...(currentState.view === "running" ? [
      {
        label: "退出并断开",
        click: async () => {
          runtime?.stop();
          runtime = null;
          currentState = { ...currentState, view: "login", relayOnline: false, dshOnline: false, relayConnecting: false, dshConnecting: false, username: "", error: "", lastEvent: "" };
          sendState();
          if (win) { win.show(); win.focus(); }
        },
      },
    ] : []),
    { type: "separator" },
    { label: "退出应用", click: () => { runtime?.stop(); app.quit(); } },
  ]));
}

function createTray() {
  // 无图标资源时用空图（Windows 托盘仍显示）
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  updateTray();
  tray.on("double-click", () => { if (win) { win.show(); win.focus(); } });
}

// ---------- IPC：渲染层动作 ----------

ipcMain.handle("get-state", () => currentState);

ipcMain.handle("login", async (_evt, { server, username, password, deviceName }) => {
  currentState.server = server;
  currentState.username = username;
  currentState.error = "";

  try {
    // 动态导入真实 bridge 运行时
    const { BridgeRuntime } = await import(pathToFileURL(path.join(__dirname, "bridge-runtime.mjs")).href);
    const rt = new BridgeRuntime({
      onState: (patch) => {
        currentState = { ...currentState, ...patch };
        sendState();
      },
    });
    await rt.login({ server, username, password, deviceName });
    runtime = rt;

    currentState.view = "running";
    currentState.relayConnecting = true;
    currentState.dshConnecting = true;
    currentState.lastEvent = "登录成功，正在连接…";
    sendState();

    rt.start();
    return { ok: true };
  } catch (err) {
    currentState.error = String(err?.message ?? err).replace(/^.*?failed: HTTP \d+ /, "") || "登录失败";
    sendState();
    return { ok: false };
  }
});

ipcMain.handle("logout", () => {
  runtime?.stop();
  runtime = null;
  currentState = {
    ...currentState,
    view: "login",
    username: "",
    relayOnline: false,
    dshOnline: false,
    relayConnecting: false,
    dshConnecting: false,
    lastEvent: "",
    error: "",
  };
  sendState();
});

// 扫码登录（方向一）：以当前登录账号出一次性配对码（6 位，300s 有效）。
ipcMain.handle("pairing-generate", async () => {
  const relay = runtime?.relay;
  if (!relay?.username || !relay?.password) {
    return { ok: false, error: "尚未登录" };
  }
  try {
    const base = relay.url.replace(/\/$/, "");
    const loginRes = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: relay.username, password: relay.password }),
    });
    const login = await loginRes.json();
    if (!loginRes.ok || login.ok === false) {
      return { ok: false, error: "登录失败，无法出码" };
    }
    const createRes = await fetch(`${base}/pairing-codes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${login.data.accessToken}`,
      },
      body: "{}",
    });
    const created = await createRes.json();
    if (!createRes.ok || created.ok === false) {
      return { ok: false, error: "出码失败" };
    }
    return {
      ok: true,
      code: created.data.code,
      expiresAt: created.data.expiresAt,
      relay: base,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

ipcMain.handle("quit", () => {
  runtime?.stop();
  app.quit();
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  app.on("activate", () => {
    if (win === null) createWindow();
  });
});

app.on("before-quit", () => {
  runtime?.stop();
});

app.on("window-all-closed", () => {
  // 保留托盘，不退出（托盘退出应用显式调用）
});

