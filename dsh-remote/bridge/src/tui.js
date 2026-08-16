// bridge 终端 UI：登录 / 运行状态 / 再见 三个界面 + 交互输入。
// 与真实 bridge 逻辑分离：渲染层只接收状态与事件，方便 mock 演示。
import readline from "node:readline";
import process from "node:process";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const W = 44; // 框宽

function pad(text, width = W - 4) {
  // 中文字符按 2 列计宽
  let visible = 0;
  for (const ch of text) visible += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  const need = Math.max(0, width - visible);
  return text + " ".repeat(need);
}

function box(lines) {
  const out = [];
  out.push(C.cyan + "╔" + "═".repeat(W - 2) + "╗" + C.reset);
  for (const line of lines) out.push(C.cyan + "║" + C.reset + " " + pad(line) + " " + C.cyan + "║" + C.reset);
  out.push(C.cyan + "╚" + "═".repeat(W - 2) + "╝" + C.reset);
  return out.join("\n");
}

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

/** 界面 1：登录。返回 {username, password} 或 null（退出）。 */
export async function loginScreen(defaults = { server: "https://www.deepseek-claudex.cn", username: "", error: "" }) {
  clear();
  const lines = [
    "",
    C.bold + "DSH Bridge" + C.reset + " · 登录",
    C.dim + "DeepSeek Harness 远程桥接" + C.reset,
    "",
    C.gray + `服务器  ${defaults.server}` + C.reset,
  ];
  process.stdout.write(box(lines) + "\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  if (defaults.error) {
    process.stdout.write(C.red + `  ✗ ${defaults.error}\n` + C.reset);
  }

  const username = (await ask(`  用户名  ${C.cyan}${defaults.username ? "[" + defaults.username + "] " : ""}${C.reset}> `)).trim() || defaults.username;
  if (username.toLowerCase() === "exit") { rl.close(); return null; }

  // 密码输入：raw 模式隐藏回显
  process.stdout.write("  密码    > ");
  const password = await hiddenInput(rl);

  rl.close();
  return { username, password };
}

function hiddenInput(rl) {
  // 非 TTY（管道/重定向）时无 raw mode，退化为明文输入
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return new Promise((resolve) => rl.question("", resolve));
  }
  return new Promise((resolve) => {
    const isRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let buf = "";
    const onData = (key) => {
      const s = key.toString();
      if (s === "\r" || s === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(buf);
        return;
      }
      if (s === "\u0003") { // Ctrl+C
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }
      if (s === "\u007f" || s === "\b") { // backspace
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      // 可见字符
      if (s >= " " && s !== "\u001b") {
        buf += s;
        process.stdout.write("*");
      }
    };
    function cleanup() {
      process.stdin.setRawMode(isRaw ?? false);
      process.stdin.off("data", onData);
      process.stdin.pause();
    }
    process.stdin.on("data", onData);
  });
}

/** 界面 2：运行状态。state 变化时重绘。返回 'exit' | 'logout' | 'relogin'。 */
export function runningScreen(state) {
  clear();
  const relay = state.relayOnline
    ? C.green + "● 已连接" + C.reset
    : state.relayConnecting ? C.yellow + "○ 连接中…" + C.reset : C.red + "○ 未连接" + C.reset;
  const dsh = state.dshOnline
    ? C.green + "● 已连接" + C.reset
    : state.dshConnecting ? C.yellow + "○ 连接中…" + C.reset : C.red + "○ 未连接" + C.reset;
  const lines = [
    "",
    C.bold + "DSH Bridge" + C.reset + " · 运行中",
    "",
    C.green + "✓ 登录成功" + C.reset,
    C.gray + `设备  ${state.deviceLabel}` + C.reset,
    C.gray + `账号  ${state.username}` + C.reset,
    "",
    `中继  ${relay}  ${C.gray}${state.relayUrl}${C.reset}`,
    `DSH   ${dsh}  ${C.gray}${state.dshUrl}${C.reset}`,
    "",
    state.lastEvent ? C.gray + state.lastEvent + C.reset : "",
    "",
    C.dim + "输入 exit 退出 · logout 重新登录" + C.reset,
  ];
  process.stdout.write(box(lines) + "\n");
  process.stdout.write("  > ");
}

/** 界面 3：再见。 */
export function goodbyeScreen(reason) {
  clear();
  const lines = [
    "",
    C.bold + "DSH Bridge" + C.reset + " · 已退出",
    "",
    C.gray + reason + C.reset,
    "",
    C.dim + "下次双击 dsh-bridge.exe 重新启动" + C.reset,
    "",
  ];
  process.stdout.write(box(lines) + "\n");
}

/** 运行界面交互：解析输入行。 */
export function parseRunningInput(line) {
  const s = line.trim().toLowerCase();
  if (s === "exit" || s === "quit" || s === "q") return { action: "exit" };
  if (s === "logout" || s === "relogin") return { action: "logout" };
  return { action: "ignore" };
}
