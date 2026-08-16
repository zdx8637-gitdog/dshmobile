// 非交互验证：模拟按键序列，捕获界面输出（管道输入隐藏回显密码时用 mock 密码）
import { spawn } from "node:child_process";

const seq = [
  { wait: 1200, input: "demo\n" },        // 用户名
  { wait: 500, input: "wrongpass\n" },    // 错密码
  { wait: 1200, input: "demo\n" },        // 重输用户名
  { wait: 500, input: "123456\n" },       // 正确密码
  { wait: 2500, input: "exit\n" },        // 运行界面退出
  { wait: 800, input: "" },
];

const child = spawn("node", ["src/mock.js"], { cwd: "D:\\p\\dsh-remote\\bridge", stdio: ["pipe", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); process.stdout.write(d.toString()); });
child.stderr.on("data", (d) => process.stderr.write("[err] " + d.toString()));

for (const step of seq) {
  await new Promise((r) => setTimeout(r, step.wait));
  if (step.input) child.stdin.write(step.input);
}
await new Promise((r) => setTimeout(r, 500));
child.kill();
console.log("\n=== mock flow completed ===");
