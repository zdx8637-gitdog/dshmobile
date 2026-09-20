// 验证单页配对：扫任何码都落在同一页面
//   1) ?mode=pair&code=...  → 配对卡显示配对码 + dshmobile://pair 深链，且不再跳 pair.html
//   2) ?mode=e2ee&...       → 加密配对卡 + dshmobile://e2ee 深链
//   3) 无参数               → 不显示配对卡（普通落地页）
//   4) 微信 UA              → 隐藏「打开 App」并显示微信兜底提示
// 运行：node D:\p\tools\pwt\verify-pair-inline.mjs
import { chromium } from "playwright-core";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "https://www.deepseek-claudex.cn/dshmobile/";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let fail = 0;
const check = (n, ok, extra = "") => { console.log((ok ? "  PASS " : "  FAIL ") + n + (ok ? "" : "  " + extra)); if (!ok) fail++; };

async function probe(url, { waitLong = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const navs = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(waitLong ? 1200 : 250);
  const out = await page.evaluate(() => {
    const card = document.getElementById("pairCard");
    const open = document.getElementById("pairOpen");
    const warn = document.getElementById("pairWarn");
    return {
      url: location.href,
      cardShown: !!card && getComputedStyle(card).display !== "none",
      title: document.getElementById("pairTitle") && document.getElementById("pairTitle").textContent,
      code: document.getElementById("pairCode") && document.getElementById("pairCode").textContent,
      deepLink: open && open.getAttribute("data-deep-link"),
      openVisible: !!open && getComputedStyle(open).display !== "none",
      warnShown: !!warn && getComputedStyle(warn).display !== "none",
      verd: Array.from(document.querySelectorAll("[data-ver]")).map((e) => e.textContent)[0],
    };
  });
  await page.close();
  return { ...out, navs };
}

console.log("[1] 配对码扫码（mode=pair）");
const a = await probe(BASE + "?mode=pair&code=123456");
check("不再跳 pair.html", !a.navs.some((u) => u.includes("pair.html")), JSON.stringify(a.navs));
check("配对卡显示且配对码正确", a.cardShown && a.title === "扫码登录" && a.code === "123456", JSON.stringify(a));
check("深链为 dshmobile://pair 且带 relay/code", (a.deepLink || "").startsWith("dshmobile://pair?relay=") && a.deepLink.includes("code=123456"), a.deepLink);
check("版本号仍是最新（latest.json 生效）", a.verd === "v0.2.16", a.verd);

console.log("[2] 加密配对扫码（mode=e2ee）");
const b = await probe(BASE + "?mode=e2ee&deviceId=dev-1&pk=PK&ps=PS&pid=PID&cv=1");
check("加密配对卡 + 深链", b.cardShown && b.title === "端到端加密配对" && (b.deepLink || "").startsWith("dshmobile://e2ee?") && b.deepLink.includes("deviceId=dev-1"), JSON.stringify(b));

console.log("[3] 授权扫码（mode=grant）");
const c = await probe(BASE + "?mode=grant&code=654321&pid=GID");
check("授权卡 + dshmobile://grant 深链", c.cardShown && c.title === "授权电脑登录" && (c.deepLink || "").includes("dshmobile://grant?") && c.deepLink.includes("pid=GID"), JSON.stringify(c));

console.log("[4] 普通访问（无参数）");
const d = await probe(BASE);
check("不显示配对卡", !d.cardShown, JSON.stringify(d));

console.log("[5] 微信 UA 兜底");
const e = await probe(BASE + "?mode=pair&code=111111&ua=wechat");
check("隐藏打开 App + 显示微信提示", !e.openVisible && e.warnShown, JSON.stringify(e));

console.log("[6] 等待自动拉起后仍在同页（App 未安装时不应跳走）");
const f = await probe(BASE + "?mode=pair&code=222222", { waitLong: true });
check("未跳转到 pair.html", !f.navs.some((u) => u.includes("pair.html")), JSON.stringify(f.navs));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
