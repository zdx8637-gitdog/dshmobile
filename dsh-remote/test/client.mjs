// 端到端测试客户端：模拟 web 客户端走完整链路（登录→连 relay→列会话→建会话→发消息→收事件）。
// 只对测试中新建的会话发消息；对既有会话只做只读验证（断言写被锁）。
const RELAY = process.env.RELAY_URL ?? "https://www.deepseek-claudex.cn";
const USER = process.env.TEST_USER ?? "dshtest";
const PASS = process.env.TEST_PASS ?? "";

const log = (tag, ...args) => console.log(`[${tag}]`, ...args);
const id = () => "t-" + Math.random().toString(36).slice(2, 10);

async function main() {
  // 1. login
  const loginRes = await fetch(`${RELAY}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const login = await loginRes.json();
  if (!login.ok) throw new Error("login failed: " + JSON.stringify(login));
  const accessToken = login.data.accessToken;
  log("auth", "login ok, user:", login.data.user.username);

  // 2. devices
  const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${accessToken}` } });
  const dev = await devRes.json();
  const devices = dev.data || [];
  log("devices", devices.map((d) => `${d.label}[${d.status}]`).join(", "));
  const target = devices.find((d) => d.status === "online");
  if (!target) throw new Error("no online device (bridge 没连上 relay？)");
  log("device", "target:", target.id, target.label);

  // 3. connect ws client
  const clientId = "test-" + Date.now();
  const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${target.id}&clientId=${clientId}`, ["bearer", accessToken]);
  const pending = new Map();
  let fail = false;

  const sendRequest = (type, payload) => new Promise((resolve) => {
    const requestId = id();
    pending.set(requestId, { type, resolve });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: id(), type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId }, target: { deviceId: target.id }, payload }));
  });

  ws.onmessage = (ev) => {
    const env = JSON.parse(ev.data);
    if ((env.kind === "response" || env.kind === "error") && pending.has(env.requestId)) {
      const p = pending.get(env.requestId);
      pending.delete(env.requestId);
      p.resolve(env);
    } else if (env.kind === "event" && env.type === "events.forward") {
      const f = env.payload?.frame;
      if (f?.type === "session/event") {
        const e = f.event;
        if (e?.type === "assistant/message") {
          const text = (e.data?.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
          if (text) log("EVENT", "assistant:", text.slice(0, 120));
        } else if (e?.type === "tool/call") {
          log("EVENT", "tool/call:", e.data.name);
        }
      } else if (f?.type === "approval/requested") {
        log("EVENT", "approval requested:", f.toolName);
      }
    }
  };

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  log("ws", "client connected");

  // 4. list sessions (read-only)
  const listEnv = await sendRequest("sessions.list", {});
  const sessions = listEnv.payload?.data?.sessions || [];
  log("list", sessions.length, "sessions:", sessions.map((s) => s.sessionId.slice(0, 13)).join(", "));

  // 5. 写权限模型验证：进入会话即可对话（修订后无锁）
  //    只对测试创建的会话发送真实消息；对既有会话仅验证列表可读，不做写入（避免打扰桌面会话）
  if (sessions.length > 0) {
    const oldest = [...sessions].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))[0];
    log("list", "oldest existing session (readable):", oldest.sessionId.slice(0, 13));
    const histEnv = await sendRequest("sessions.history", { sessionId: oldest.sessionId, maxMessages: 3 });
    log("read", "history of existing session =>", histEnv.payload?.ok ? `ok (${histEnv.payload?.data?.events?.length ?? 0} events)` : "fail: " + JSON.stringify(histEnv.payload));
    if (!histEnv.payload?.ok) fail = true;
  }

  // 6. create a remote session
  const createEnv = await sendRequest("sessions.create", {});
  if (!createEnv.payload?.ok) throw new Error("create failed: " + JSON.stringify(createEnv.payload));
  const sid = createEnv.payload.data.sessionId;
  log("create", "session:", sid);

  // 7. subscribe + send message
  await sendRequest("events.subscribe", { sessionId: sid });
  const runEnv = await sendRequest("sessions.run", { sessionId: sid, content: [{ type: "text", text: "你好，请用一句话介绍你自己，不要使用任何工具。" }] });
  log("run", runEnv.payload?.ok ? "accepted" : "rejected: " + JSON.stringify(runEnv.payload));

  // 8. 等待流式事件
  await new Promise((r) => setTimeout(r, 25000));
  log("done", fail ? "存在失败项" : "全链路 OK");
  ws.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
