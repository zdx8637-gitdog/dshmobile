// 验证线上落地页：二维码究竟编码了什么内容（拦截 window.QRCode 构造调用）
// 运行：node D:\p\tools\pwt\verify-qr.mjs
import { chromium } from "playwright-core";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.argv[2] || "https://www.deepseek-claudex.cn/dshmobile/";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const consoleErrors = [];
const failed = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("requestfailed", (r) => failed.push(r.url() + " " + (r.failure() || {}).errorText));
page.on("response", (r) => {
  if (r.url().includes("latest.json")) console.log("latest.json →", r.status());
  if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
});

// 在页面脚本之前挂钩 QRCode，记录它收到的 text
await page.addInitScript(() => {
  window.__qrTexts = [];
  let real;
  Object.defineProperty(window, "QRCode", {
    configurable: true,
    get() { return real; },
    set(v) {
      const wrapper = function (el, opts) {
        try { window.__qrTexts.push(opts && opts.text); } catch (e) {}
        return new v(el, opts);
      };
      wrapper.CorrectLevel = v && v.CorrectLevel;
      real = wrapper;
    },
  });
});

await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(2500);           // 等 latest.json 生效 + 下载区二维码生成

const tabSel = '.tab[data-pane="phone"]';  // Hero 卡的「手机端下载」标签 → 触发第二个二维码
if (await page.$(tabSel)) { await page.click(tabSel); await page.waitForTimeout(1500); }

const out = await page.evaluate(() => ({
  versions: Array.from(document.querySelectorAll("[data-ver]")).map((e) => e.textContent),
  dlBtnHref: document.getElementById("dlBtn") && document.getElementById("dlBtn").getAttribute("href"),
  dataApkUrl: document.getElementById("dlBtn") && document.getElementById("dlBtn").getAttribute("data-apk-url"),
  qrTexts: window.__qrTexts,
  qrCanvases: Array.from(document.querySelectorAll("canvas")).filter((c) => c.width > 0).length,
}));

console.log("页面显示版本:", JSON.stringify(out.versions));
console.log("下载按钮 href:", out.dlBtnHref);
console.log("data-apk-url:", out.dataApkUrl);
console.log("二维码实际编码内容:", JSON.stringify(out.qrTexts, null, 2));
console.log("页面 canvas 数(含二维码):", out.qrCanvases);
if (consoleErrors.length) console.log("控制台错误:", consoleErrors.slice(0, 3));
if (failed.length) console.log("请求失败:", failed.slice(0, 3));

const bad = out.qrTexts.filter((t) => !/^https:\/\//.test(String(t)));
console.log(bad.length === 0 && out.qrTexts.length > 0 ? "\n✅ 所有二维码都是绝对 https URL" : `\n❌ 存在非绝对 URL 的二维码内容: ${JSON.stringify(bad)}`);
if (!out.qrTexts.length) console.log("（未捕获到二维码生成——检查编码触发条件）");
await browser.close();
