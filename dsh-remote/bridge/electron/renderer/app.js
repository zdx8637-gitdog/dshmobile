// 渲染层：订阅主进程状态，驱动左右滑动视图切换 + 记住密码
const $ = (id) => document.getElementById(id);

const slider = $("slider");
const viewLogin = $("view-login");
const viewRunning = $("view-running");

// ---------- 记住密码（仅本机 localStorage，demo 期明文；接真逻辑后换 safeStorage） ----------
const REMEMBER_KEY = "dsh.bridge.remember";
const DEVICE_NAME_KEY = "dsh.bridge.deviceName";

function loadRemember() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (raw) {
      const { username, password } = JSON.parse(raw);
      $("username").value = username || "";
      $("password").value = password || "";
      $("remember").checked = true;
    }
    $("devicename").value = localStorage.getItem(DEVICE_NAME_KEY) || "";
  } catch { /* 损坏则忽略 */ }
}

function saveRemember() {
  if (!$("remember").checked) {
    localStorage.removeItem(REMEMBER_KEY);
  } else {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({
      username: $("username").value.trim(),
      password: $("password").value,
    }));
  }
  // 设备名始终记住（非敏感）
  localStorage.setItem(DEVICE_NAME_KEY, $("devicename").value.trim());
}

// ---------- 状态应用 ----------
function applyState(s) {
  const running = s.view === "running";
  slider.classList.toggle("running", running);

  if (running) {
    $("account").textContent = s.username || "-";
    $("device-label").textContent = s.deviceLabel;
    $("relay-url").textContent = s.server;
    $("dsh-url").textContent = s.dshUrl;

    setDot($("relay-dot"), $("relay-status"), s.relayOnline, s.relayConnecting);
    setDot($("dsh-dot"), $("dsh-status"), s.dshOnline, s.dshConnecting);

    $("log").textContent = s.lastEvent || "—";
  } else {
    $("server").value = s.server || $("server").value;
    $("login-error").hidden = !s.error;
    $("login-error").textContent = s.error || "";
  }
}

function setDot(dotEl, statusEl, online, connecting) {
  dotEl.className = "dot" + (online ? " online" : connecting ? " connecting" : "");
  statusEl.textContent = online ? "已连接" : connecting ? "连接中…" : "未连接";
}

// ---------- 事件 ----------
$("btn-login").addEventListener("click", async () => {
  $("login-error").hidden = true;
  const ok = await window.bridge.login({
    server: $("server").value.trim(),
    username: $("username").value.trim(),
    password: $("password").value,
    deviceName: $("devicename").value.trim(),
  });
  if (ok?.ok) saveRemember();
});

$("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});

$("btn-quit-login").addEventListener("click", () => window.bridge.quit());
$("btn-quit-running").addEventListener("click", () => window.bridge.quit());
$("btn-logout").addEventListener("click", () => window.bridge.logout());

// ---------- 启动 ----------
loadRemember();
window.bridge.onState(applyState);
window.bridge.getState().then(applyState);
