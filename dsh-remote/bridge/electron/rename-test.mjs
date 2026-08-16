// 验证设备改名：用新 label 注册同一 clientDeviceKey，relay 应更新 label 且返回同 deviceId
import { RelayBridge } from "./src/relay.mjs";

const rb = new RelayBridge({
  url: "https://www.deepseek-claudex.cn",
  username: "dshtest",
  password: process.env.TEST_PASS ?? "",
  deviceLabel: "测试改名-家里台式机",
  platform: "windows",
  clientDeviceKey: "dsh-bridge-test-rename",
  stateDir: "./state",
});

const before = await rb.provision();
console.log("first register:", before.deviceId, "label=测试改名-家里台式机");

// 重新注册，换 label
const rb2 = new RelayBridge({
  url: "https://www.deepseek-claudex.cn",
  username: "dshtest",
  password: process.env.TEST_PASS ?? "",
  deviceLabel: "测试改名-公司笔记本",
  platform: "windows",
  clientDeviceKey: "dsh-bridge-test-rename",
  stateDir: "./state",
});
const after = await rb2.provision();
console.log("second register:", after.deviceId, "label=测试改名-公司笔记本");
console.log("same deviceId:", before.deviceId === after.deviceId);

// 用 REST 拉设备列表确认 label 已更新
const login = await fetch("https://www.deepseek-claudex.cn/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }),
}).then((r) => r.json());
const dev = await fetch("https://www.deepseek-claudex.cn/devices", {
  headers: { authorization: `Bearer ${login.data.accessToken}` },
}).then((r) => r.json());
const target = (dev.data ?? []).find((d) => d.id === before.deviceId);
console.log("relay label:", target?.label);
process.exit(target?.label === "测试改名-公司笔记本" ? 0 : 1);
