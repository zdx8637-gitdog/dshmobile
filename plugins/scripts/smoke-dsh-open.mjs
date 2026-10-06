// smoke-dsh-open.mjs：仿"回环免鉴权"的 DSH（如 dsh-tauri：GET /?token= 恒 200 且不发 Set-Cookie，
// /api 与 /api/remote.mux 免 cookie 直连）。验证桥 1.0.7 的语义：
//   ① 免 cookie 探测直接成功（不铸）；② 换证失败（200 无 Set-Cookie）不抛错、标记 open、按免 cookie 继续；
//   ③ open 判定只打一次日志、token 交换只试一次（不再每秒/每 8s 轰炸根路径）；
//   ④ 官方 DSH 的 401→铸证 路径由 smoke-dsh-v2 继续守护（本文件不涉及）。
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../bridge/dsh.js";

const stateDir = mkdtempSync(join(tmpdir(), "dshmobile-open-"));
const PORT = 17_598;

const seen = { tokenExchanges: 0, upgradeCookie: null };

function acceptKey(key) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    // dsh-tauri 行为：任何 token 一律 200、无 Set-Cookie
    seen.tokenExchanges += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html>ok</html>");
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (body?.type !== "client-request") {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/remote.mux") { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  seen.upgradeCookie = req.headers.cookie ?? null;
  const key = req.headers["sec-websocket-key"];
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "", "",
  ].join("\r\n"));
  socket.on("data", (chunk) => {
    const b0 = chunk[0];
    const opcode = b0 & 0x0f;
    if (opcode === 0x8) { socket.end(); }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  PASS ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${extra}`); }
}

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
try {
  const base = `http://127.0.0.1:${PORT}`;
  const client = new DshClient(base, { stateDir, token: "any-token" });

  // ① 协议探测：免 cookie 直连成功（不铸证）
  const proto = await client.ensureProtocol();
  check("免 cookie 探测 → v2（探测阶段不铸证）", proto === "v2", proto);
  check("探测后 token 交换次数仍为 0", seen.tokenExchanges === 0, String(seen.tokenExchanges));

  // ② unary：换证失败（200 无 Set-Cookie）→ 不抛错、按免 cookie 继续
  let unaryThrew = null;
  let result = null;
  try { result = await client.unary("session/list", { _request: {} }); } catch (e) { unaryThrew = String(e?.message ?? e); }
  check("unary 不抛错（换证失败不致命）", unaryThrew === null, unaryThrew ?? "");
  check("unary 拿到 ok:true（免 cookie 直连）", result?.ok === true, JSON.stringify(result));
  check("token 交换只试过 1 次（open 判定后不再轰炸根路径）", seen.tokenExchanges === 1, String(seen.tokenExchanges));

  // ③ mux：免 cookie 升级成功；open 形态被记住，不再换证
  const mux = client.openMux(() => {});
  await mux.ready;
  check("mux 免 cookie 升级成功", mux.ws?.readyState === 1, String(mux.ws?.readyState));
  check("mux 升级未携带 cookie", seen.upgradeCookie === null || seen.upgradeCookie === undefined, String(seen.upgradeCookie));
  check("mux 之后 token 交换次数仍为 1", seen.tokenExchanges === 1, String(seen.tokenExchanges));

  // ④ 重开 mux（断线重连场景）：open 形态持久，仍不铸证
  const mux2 = client.openMux(() => {});
  await mux2.ready;
  check("重连 mux 仍免 cookie 成功", mux2.ws?.readyState === 1, String(mux2.ws?.readyState));
  check("重连后 token 交换次数仍为 1", seen.tokenExchanges === 1, String(seen.tokenExchanges));

  mux.close();
  mux2.close();
  await sleep(100);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
  server.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
