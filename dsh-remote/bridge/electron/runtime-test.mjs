// 验证真实 BridgeRuntime 登录+连接（GUI 之外的逻辑层测试）
import { BridgeRuntime } from "../electron/bridge-runtime.mjs";

const events = [];
const rt = new BridgeRuntime({ onState: (patch) => { events.push(patch); console.log("[state]", JSON.stringify(patch).slice(0, 120)); } });

console.log("=== login test ===");
try {
  const deviceId = await rt.login({ server: "https://www.deepseek-claudex.cn", username: "dshtest", password: process.env.TEST_PASS ?? "" });
  console.log("login OK, deviceId:", deviceId);
} catch (e) {
  console.log("login FAIL:", e.message);
  process.exit(1);
}

console.log("=== start (connect relay + DSH) ===");
rt.start();

// 等 8 秒观察状态，然后停止
setTimeout(() => {
  const relayOnline = events.some((e) => e.relayOnline === true);
  const dshOnline = events.some((e) => e.dshOnline === true);
  console.log("relayOnline seen:", relayOnline, "| dshOnline seen:", dshOnline);
  rt.stop();
  setTimeout(() => process.exit(relayOnline && dshOnline ? 0 : 1), 500);
}, 8000);
