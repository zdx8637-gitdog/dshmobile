// 构建脚本：host 半边（ESM，@deepseek-ai/dsh-settings 保持 external，
// zod 打进 bundle）与 client 半边（CJS body + __ModuleLoader__ handoff 包装）。
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ID = "@liustack/dshmobile-bridge";

// ---- host ----
await build({
  entryPoints: [path.join(ROOT, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(ROOT, "lib/index.js"),
  external: ["@deepseek-ai/dsh-settings", "zod"],
  logLevel: "info",
});

// ---- client body ----
await build({
  entryPoints: [path.join(ROOT, "src/client.tsx")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  jsx: "automatic",
  target: "es2022",
  outfile: path.join(ROOT, "lib/client.body.js"),
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
  logLevel: "info",
});

// ---- handoff 包装（与官方 client bundle 同格式）----
const body = readFileSync(path.join(ROOT, "lib/client.body.js"), "utf8");
const handoff =
  `window.__ModuleLoader__.load({\n` +
  `  id: ${JSON.stringify(PACKAGE_ID)},\n` +
  `  factory: (require) => {\n` +
  `    var module = { exports: {} };\n` +
  `    var exports = module.exports;\n` +
  body +
  `\n    return module.exports;\n` +
  `  }\n` +
  `});\n`;
writeFileSync(path.join(ROOT, "lib/client.js"), handoff);
console.log("built lib/index.js + lib/client.js");
