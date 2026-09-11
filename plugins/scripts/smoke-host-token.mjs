// smoke-host-token.mjs：模拟 DSH 启动链（fake ctx + connection 服务注入），
// 验证 host 半边：inject 注册、authenticatedUrl 取 token、env 端口回退、重复注入不崩溃。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "dshmobile-host-"));
process.env.DSHMOBILE_STATE_DIR = stateDir;
process.env.DSHMOBILE_HTTP_PORT = "17999";
process.env.DSHMOBILE_DSH_URL = "http://127.0.0.1:17998";
// enabled=false：不启动桥（不 spawn 子进程），但 token 获取逻辑照跑
writeFileSync(join(stateDir, "panel.json"), JSON.stringify({ relayUrl: "http://127.0.0.1:9", enabled: false }));

const { apply } = await import("../lib/index.js");

let capturedCb = null;
const authCalls = [];
const fakeCtx = {
  inject(services, cb) {
    if (JSON.stringify(services) === JSON.stringify(["connection"])) capturedCb = cb;
  },
};

const dispose = apply(fakeCtx, {});
await new Promise((r) => setTimeout(r, 300));

let failures = 0;
const check = (n, c, e = "") => {
  if (c) console.log("  PASS", n);
  else { failures += 1; console.log("  FAIL", n, e); }
};

check("ctx.inject 注册 connection 回调", typeof capturedCb === "function");

// 模拟 DSH 启动完成 → connection 服务就绪
capturedCb({
  webServer: { port: 17998 },
  connection: { authenticatedUrl(base) { authCalls.push(base); return `${base}?token=REALTOKEN`; } },
});
await new Promise((r) => setTimeout(r, 100));
check("authenticatedUrl 用 DSHMOBILE_DSH_URL 调用", authCalls.length === 1 && authCalls[0] === "http://127.0.0.1:17998", JSON.stringify(authCalls));

// 第二次注入（连接重载场景）不崩溃
capturedCb({
  webServer: { port: 17998 },
  connection: { authenticatedUrl(base) { authCalls.push(base); return `${base}?token=REALTOKEN2`; } },
});
check("重复注入不崩溃", authCalls.length === 2);

// 无 env 覆盖时沿用注入回调学到的 webServer 端口（静态兜底 3080 由 grep 验证）
delete process.env.DSHMOBILE_DSH_URL;
capturedCb({
  connection: { authenticatedUrl(base) { authCalls.push(base); return `${base}?token=T3`; } },
});
check("端口记忆：无 env 时沿用上次端口", authCalls[2] === "http://127.0.0.1:17998", JSON.stringify(authCalls[2]));

dispose();
rmSync(stateDir, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
