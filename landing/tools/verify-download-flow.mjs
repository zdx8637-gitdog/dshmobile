// 下载链路专测（本地/线上通用）：扫码落在哪、微信里怎么引导、手机端默认展开哪一栏、按钮能否真下到包。
// 用法：node verify-download-flow.mjs [baseUrl]
import { createRequire } from "node:module";
const require = createRequire("D:/p/tools/pwt/package.json");
const { chromium } = require("playwright-core");

const BASE = process.argv[2] || "http://127.0.0.1:8099/";
const fails = [];
const ok = (c, m) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails.push(m); };

const META = await (await fetch(new URL("latest.json", BASE), { cache: "no-store" })).json();
const APK_URL = new URL(META.file, BASE).href;
const PAGE_URL = new URL("#download", BASE).href;
console.log(`目标站点 ${BASE}\n期望：二维码=${PAGE_URL}\n      下载=${APK_URL}（${META.size} 字节）\n`);

const browser = await chromium.launch({ channel: "chrome" });

// ---------- 1) 扫码落地：带 #download 打开，必须直接停在下载区且标题不被吸顶导航遮挡 ----------
console.log("[1] 扫码落地 #download（系统相机/浏览器路径）");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36" });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE_URL, { waitUntil: "load" });
  await p.waitForTimeout(2200);
  const r = await p.evaluate(() => {
    const sec = document.getElementById("download");
    const head = sec.querySelector(".sec-head");
    const nav = document.querySelector("nav.nav");
    const hb = head.getBoundingClientRect(), nb = nav ? nav.getBoundingClientRect() : { bottom: 0 };
    const cs = getComputedStyle(head);
    return { top: Math.round(hb.top), navBottom: Math.round(nb.bottom), opacity: cs.opacity, visible: hb.height > 0,
             hash: location.hash, y: Math.round(window.scrollY),
             btnVisible: !!document.getElementById("dlBtn") && getComputedStyle(document.getElementById("dlBtn")).display !== "none",
             qrHidden: getComputedStyle(document.getElementById("qrDlBox")).display === "none",
             heroBtn: getComputedStyle(document.getElementById("dlBtnHero")).display,
             activeTab: (document.querySelector(".tab.active") || {}).dataset && document.querySelector(".tab.active").dataset.pane };
  });
  console.log("   ", JSON.stringify(r));
  ok(errs.length === 0, `无 JS 错误${errs.length ? "：" + errs[0] : ""}`);
  ok(r.y > 200, `已自动滚到下载区（scrollY=${r.y}）`);
  ok(r.top >= r.navBottom - 2, `下载区标题未被吸顶导航遮挡（标题 top=${r.top} ≥ 导航 bottom=${r.navBottom}）`);
  ok(Number(r.opacity) > 0.9, `下载区可见（reveal 动画 opacity=${r.opacity}）`);
  ok(r.btnVisible, "手机端「下载 APK」按钮可见");
  ok(r.qrHidden, "手机端隐藏二维码（扫自己屏幕没意义）");
  ok(r.heroBtn !== "none", "hero 卡在手机上显示下载按钮");
  ok(r.activeTab === "phone", `手机上默认展开「手机端下载」（当前 ${r.activeTab}）`);
  await p.screenshot({ path: "D:/p/pw-check/flow-mobile-anchor.png", fullPage: false });
  await ctx.close();
}

// ---------- 2) 微信：必须给引导、不给会撞拦截页的下载按钮，并能精确复制链接 ----------
console.log("\n[2] 微信内（MicroMessenger UA）");
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ["clipboard-read", "clipboard-write"],
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003129) NetType/WIFI Language/zh_CN",
  });
  const p = await ctx.newPage();
  const apkHits = [];
  p.on("request", (r) => { if (/\.apk(\?|$)/i.test(r.url())) apkHits.push(r.url()); });
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForTimeout(2200);
  const r = await p.evaluate(() => ({
    tipShown: getComputedStyle(document.getElementById("wechatTip")).display !== "none",
    tipText: document.getElementById("wechatTip").textContent.trim().slice(0, 60),
    dlHidden: getComputedStyle(document.getElementById("dlBtn")).display === "none",
    heroHidden: getComputedStyle(document.getElementById("dlBtnHero")).display === "none",
    dlHref: document.getElementById("dlBtn").getAttribute("href"),
    linkBoxShown: getComputedStyle(document.getElementById("linkBox")).display !== "none",
    linkText: document.getElementById("linkBox").textContent.trim(),
  }));
  console.log("   ", JSON.stringify(r));
  ok(r.tipShown, `显示微信引导：${r.tipText}…`);
  ok(r.dlHidden && r.heroHidden, "微信内隐藏所有 .apk 下载按钮（避免撞拦截页）");
  ok(r.dlHref === null, "隐藏按钮同时移除 href（防御性）");
  ok(r.linkBoxShown && r.linkText.startsWith("http"), `显示可整段选中的链接：${r.linkText}`);
  // 点复制按钮：剪贴板必须逐字符等于链接
  await p.click("#copyLinkBtn");
  await p.waitForTimeout(400);
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => "(读取失败)"));
  ok(clip === r.linkText, `剪贴板内容逐字符一致（${clip}）`);
  ok(apkHits.length === 0, `微信内未发起任何 .apk 请求${apkHits.length ? "：" + apkHits[0] : ""}`);
  await p.screenshot({ path: "D:/p/pw-check/flow-wechat.png", fullPage: false });
  await ctx.close();
}

// ---------- 3) 下载按钮真能下到包（HEAD 头信息 + 头部字节校验；完整 sha256 由服务器侧 sha256sum 保证） ----------
console.log("\n[3] 下载按钮 → APK 可达");
if (/127\.0\.0\.1|localhost/.test(BASE)) {
  console.log("    ⏭️  本地站点不含 APK 文件（仓库里不放 13MB 产物），本步只在线上执行");
} else {
  const head = await fetch(APK_URL, { method: "HEAD", signal: AbortSignal.timeout(30000) });
  const len = Number(head.headers.get("content-length"));
  ok(head.status === 200, `APK HEAD ${head.status}`);
  ok(len === META.size, `Content-Length 与 latest.json 一致（${len} == ${META.size}）`);
  // 只取前 64KB：验证是真实 APK/ZIP（magic "PK\x03\x04"）而不是错误页
  const rng = await fetch(APK_URL, { headers: { Range: "bytes=0-65535" }, signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await rng.arrayBuffer());
  ok(buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b, `前 ${buf.length} 字节是 APK/ZIP 魔数（PK）`);
}

await browser.close();
console.log(fails.length === 0 ? "\n✅ 下载链路全部通过" : `\n❌ ${fails.length} 项失败`);
process.exit(fails.length === 0 ? 0 : 1);
