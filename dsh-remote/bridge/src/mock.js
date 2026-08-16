// bridge mock 演示入口：不连接任何服务器，演示交互式登录 UI 的完整流转。
// 用法：node src/mock.js
// 流程：登录界面 → (输错密码回到登录界面+错误提示) → 运行状态 → exit → 再见界面
import readline from "node:readline";
import { loginScreen, runningScreen, goodbyeScreen, parseRunningInput } from "./tui.js";

const MOCK = {
  server: "https://www.deepseek-claudex.cn",
  password: "123456", // mock 密码，其余视为错误
  deviceLabel: "DSH Bridge (windows-p)",
  dshUrl: "http://127.0.0.1:3080",
};

function connectMock(state) {
  state.relayConnecting = true;
  state.dshConnecting = true;
  runningScreen(state);
  setTimeout(() => {
    state.relayConnecting = false;
    state.relayOnline = true;
    state.lastEvent = "已注册设备（mock）";
    runningScreen(state);
    setTimeout(() => {
      state.dshConnecting = false;
      state.dshOnline = true;
      state.lastEvent = "已连接本地 DSH（mock）";
      runningScreen(state);
    }, 600);
  }, 600);
}

async function main() {
  let username = "";

  while (true) {
    // ---------- 登录界面（输错密码后带错误提示重入） ----------
    let error = "";
    let cred = null;
    while (cred === null) {
      const attempt = await loginScreen({ server: MOCK.server, username, error });
      if (attempt === null) {
        goodbyeScreen("未登录退出");
        process.exit(0);
      }
      if (attempt.password !== MOCK.password) {
        error = "密码错误，请重试";
        username = attempt.username;
        continue;
      }
      cred = attempt;
    }

    // ---------- 运行状态界面 ----------
    const state = {
      username: cred.username,
      deviceLabel: MOCK.deviceLabel,
      relayUrl: MOCK.server,
      dshUrl: MOCK.dshUrl,
      relayOnline: false,
      relayConnecting: true,
      dshOnline: false,
      dshConnecting: true,
      lastEvent: "",
    };
    connectMock(state);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const action = await new Promise((resolve) => {
      rl.on("line", (line) => {
        const parsed = parseRunningInput(line);
        if (parsed.action === "exit") resolve("exit");
        if (parsed.action === "logout") resolve("logout");
        else runningScreen(state);
      });
    });
    rl.close();

    if (action === "exit") {
      goodbyeScreen("已断开连接，设备已下线（mock）");
      process.exit(0);
    }
    // logout → 清空账号回登录界面
    username = "";
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
