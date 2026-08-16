// 宿主半边冒烟：mock settings scope，跑通 配置监听 → 桥启停 → 配对出码 全逻辑。
// 用法：node scripts/smoke-host.mjs <username> <password>
import { apply } from "../lib/index.js";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("usage: node scripts/smoke-host.mjs <relayUser> <relayPass>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let value = {
  enabled: false,
  relayUrl: "https://www.deepseek-claudex.cn",
  username,
  password,
  deviceLabel: "DSH Bridge (smoke)",
  pairingCode: "",
  pairingExpiresAt: "",
  refreshPairing: false,
  bridgeStatus: "stopped",
};
const watchers = [];
const scope = {
  get: () => value,
  watch: (cb) => { watchers.push(cb); return () => {}; },
  update: async (patch) => {
    const prev = value;
    value = { ...value, ...patch };
    for (const cb of watchers) await cb(value, prev);
  },
  replace: async () => {},
};

const ctx = { settings: { register: () => scope } };
const dispose = apply(ctx, {});

console.log("t0: initial", JSON.stringify(value.bridgeStatus));

await scope.update({ enabled: true }); // watch 触发 → 启动桥
await sleep(4000);
console.log("t1 after enable:", JSON.stringify(value.bridgeStatus));

await scope.update({ refreshPairing: true }); // 出码
await sleep(3000);
console.log("t2 pairing:", JSON.stringify({ code: value.pairingCode, exp: value.pairingExpiresAt, status: value.bridgeStatus }));
if (!/^\d{6}$/.test(value.pairingCode)) {
  console.error("PAIRING FAILED");
  dispose();
  process.exit(1);
}

await scope.update({ enabled: false }); // 停桥
await sleep(1500);
console.log("t3 after disable:", JSON.stringify(value.bridgeStatus));

// 注册路径：随机新账号 → 写 registerRequest → 宿主调 /auth/register → 桥随配置自动启动
const freshU = "smoke" + Math.random().toString(36).slice(2, 10);
const freshP = "Smoke" + Math.random().toString(36).slice(2, 10);
await scope.update({
  enabled: true,
  username: freshU,
  password: freshP,
  registerRequest: JSON.stringify({ username: freshU, password: freshP }),
});
await sleep(5000);
console.log("t4 after register:", JSON.stringify({ user: freshU, error: value.registerError, status: value.bridgeStatus }));
if (value.registerError) {
  console.error("REGISTER FAILED");
  dispose();
  process.exit(1);
}

await scope.update({ enabled: false });
await sleep(1000);
dispose();
console.log("SMOKE OK");
process.exit(0);
