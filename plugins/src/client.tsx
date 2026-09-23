// @zdx8637/dshmobile-bridge 的 client 半壳
// 更名记录：@liustack/dshmobile-bridge → @zdx8637/dshmobile-bridge（改用自有 scope 以便发布 npm 社区）
// 左侧栏弹窗卡片：桥状态、连接配置（可编辑保存）、扫码配对（二维码 + 6 位码 + 倒计时 + 刷新）。
// 数据面：不再走 settings 命名空间（rc.6 不暴露第三方命名空间），改为
// 轮询宿主 127.0.0.1:17653 的 GET /state + POST /action —— 免补丁、跨平台、跨 DSH 版本。
// UI v3（2026-09-20）：入口按钮换成 App 图标 + 状态点；面板改为「状态 / 登录 / 二维码」三块结构；
// 二维码自绘加固（整数模块 + 内建 4 模块静区 + 两码同尺寸 + DPR 感知）。
import * as React from "react";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
// qrcode-generator 会被构建进本 bundle（非 external）；CJS 库用默认导入 + 兜底
import qrcodeDefault from "qrcode-generator";
const qrcode: any = (qrcodeDefault as any)?.default ?? qrcodeDefault;

const PANEL_HTTP = "http://127.0.0.1:17653";

export const inject = ["slots"];

interface CardSnapshot {
  status: string;
  value: {
    enabled?: boolean;
    relayUrl?: string;
    username?: string;
    password?: string;
    deviceLabel?: string;
    bridgeStatus?: string;
    mode?: string;
    pairingCode?: string;
    pairingExpiresAt?: string;
    grantPairingId?: string;
    pairError?: string;
    registerError?: string;
    e2eePubKey?: string;
    e2eePairingSecret?: string;
    e2eeCryptoVersion?: number;
    e2eePairingId?: string;
    e2eePairingExpiresAt?: string;
    e2eeDeviceId?: string;
    // E2EE 运行时状态（宿主每次 /state 现读策略文件与 device-key.json）
    e2eeRequire?: boolean;
    e2eePinned?: boolean;
    e2eePeerKeyId?: string;
    bridgeVersion?: string;
  } | null;
  actions: Record<string, (...args: any[]) => Promise<any>>;
}

/* ============================ 设计令牌 ============================
   教训（2026-09-23 用户反馈「按钮和底色一样、字还溢出边框」）：
   不能拿 DSH 的 label/border 半透明令牌当**按钮文字/边框**用 —— 从用户本机正在运行的 DSH
   （@deepseek-ai/dsh-client-ui-theme，抽取脚本 pw-check/panel-harness/sync-dsh-tokens.mjs）实测：
     --dsw-alias-label-dimmed  浅色 #e1e5ee（白底 1.26:1 ≈ 隐形）／暗色 #43454a（#232324 上 1.45:1）
     --dsw-alias-border-l3     浅色 #0000001f（白底几乎看不到边）
   于是"极淡文字 + 透明底 + 极淡边"的 ghost 按钮在两种主题下都糊进底色。
   现在改为自有调色板 `--dsm-*`（CSS 顶部按 body / body[data-ds-dark-theme] 给出两套值，
   都按压在背景上的可读性选定；只有品牌蓝沿用 DSH 的 deepseek-450，两主题同值）。
   主题仍然只认 body[data-ds-dark-theme]（DSH 的机制），不自己判断 prefers-color-scheme。 */
const T = {
  bg1: "var(--dsm-bg1)",
  bg2: "var(--dsm-bg2)",
  bg3: "var(--dsm-bg3)",
  bgBase: "var(--dsm-bg-base)",
  elev: "var(--dsm-elev)",
  line1: "var(--dsm-line1)",
  line2: "var(--dsm-line2)",
  line3: "var(--dsm-line3)",
  text: "var(--dsm-text)",
  dim: "var(--dsm-text2)",
  caption: "var(--dsm-caption)",
  muted: "var(--dsm-muted)",
  brand: "var(--dsm-brand)",
  brandFill: "var(--dsm-brand-fill)",
  brandFillHover: "var(--dsm-brand-fill-hover)",
  brandSoft: "var(--dsm-brand-soft)",
  brandWash: "var(--dsm-brand-wash)",
  hover: "var(--dsm-hover)",
  active: "var(--dsm-active)",
  soft: "var(--dsm-soft)",
  softHover: "var(--dsm-soft-hover)",
  ok: "var(--dsm-ok)",
  okBg: "var(--dsm-ok-bg)",
  okLine: "var(--dsm-ok-line)",
  okHover: "var(--dsm-ok-hover)",
  warn: "var(--dsm-warn)",
  warnBg: "var(--dsm-warn-bg)",
  warnLine: "var(--dsm-warn-line)",
  warnHover: "var(--dsm-warn-hover)",
  off: "var(--dsm-off)",
  danger: "var(--dsm-danger)",
  dangerText: "var(--dsm-danger-text)",
  dangerWash: "var(--dsm-danger-bg)",
  dangerHover: "var(--dsm-danger-hover)",
  dangerLine: "var(--dsm-danger-line)",
  panelW: 360,
  pad: 16,
  labelW: 52,
  rowGap: 10,
  inputH: 32,
  btnH: 32,
  rLg: 12,
  rMd: 10,
  rSm: 8,
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/* ============================ 二维码 ============================
   规范要求：静区 ≥ 4 模块；模块必须是整数像素（否则暗色底下发灰发糊）。
   实现要点：cell 取两张码中**最大模块数**来算 → 两张卡瓦片同尺寸；canvas 像素尺寸 = cell×(n+8)×DPR，
   CSS 尺寸 = cell×(n+8) → 任意 DPR 下都是整数模块、不变形、静区恒为 4 模块。 */
const QR_QUIET = 4; // 静区模块数（规范 4）
const QR_TARGET = 138; // 目标瓦片边长，与设计稿一致
const QR_CELL_MIN = 3;
const QR_CELL_MAX = 6;

interface QrPlan {
  qrs: (any | null)[];
  cell: number;
  side: number;
}

function buildQr(text: string): any | null {
  if (!text) return null;
  try {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q;
  } catch {
    return null;
  }
}

function qrPlan(texts: string[]): QrPlan | null {
  const qrs = texts.map(buildQr);
  const maxN = qrs.reduce((m, q) => Math.max(m, q ? q.getModuleCount() : 0), 0);
  if (!maxN) return null;
  const cell = Math.min(QR_CELL_MAX, Math.max(QR_CELL_MIN, Math.floor(QR_TARGET / (maxN + QR_QUIET * 2))));
  return { qrs, cell, side: cell * (maxN + QR_QUIET * 2) };
}

/** 把一张码画进 canvas：纯白底 + 纯黑模块 + 内建静区；空数据只清成白色（不再涂深色块）。 */
function paintQr(canvas: HTMLCanvasElement | null, qr: any | null, plan: QrPlan | null) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const side = plan ? plan.side : QR_TARGET;
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const px = Math.max(1, Math.round(side * dpr));
  const cell = Math.max(1, Math.round((plan ? plan.cell : QR_CELL_MIN) * dpr));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  canvas.style.width = side + "px";
  canvas.style.height = side + "px";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  if (!qr) return;
  const n = qr.getModuleCount();
  const off = Math.floor((px - n * cell) / 2);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
    }
  }
}

/* ============================ 样式（hover/focus 只能靠 CSS） ============================ */
const STYLE_ID = "dshmobile-panel-style";
// 调色板：浅色默认 = body{}，暗色 = body[data-ds-dark-theme]{}（与 DSH 的切换机制一致）。
// 只往 body 上挂 --dsm-* 命名空间，不碰 DSH 自己的 --dsw-*。
const CSS = `
body {
  --dsm-bg1:#ffffff; --dsm-bg2:#f5f6f8; --dsm-bg3:#eceef2; --dsm-bg-base:#ffffff;
  --dsm-elev:#e6e9ee;
  --dsm-line1:#e3e6ec; --dsm-line2:#d3d8e0; --dsm-line3:#c3cad4;
  --dsm-text:#14161a; --dsm-text2:#3d434b; --dsm-caption:#666d76; --dsm-muted:#8a9199;
  --dsm-brand:#2f6ae8; --dsm-brand-fill:#2f6ae8; --dsm-brand-fill-hover:#2759cd;
  --dsm-brand-soft:#b7c8fe; --dsm-brand-wash:rgba(86,134,254,.14);
  --dsm-hover:rgba(20,22,26,.06); --dsm-active:rgba(20,22,26,.10);
  --dsm-soft:#eef0f4; --dsm-soft-hover:#e2e6ec;
  --dsm-ok:#0f7a48; --dsm-ok-bg:#e4f7ec; --dsm-ok-line:#9ed9bb; --dsm-ok-hover:#d5f1e1;
  --dsm-warn:#8a5a00; --dsm-warn-bg:#fdf0d2; --dsm-warn-line:#e8c56b; --dsm-warn-hover:#fbe7bb;
  --dsm-off:#8a9199;
  --dsm-danger:#d92d20; --dsm-danger-text:#b3261e; --dsm-danger-bg:#fdecea;
  --dsm-danger-hover:#fbdad6; --dsm-danger-line:#f0b3ae;
}
body[data-ds-dark-theme] {
  --dsm-bg1:#232324; --dsm-bg2:#2c2c2e; --dsm-bg3:#353638; --dsm-bg-base:#17171a;
  --dsm-elev:#3a3d42;
  --dsm-line1:#3a3d42; --dsm-line2:#474b51; --dsm-line3:#5c6169;
  --dsm-text:#f4f6f8; --dsm-text2:#c9ced6; --dsm-caption:#9aa1aa; --dsm-muted:#767d86;
  --dsm-brand:#5686fe; --dsm-brand-fill:#3a6ce0; --dsm-brand-fill-hover:#4a7ceb;
  --dsm-brand-soft:#b7c8fe; --dsm-brand-wash:rgba(86,134,254,.18);
  --dsm-hover:rgba(255,255,255,.08); --dsm-active:rgba(255,255,255,.14);
  --dsm-soft:#35383d; --dsm-soft-hover:#41454b;
  --dsm-ok:#5fd99e; --dsm-ok-bg:#24382e; --dsm-ok-line:#3f6b55; --dsm-ok-hover:#2b4538;
  --dsm-warn:#f5c453; --dsm-warn-bg:#3d3318; --dsm-warn-line:#6f5c26; --dsm-warn-hover:#4b3f1d;
  --dsm-off:#767d86;
  --dsm-danger:#f2555a; --dsm-danger-text:#ff9d9d; --dsm-danger-bg:#3a2426;
  --dsm-danger-hover:#482b2d; --dsm-danger-line:#6d4143;
}
.dsm-entry { display:flex; align-items:center; gap:9px; height:36px; padding:0 10px; width:calc(100% - 24px);
  margin:0 12px; border:1px solid transparent; border-radius:10px; background:transparent; color:${T.text};
  font-size:13.5px; font-weight:500; cursor:pointer; text-align:left; transition:background .16s, border-color .16s; }
.dsm-entry:hover { background:${T.hover}; }
.dsm-entry:active { background:${T.active}; }
.dsm-entry:focus-visible { outline:none; border-color:${T.brand}; box-shadow:0 0 0 3px ${T.brandWash}; }
.dsm-entry[data-open="true"] { background:${T.bg2}; border-color:${T.line2}; }
.dsm-entry__label { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsm-entry__status { display:flex; align-items:center; gap:5px; font-size:11.5px; font-weight:400; color:${T.caption}; flex:none; }
.dsm-entry__chev { flex:none; transition:transform .2s cubic-bezier(.4,0,.2,1); }
.dsm-entry[data-open="true"] .dsm-entry__chev { transform:rotate(180deg); }
.dsm-entry--rail { width:36px; height:36px; padding:0; margin:0; justify-content:center; position:relative; }
.dsm-entry__badge { position:absolute; right:4px; bottom:4px; width:8px; height:8px; border-radius:50%;
  box-shadow:0 0 0 1.5px ${T.bgBase}; }
/* 弹窗遮罩：点空白处关闭。铺满视口（若被祖先的 transform 建了包含块，运行时自检后退回锚定模式）。 */
.dsm-overlay { position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.45);
  display:flex; align-items:center; justify-content:center; padding:24px; }
.dsm-overlay--anchored { background:transparent; padding:0; display:block; }
.dsm-panel { position:relative; box-sizing:border-box; width:${T.panelW}px; max-width:100%; max-height:100%;
  overflow-y:auto; overscroll-behavior:contain; outline:none; padding:0 ${T.pad}px;
  background:${T.bg1}; border:1px solid ${T.line2}; border-radius:${T.rLg}px; color:${T.text};
  box-shadow:0 24px 64px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.35); }
.dsm-panel--anchored { position:fixed; max-width:none; }
.dsm-sec { padding:16px 0; }
.dsm-sec + .dsm-sec { border-top:1px solid ${T.line1}; }
.dsm-h { display:flex; align-items:center; justify-content:space-between; font-size:12.5px; font-weight:600;
  color:${T.dim}; margin-bottom:12px; }
.dsm-h__meta { font-size:11px; font-weight:400; color:${T.caption}; font-family:${T.mono}; }
.dsm-row { display:grid; grid-template-columns:${T.labelW}px 1fr; gap:${T.rowGap}px; align-items:center; }
.dsm-row + .dsm-row { margin-top:${T.rowGap}px; }
.dsm-k { font-size:11px; color:${T.caption}; }
.dsm-v { font-size:12.5px; color:${T.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsm-v--mono { font-family:${T.mono}; font-size:12px; }
.dsm-input { width:100%; box-sizing:border-box; height:${T.inputH}px; padding:0 10px; background:${T.bgBase};
  border:1px solid ${T.line2}; border-radius:${T.rSm}px; color:${T.text}; font-size:13px; outline:none;
  transition:border-color .16s, box-shadow .16s; }
.dsm-input::placeholder { color:${T.muted}; }
.dsm-input:focus { border-color:${T.brand}; box-shadow:0 0 0 3px ${T.brandWash}; }
.dsm-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; box-sizing:border-box;
  min-height:${T.btnH}px; padding:0 14px; border-radius:${T.rSm}px; font-size:13px; font-weight:600;
  line-height:1.2; white-space:nowrap; flex:none; cursor:pointer;
  border:1px solid ${T.line3}; background:${T.soft}; color:${T.text};
  transition:background .16s, border-color .16s, color .16s; }
.dsm-btn:hover { background:${T.softHover}; }
.dsm-btn--brand { background:${T.brandFill}; border-color:${T.brandFill}; color:#fff; }
.dsm-btn--brand:hover { background:${T.brandFillHover}; border-color:${T.brandFillHover}; }
/* ghost = 中性实心按钮（保留历史类名，避免调用点漏改） */
.dsm-btn--ghost { background:${T.soft}; border-color:${T.line3}; color:${T.text}; }
.dsm-btn--ghost:hover { background:${T.softHover}; color:${T.text}; }
/* 状态色按钮：允许明文（琥珀）/ 要求加密（绿），一眼看出当前政策 */
.dsm-btn--warn { background:${T.warnBg}; border-color:${T.warnLine}; color:${T.warn}; }
.dsm-btn--warn:hover { background:${T.warnHover}; }
.dsm-btn--ok { background:${T.okBg}; border-color:${T.okLine}; color:${T.ok}; }
.dsm-btn--ok:hover { background:${T.okHover}; }
.dsm-btn--danger { background:${T.dangerWash}; border-color:${T.dangerLine}; color:${T.dangerText}; }
.dsm-btn--danger:hover { background:${T.dangerHover}; }
/* 小号：二维码卡片里的行内按钮。用 min-height 而不是固定 height ——
   固定高度 + 文字换行 = 文字溢出边框（用户反馈的「允许明文」就是这样） */
.dsm-btn--xs { min-height:24px; padding:0 10px; font-size:11.5px; border-radius:6px; font-weight:500; }
.dsm-btn:disabled { opacity:.5; cursor:not-allowed; }
.dsm-qr-card { background:${T.bg2}; border:1px solid ${T.line1}; border-radius:${T.rMd}px; padding:12px; }
.dsm-qr-card + .dsm-qr-card { margin-top:10px; }
.dsm-tile { display:inline-block; background:#fff; border-radius:${T.rSm}px; padding:0; line-height:0;
  box-shadow:0 0 0 1px rgba(255,255,255,.10); }
.dsm-tile canvas { display:block; border-radius:2px; }
.dsm-code { font-family:${T.mono}; font-size:17px; font-weight:600; letter-spacing:.12em; color:${T.text}; }
.dsm-pill { font-family:${T.mono}; font-size:11.5px; color:${T.caption}; background:${T.bgBase};
  border-radius:999px; padding:2px 8px; }
.dsm-err { display:flex; gap:8px; font-size:12px; line-height:18px; color:${T.dangerText};
  background:${T.dangerWash}; border:1px solid ${T.dangerLine}; border-radius:${T.rSm}px; padding:8px 10px; margin-bottom:12px; }
.dsm-note { font-size:12px; line-height:18px; color:${T.caption}; }
.dsm-foot { display:flex; align-items:center; gap:10px; padding:12px 0 14px; }
/* ---------- 横版（宽窗口）：细状态栏 + 三栏 ---------- */
.dsm-bar { display:flex; align-items:center; gap:10px; height:44px; margin:0 -16px; padding:0 16px;
  border-bottom:1px solid ${T.line1}; }
.dsm-bar__title { font-size:13.5px; font-weight:600; color:${T.text}; flex:none; }
.dsm-bar__state { display:flex; align-items:center; gap:6px; font-size:12px; color:${T.dim}; flex:none; }
.dsm-bar__sep { width:1px; height:14px; background:${T.line2}; flex:none; }
.dsm-bar__item { font-size:12px; color:${T.caption}; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; max-width:240px; }
.dsm-bar__item--mono { font-family:${T.mono}; }
.dsm-bar__ver { margin-left:auto; font-family:${T.mono}; font-size:11px; color:${T.caption}; flex:none; }
.dsm-bar__link { flex:none; font-size:12px; color:${T.caption}; padding:0 6px; border-radius:6px; }
.dsm-bar__link:hover { color:${T.text}; background:${T.hover}; }
.dsm-bar__close { flex:none; width:26px; height:26px; border-radius:8px; border:1px solid transparent;
  background:transparent; color:${T.caption}; cursor:pointer; font-size:13px; line-height:1; }
.dsm-bar__close:hover { background:${T.hover}; color:${T.text}; }
/* 三栏：等宽（320 + 1fr + 1fr）等高，卡片同构，底部动作对齐 */
.dsm-cols { display:grid; grid-template-columns:320px 1fr 1fr; gap:16px; padding:16px 0 2px; align-items:stretch; }
.dsm-col { min-width:0; display:flex; flex-direction:column; }
.dsm-col > .dsm-h { margin-bottom:10px; }
.dsm-colcard { flex:1 1 auto; display:flex; flex-direction:column; }
.dsm-actions { margin-top:auto; }              /* 各栏底部动作落在同一基线 */
.dsm-tilewrap { display:flex; justify-content:center; }  /* 二维码在卡内居中 */
.dsm-rowgap { height:10px; flex:none; }
.dsm-panel--wide { width:920px; }
`;
function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ============================ 图标 ============================ */
// 鲸鱼图标 path（= App 图标同款；由注入脚本写入，见仓库 README 说明）
const WHALE_PATH = "M31.659 6.777L31.898 6.840L32.068 7.018L32.686 8.373L32.962 8.772L33.214 9.023L33.732 9.385L35.766 10.440L36.204 10.748L36.660 11.164L37.128 11.882L37.440 12.794L38.477 11.907L39.447 11.404L40.470 11.117L42.384 10.867L42.943 10.667L43.541 10.266L44.557 9.211L44.856 9.039L45.096 9.039L45.255 9.117L45.496 9.490L45.585 10.088L45.544 11.005L45.343 12.121L44.922 13.317L44.314 14.394L43.504 15.351L42.783 15.963L41.746 16.593L40.431 17.163L38.716 17.691L38.506 17.863L38.451 18.062L38.470 19.298L38.284 20.654L37.923 22.010L37.400 23.393L36.284 23.158L35.486 23.233L35.048 23.387L34.569 23.674L34.038 24.242L30.672 31.459L28.549 35.865L27.831 35.415L26.914 34.702L25.997 33.858L25.349 33.174L23.993 31.459L21.075 27.113L19.678 25.279L18.630 24.123L17.863 23.393L16.786 22.512L15.869 21.872L14.633 21.163L13.317 20.560L11.523 19.974L10.008 19.652L8.174 19.500L6.499 19.608L5.861 19.736L5.268 19.936L5.040 20.136L4.922 20.375L4.872 21.292L4.970 22.608L5.208 24.043L5.488 25.199L5.966 26.675L6.523 28.030L7.244 29.426L7.967 30.582L8.886 31.818L9.766 32.815L10.766 33.783L11.643 34.505L12.799 35.302L13.796 35.857L14.952 36.339L15.869 36.574L16.746 36.631L17.384 36.534L17.863 36.298L18.163 35.925L18.226 35.566L18.159 35.207L17.375 33.772L17.212 33.293L17.157 32.855L17.210 32.416L17.424 32.023L17.783 31.805L18.102 31.778L18.541 31.846L19.219 32.084L20.574 32.766L22.249 33.762L25.040 35.540L26.316 36.257L27.632 36.819L28.509 37.057L28.971 37.121L29.247 36.324L34.609 24.883L34.758 24.641L35.088 24.308L35.407 24.109L35.925 23.953L36.603 23.986L41.826 25.665L42.145 25.827L42.559 26.236L42.843 26.874L42.872 27.352L42.798 27.751L40.623 32.496L40.989 32.636L41.188 32.774L41.521 33.293L41.656 34.011L41.597 34.809L41.400 35.447L41.081 36.085L40.723 36.603L40.271 37.092L39.793 37.457L39.195 37.766L38.636 37.924L37.919 37.997L37.121 39.663L36.722 40.076L36.204 40.358L35.845 40.444L35.327 40.439L31.818 39.417L30.981 40.040L29.984 40.677L29.027 41.194L28.030 41.637L27.033 41.999L25.598 42.399L24.163 42.674L23.166 42.795L20.813 42.879L18.740 42.713L16.627 42.318L14.394 41.638L12.440 40.798L10.486 39.683L8.692 38.369L6.962 36.762L6.061 35.760L5.368 34.888L4.202 33.134L3.262 31.300L2.541 29.346L2.225 28.150L2.030 27.153L1.827 25.080L1.823 23.884L1.909 22.687L2.225 20.734L2.623 19.258L3.187 17.743L3.904 16.268L4.581 15.152L5.574 13.836L6.539 12.796L7.735 11.756L8.892 10.963L10.008 10.359L10.845 10.001L11.922 9.638L12.919 9.400L14.354 9.204L15.750 9.162L17.225 9.278L18.780 9.570L20.574 8.806L21.970 8.321L23.126 8.039L24.203 7.912L25.040 7.924L25.558 8.003L26.037 8.170L26.253 8.413L26.246 8.533L26.156 8.660L25.478 9.081L25.108 9.410L24.863 9.729L24.671 10.128L24.592 10.566L24.631 11.005L24.787 11.443L25.070 11.882L25.558 12.344L27.113 13.504L28.509 14.738L29.466 15.696L31.459 17.899L32.097 18.531L32.775 19.071L33.333 19.430L33.892 19.711L34.051 19.720L34.230 19.498L34.537 18.740L34.866 17.584L34.863 17.225L34.769 17.094L32.974 15.878L32.297 15.290L31.725 14.673L31.287 14.035L31.003 13.477L30.718 12.719L30.527 11.962L30.407 11.005L30.394 10.167L30.564 8.772L30.799 7.935L31.092 7.257L31.380 6.878L31.644 6.778ZM42.783 19.969L43.222 19.965L43.780 20.051L44.498 20.251L45.056 20.482L45.654 20.809L46.212 21.201L47.056 22.010L47.419 22.488L47.816 23.166L48.098 23.844L48.286 24.482L48.410 25.279L48.414 25.797L48.296 26.077L48.006 26.248L47.648 26.216L47.386 25.957L47.173 24.721L46.970 24.092L46.614 23.365L46.095 22.648L45.455 22.039L44.657 21.523L43.979 21.238L42.743 20.981L42.584 20.894L42.413 20.654L42.409 20.335L42.544 20.110L42.761 19.976ZM26.515 20.288L26.954 20.277L27.472 20.362L28.349 20.727L28.907 21.122L29.346 21.526L30.154 22.488L30.554 23.126L30.905 23.844L31.112 24.442L31.263 25.239L31.232 25.638L31.100 25.867L30.861 26.045L30.463 26.171L29.785 26.171L29.226 26.001L28.668 25.646L28.263 25.199L28.061 24.801L27.945 24.322L28.014 23.206L27.971 22.807L27.839 22.488L27.592 22.165L27.313 21.952L26.954 21.795L25.877 21.664L25.678 21.557L25.506 21.372L25.464 21.013L25.638 20.705L25.997 20.442L26.479 20.295ZM42.424 21.959L42.743 21.952L43.182 22.031L44.019 22.319L44.737 22.754L45.422 23.405L45.698 23.764L45.984 24.282L46.295 25.199L46.391 26.077L46.294 26.316L46.132 26.446L45.933 26.490L45.774 26.457L45.552 26.276L45.380 25.399L45.191 24.841L44.829 24.203L44.454 23.764L44.059 23.433L43.501 23.110L42.943 22.914L42.384 22.819L42.185 22.678L42.093 22.488L42.096 22.289L42.185 22.112L42.401 21.970ZM26.236 22.636L26.595 22.665L26.794 22.805L26.895 22.967L26.925 23.365L26.794 23.603L26.635 23.727L26.396 23.788L26.116 23.734L25.948 23.604L25.824 23.405L25.790 23.166L25.864 22.927L25.997 22.759L26.209 22.648ZM42.225 23.761L42.663 23.785L43.222 24.000L43.740 24.349L44.059 24.690L44.399 25.279L44.552 25.797L44.561 26.196L44.418 26.410L44.179 26.488L43.939 26.411L43.784 26.196L43.600 25.518L43.301 25.088L42.823 24.714L42.186 24.522L42.026 24.395L41.942 24.163L41.968 24.003L42.080 23.844L42.220 23.764ZM35.925 24.958L36.404 24.946L41.348 26.546L41.642 26.794L41.760 27.033L41.791 27.273L41.678 27.671L39.220 33.014L39.197 33.134L39.593 33.158L39.640 33.174L39.609 33.214L39.155 33.421L38.716 33.544L37.281 33.722L36.284 33.961L35.526 34.369L35.242 34.649L35.073 34.928L34.959 35.287L34.956 35.646L35.043 36.005L35.202 36.324L35.553 36.762L35.925 37.097L36.898 37.679L36.340 38.955L36.030 39.234L35.726 39.324L35.367 39.279L30.423 37.811L30.091 37.560L29.972 37.161L30.048 36.842L30.764 35.287L35.395 25.399L35.621 25.120L35.921 24.960ZM36.404 25.627L36.643 25.632L36.922 25.751L37.101 25.957L37.172 26.156L37.179 26.396L37.083 26.675L36.922 26.852L36.683 26.965L36.364 26.976L36.164 26.896L35.959 26.715L35.844 26.435L35.844 26.196L35.952 25.917L36.124 25.745L36.366 25.638ZM38.078 26.188L38.261 26.236L38.364 26.396L38.318 26.595L38.198 26.687L37.998 26.685L37.851 26.515L37.885 26.316L38.047 26.196ZM37.520 26.983L37.839 26.980L38.038 27.061L38.265 27.273L38.359 27.472L38.373 27.751L38.292 27.990L38.118 28.194L37.879 28.317L37.600 28.340L37.400 28.276L37.183 28.110L37.041 27.871L37.007 27.592L37.073 27.352L37.264 27.113L37.487 26.994ZM35.766 27.263L36.005 27.274L36.244 27.378L36.421 27.552L36.528 27.791L36.536 28.070L36.448 28.309L36.284 28.490L36.045 28.613L35.766 28.634L35.526 28.556L35.326 28.389L35.203 28.150L35.193 27.831L35.279 27.592L35.486 27.382L35.726 27.273ZM37.201 28.588L37.383 28.589L37.523 28.708L37.558 28.907L37.440 29.083L37.241 29.131L37.038 28.987L37.029 28.748L37.200 28.589Z";
const WhaleTile = React.memo(function WhaleTile({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" fill="none" aria-hidden="true" style={{ display: "block", flex: "none" }}>
      <rect width="50" height="50" rx="11" fill="#ffffff" />
      <path d={WHALE_PATH} fill="#0f1115" />
    </svg>
  );
});

const Chevron = React.memo(function Chevron({ open }: { open: boolean }) {
  void open;
  return (
    <svg className="dsm-entry__chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});

/* ============================ 状态映射 ============================ */
type DotKind = "ok" | "warn" | "off" | "err";
const DOT_COLOR: Record<DotKind, string> = { ok: T.ok, warn: T.warn, off: T.off, err: T.danger };

function bridgeState(snap: CardSnapshot | null): { kind: DotKind; text: string } {
  const v: any = snap?.value ?? {};
  const errText = `${v.pairError ?? ""} ${v.registerError ?? ""}`;
  if (/401|unauthor|invalid|密码|登录失败|revoked|过期/.test(errText)) return { kind: "err", text: "需要重新登录" };
  if (snap?.status !== "ok") {
    return /connecting/.test(String(snap?.status ?? "")) ? { kind: "warn", text: "连接中…" } : { kind: "off", text: "未连接" };
  }
  if (v.bridgeStatus === "running" && v.username) return { kind: "ok", text: "已连接" };
  // 桥让位/被顶替：本机还有另一个桥实例在跑（旧版本孤儿或另一个 DSH 实例），本桥已主动退出
  if (/另一个桥实例|已让位/.test(String(v.bridgeStatus ?? ""))) return { kind: "warn", text: "另一个桥实例在运行" };
  if (v.username) return { kind: "warn", text: "连接中…" };
  return { kind: "off", text: "未连接" };
}

function StatusDot({ kind, badge = false }: { kind: DotKind; badge?: boolean }) {
  const color = DOT_COLOR[kind];
  const glow: React.CSSProperties =
    kind === "ok" ? { boxShadow: `0 0 0 3px rgba(52,195,126,.16)` }
      : kind === "warn" ? { boxShadow: `0 0 0 3px rgba(240,180,41,.16)` }
        : kind === "err" ? { boxShadow: `0 0 0 3px rgba(242,90,90,.18)` }
          : {};
  return <span className={badge ? "dsm-entry__badge" : undefined} style={{ width: 6, height: 6, borderRadius: "50%", background: color, flex: "none", ...glow }} />;
}

/* ============================ 面板 ============================ */
function DshmobileCard(props: any) {
  const wide = props.layout === "wide"; // 横版（宽窗口）还是竖排（窄窗口）
  const snap: CardSnapshot | null = props.useDshmobileCard((s: CardSnapshot) => s);
  const value: any = snap?.value ?? {};
  const [form, setForm] = React.useState<Record<string, string> | null>(null);
  const [left, setLeft] = React.useState(-1);
  const [e2eeLeft, setE2eeLeft] = React.useState(-1);
  const [localError, setLocalError] = React.useState("");
  const [copied, setCopied] = React.useState("");
  const qr1Ref = React.useRef<HTMLCanvasElement | null>(null);
  const qr2Ref = React.useRef<HTMLCanvasElement | null>(null);
  ensureStyle();

  // 表单与宿主值同步（仅初始化一次，避免覆盖用户输入）。
  // 密码**不回填明文**：留空即"不修改"（保存时跳过该字段，见 save()）。
  React.useEffect(() => {
    if (value && form === null) {
      setForm({
        relayUrl: value.relayUrl ?? "",
        username: value.username ?? "",
        password: "",
        deviceLabel: value.deviceLabel ?? "",
      });
    }
  }, [value, form]);

  const relay = ((form?.relayUrl || value.relayUrl || "").trim()).replace(/\/$/, "");
  const code = value.pairingCode || "";
  const mode = value.mode === "grant" ? "grant" : "pair";

  // 二维码 1：登录（pair）/ 授权本机（grant）——拼装逻辑不变
  const url1 = code
    ? mode === "grant"
      ? `${relay}/dshmobile/?mode=grant&code=${encodeURIComponent(code)}&pid=${encodeURIComponent(value.grantPairingId ?? "")}`
      : `${relay}/dshmobile/?mode=pair&code=${encodeURIComponent(code)}`
    : "";
  // 二维码 2：加密配对（mode=e2ee）——拼装逻辑不变
  const e2eeReady = Boolean(value.e2eeDeviceId && value.e2eePairingId);
  const url2 = e2eeReady
    ? `${relay}/dshmobile/?mode=e2ee&deviceId=${encodeURIComponent(value.e2eeDeviceId)}&pk=${encodeURIComponent(value.e2eePubKey ?? "")}&ps=${encodeURIComponent(value.e2eePairingSecret ?? "")}&pid=${encodeURIComponent(value.e2eePairingId)}&cv=${value.e2eeCryptoVersion ?? 1}`
    : "";

  // 两张码用同一套绘制参数（同尺寸 + 静区 ≥4 模块）
  // ⚠ deps 必须带 wide：横版↔竖排切换时 React 会换掉 canvas 节点（新节点是默认 300×150 的空白画布），
  //   只依赖 [url1, url2] 就会出现"拖窗口跨过 1000px 后二维码全白"（用户扫不了码）。
  //   回归探针：node pw-check/panel-harness/qr-layout-probe.mjs
  React.useEffect(() => {
    const plan = qrPlan([url1, url2]);
    paintQr(qr1Ref.current, plan ? plan.qrs[0] : null, plan);
    paintQr(qr2Ref.current, plan ? plan.qrs[1] : null, plan);
  }, [url1, url2, wide]);

  // 配对码 / 加密配对倒计时
  React.useEffect(() => {
    if (!value.pairingExpiresAt) return setLeft(-1) as any;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(value.pairingExpiresAt as string).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [value.pairingExpiresAt]);
  React.useEffect(() => {
    if (!value.e2eePairingExpiresAt) return setE2eeLeft(-1) as any;
    const tick = () => setE2eeLeft(Math.max(0, Math.round((new Date(value.e2eePairingExpiresAt as string).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [value.e2eePairingExpiresAt]);

  // 编辑时以「已保存值 + 草稿」兜底：form 可能因初始化时序只含部分字段
  const edit = (k: string, v: string) =>
    setForm((f) => ({
      relayUrl: (value as any)?.relayUrl ?? "",
      username: (value as any)?.username ?? "",
      password: "", // 明文不回填；继续保持空 = 不修改
      deviceLabel: (value as any)?.deviceLabel ?? "",
      ...(f ?? {}),
      [k]: v,
    }));

  const actions = snap?.actions ?? {};
  const save = async () => {
    if (!form) return;
    setLocalError("");
    const patch: Record<string, unknown> = {};
    for (const k of ["relayUrl", "username", "password", "deviceLabel"]) {
      const cur = (value as any)?.[k] ?? "";
      const next = form[k] ?? "";
      if (k === "password" && next === "") continue; // 留空 = 不修改（宿主无"空=不改"语义，必须客户端兜住）
      if (next !== cur) patch[k] = next.trim();
    }
    if (Object.keys(patch).length > 0) {
      try { await actions.save(patch); } catch (e) { setLocalError(String(e)); }
    }
  };
  const register = async () => {
    setLocalError("");
    const u = ((form?.username ?? (value as any)?.username) ?? "").trim();
    const p = (form?.password ?? "") as string;
    if (u.length < 3) { setLocalError("账号至少 3 个字符（字母/数字/下划线/横线）"); return; }
    if (p.length < 6) { setLocalError("密码至少 6 位"); return; }
    await save();
    try {
      await actions.register({ username: u, password: p });
    } catch (e) { setLocalError(String(e)); }
  };
  const genPairing = async () => {
    setLocalError("");
    try { await actions.refreshPairing(); } catch (e) { setLocalError(String(e)); }
  };
  const logout = async () => {
    setLocalError("");
    try { await actions.logout(); } catch (e) { setLocalError(String(e)); }
  };
  const copy = (text: string, tag: string) => {
    setCopied(tag);
    window.setTimeout(() => setCopied(""), 1600);
    try { void navigator.clipboard?.writeText(text); } catch { /* 忽略 */ }
  };

  const st = bridgeState(snap);
  const logged = Boolean(value.username);
  const errText = localError || value.registerError || value.pairError || "";
  const cnt1 = value.pairingExpiresAt ? (left > 0 ? `剩余 ${left}s` : "已过期") : "未生成";
  const cnt2 = value.e2eePairingExpiresAt ? (e2eeLeft > 0 ? `剩余 ${e2eeLeft}s` : "已过期") : "";

  // ---------- 共用内容（横版三栏 / 竖排三块 都从这里取） ----------
  const statusRows = (
    <>
      <div className="dsm-row">
        <span className="dsm-k">桥</span>
        <span className="dsm-v" style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <StatusDot kind={st.kind} />
          {st.text}
        </span>
      </div>
      <div className="dsm-row">
        <span className="dsm-k">账号</span>
        <span className="dsm-v">{value.username || "未登录"}</span>
      </div>
      {value.deviceLabel ? (
        <div className="dsm-row">
          <span className="dsm-k">设备</span>
          <span className="dsm-v">{value.deviceLabel}</span>
        </div>
      ) : null}
      {value.relayUrl ? (
        <div className="dsm-row">
          <span className="dsm-k">relay</span>
          <span className="dsm-v dsm-v--mono">{value.relayUrl}</span>
        </div>
      ) : null}
    </>
  );

  const loginRows = (
    <>
      <div className="dsm-row">
        <span className="dsm-k">relay 地址</span>
        <input className="dsm-input" value={form?.relayUrl ?? ""} placeholder="https://www.deepseek-claudex.cn"
          onChange={(e) => edit("relayUrl", e.target.value)} />
      </div>
      <div className="dsm-row">
        <span className="dsm-k">账号</span>
        <input className="dsm-input" value={form?.username ?? ""} placeholder="至少 3 位"
          onChange={(e) => edit("username", e.target.value)} />
      </div>
      <div className="dsm-row">
        <span className="dsm-k">密码</span>
        <input className="dsm-input" type="password" value={form?.password ?? ""} placeholder={logged ? "留空表示不修改" : "至少 6 位"}
          onChange={(e) => edit("password", e.target.value)} />
      </div>
      <div className="dsm-row">
        <span className="dsm-k">设备名</span>
        <input className="dsm-input" value={form?.deviceLabel ?? ""} placeholder="手机端显示的名称"
          onChange={(e) => edit("deviceLabel", e.target.value)} />
      </div>
    </>
  );

  // 登录区的说明 + 动作（两种布局共用；横版靠 .dsm-actions 压到卡片底部与其它栏对齐）
  const loginNote = (
    <p className="dsm-note" style={{ marginTop: 12 }}>
      已有账号直接连接；没有账号点「注册新账号」自动创建（账号 ≥3 位、密码 ≥6 位）。
    </p>
  );
  const loginButtons = (bottomAligned: boolean) => (
    <div
      className={bottomAligned ? "dsm-actions" : undefined}
      style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", ...(bottomAligned ? {} : { marginTop: 12 }) }}
    >
      <button className="dsm-btn dsm-btn--brand" onClick={save}>保存并连接</button>
      <button className="dsm-btn dsm-btn--ghost" onClick={register}>注册新账号</button>
      {/* 退出登录并进登录栏（不再单独占一行） */}
      {logged ? (
        <button className="dsm-btn dsm-btn--danger" style={{ marginLeft: "auto" }} onClick={logout}>退出登录</button>
      ) : null}
    </div>
  );
  const loginErr = errText ? <div className="dsm-err"><span>!</span><span>{errText}</span></div> : null;

  // 竖版用：错误条 + 登录行 + 说明 + 按钮
  const loginBody = (
    <>
      {loginErr}
      {loginRows}
      {loginNote}
      {loginButtons(false)}
    </>
  );

  // ① 登录 / 授权（未登录时也有：手机扫码授权本机登录）
  const pairCard = (
    <div className="dsm-qr-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: T.dim }}>① 登录 · 授权</span>
        <span className="dsm-pill">{cnt1}</span>
      </div>
      <div style={{ marginTop: 2 }}>
        <span className="dsm-tile">
          <canvas ref={qr1Ref} />
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span className="dsm-code">{value.pairingCode || "------"}</span>
        <button className="dsm-btn dsm-btn--ghost dsm-btn--xs"
          onClick={() => copy(String(value.pairingCode ?? ""), "code")} disabled={!value.pairingCode}>
          {copied === "code" ? "已复制" : "复制"}
        </button>
      </div>
      <p className="dsm-note" style={{ marginTop: 8 }}>
        {mode === "grant"
          ? "手机（已登录）扫码授权本机登录同一账号。"
          : "手机扫码即可登录同一账号，无需输入密码。"}
      </p>
      <button className="dsm-btn dsm-btn--ghost" style={{ marginTop: 10, width: "100%" }} onClick={genPairing}>
        刷新二维码
      </button>
    </div>
  );

  // ② 加密配对：本机登录后才可用
  // 状态行：让"是否已与手机配对"在面板上一眼可见（PC 侧唯一的可见入口）。
  // 2026-09-23 拍板：**删掉「允许明文 / 要求加密」切换按钮** —— 明文只能"按次"（手机侧临时放行，桥重启即恢复），
  // 任何地方都不再提供"永久关掉加密"的 UI 出口。桥/宿主的 require 能力与 /state 字段保留（additive，只读展示）。
  const e2eeRequire = value.e2eeRequire !== false;   // 缺字段（老桥）→ 按"要求加密"显示
  const e2eePinned = value.e2eePinned === true;
  const e2eeStatusText = `${e2eePinned ? "已配对" : "未配对"} · ${e2eeRequire ? "要求加密" : "允许明文（策略被外部改写）"}`;
  const e2eeStatusTitle = e2eePinned && value.e2eePeerKeyId
    ? `已与本机配对的手机密钥 ${value.e2eePeerKeyId}…（${e2eeRequire ? "要求加密" : "允许明文"}）`
    : (e2eeRequire
      ? "这台电脑要求端到端加密：手机需扫码配对后才能连接；在外地够不到电脑时可在手机上按次使用明文"
      : "这台电脑当前允许明文（策略文件被外部改写为 require=false）");
  const e2eeStatusColor = !e2eeRequire ? T.warn : e2eePinned ? T.ok : T.caption;
  // 状态点 + 文案，放在**二维码下方**（避免占掉二维码上方的高度 → 破坏"两码同顶边"对齐）
  const e2eeChip = (
    <span title={e2eeStatusTitle} style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: e2eeStatusColor, flex: "none" }} />
      <span style={{ color: e2eeStatusColor, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e2eeStatusText}</span>
    </span>
  );
  const e2eeInlineRow = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
      {e2eeChip}
    </div>
  );
  const e2eeCard = (
    <div className="dsm-qr-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: T.dim }}>② 加密配对</span>
        {cnt2 ? <span className="dsm-pill">{cnt2}</span> : null}
      </div>
      {e2eeReady ? (
        <>
          <div style={{ marginTop: 2 }}>
            <span className="dsm-tile">
              <canvas ref={qr2Ref} />
            </span>
          </div>
          {e2eeInlineRow}
          <p className="dsm-note" style={{ marginTop: 10, marginBottom: 0 }}>
            手机登录后扫此码，把本机与手机做成端到端加密绑定，设备列表会出现钥匙图标。
          </p>
        </>
      ) : (
        <>
          <p className="dsm-note" style={{ margin: 0 }}>加密配对 · 本机登录后可用</p>
          {e2eeInlineRow}
        </>
      )}
    </div>
  );

  // 横版顶部细状态栏
  const bar = (
    <div className="dsm-bar">
      <WhaleTile size={18} />
      <span className="dsm-bar__title">DSH Mobile</span>
      <span className="dsm-bar__state"><StatusDot kind={st.kind} />{st.text}</span>
      <span className="dsm-bar__sep" />
      <span className="dsm-bar__item">账号 {value.username || "未登录"}</span>
      {value.deviceLabel ? <span className="dsm-bar__item">设备 {value.deviceLabel}</span> : null}
      {/* relay 地址不放状态栏（登录栏输入框里可读），避免挤掉账号/设备的显示 */}
      <span className="dsm-bar__ver">{value.bridgeVersion ? `bridge v${value.bridgeVersion}` : ""}</span>
      <a className="dsm-bar__link" style={{ textDecoration: "none" }} href="https://github.com/zdx8637-gitdog/dshmobile#readme" target="_blank" rel="noreferrer">帮助文档</a>
      {props.onClose ? (
        <button type="button" className="dsm-bar__close" onClick={props.onClose} title="关闭">✕</button>
      ) : null}
    </div>
  );

  // 横版：细状态栏 + 三栏（登录 / 配对二维码 / E2EE 二维码）
  // 对齐规则：三栏等宽等高；每栏 = 栏标题(带倒计时/状态) → 卡片(同构) → 底部动作(同一基线)；二维码居中。
  if (wide) {
    const pairMeta = value.pairingCode ? (left > 0 ? `剩余 ${left}s` : "已过期") : "未生成";
    const e2eeMeta = e2eeReady ? (e2eeLeft > 0 ? `剩余 ${e2eeLeft}s` : "已过期") : "登录后可用";
    return (
      <div>
        {bar}
        <div className="dsm-cols">
          {/* 栏 1：登录 */}
          <section className="dsm-col">
            <div className="dsm-h">
              <span>登录</span>
              <span className="dsm-h__meta">{value.enabled === false ? "已停用" : logged ? "已登录" : "未登录"}</span>
            </div>
            <div className="dsm-qr-card dsm-colcard">
              {loginErr}
              {loginRows}
              {loginNote}
              {loginButtons(true)}
            </div>
          </section>

          {/* 栏 2：配对二维码（未登录也有：手机扫码授权本机登录） */}
          <section className="dsm-col">
            <div className="dsm-h">
              <span>配对二维码</span>
              <span className="dsm-h__meta">{value.mode === "grant" ? "授权本机登录" : "登录同一账号"} · {pairMeta}</span>
            </div>
            <div className="dsm-qr-card dsm-colcard">
              <div className="dsm-tilewrap">
                <span className="dsm-tile">
                  <canvas ref={qr1Ref} />
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 12 }}>
                <span className="dsm-code">{value.pairingCode || "------"}</span>
                <button className="dsm-btn dsm-btn--ghost dsm-btn--xs"
                  onClick={() => copy(String(value.pairingCode ?? ""), "code")} disabled={!value.pairingCode}>
                  {copied === "code" ? "已复制" : "复制"}
                </button>
              </div>
              <p className="dsm-note" style={{ marginTop: 10, textAlign: "center" }}>
                {mode === "grant"
                  ? "手机（已登录）扫码授权本机登录同一账号。"
                  : "手机扫码即可登录同一账号，无需输入密码。"}
              </p>
              <button className="dsm-btn dsm-btn--ghost dsm-actions" style={{ width: "100%" }} onClick={genPairing}>
                刷新二维码
              </button>
            </div>
          </section>

          {/* 栏 3：E2EE 二维码（本机登录后才可用） */}
          <section className="dsm-col">
            <div className="dsm-h">
              <span>E2EE 二维码</span>
              <span className="dsm-h__meta">{e2eeReady ? `端到端加密 · ${e2eeMeta}` : "登录后可用"}</span>
            </div>
            <div className="dsm-qr-card dsm-colcard">
              {e2eeReady ? (
                <>
                  <div className="dsm-tilewrap">
                    <span className="dsm-tile">
                      <canvas ref={qr2Ref} />
                    </span>
                  </div>
                  {e2eeInlineRow}
                  <p className="dsm-note" style={{ marginTop: 12, textAlign: "center" }}>
                    手机登录后扫此码，把本机与手机做成端到端加密绑定。
                  </p>
                  <p className="dsm-note dsm-actions" style={{ textAlign: "center", color: T.muted, marginBottom: 0 }}>
                    配对成功后，设备列表会出现钥匙图标。
                  </p>
                </>
              ) : (
                <p className="dsm-note" style={{ margin: "auto 0", textAlign: "center" }}>
                  加密配对 · 本机登录后可用
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  // 窄窗口：竖排三块（状态 / 登录 / 二维码）
  return (
    <div>
      <div className="dsm-sec">
        <div className="dsm-h">
          <span>状态</span>
          <span className="dsm-h__meta">{value.bridgeVersion ? `bridge v${value.bridgeVersion}` : ""}</span>
        </div>
        {statusRows}
        <div style={{ marginTop: 12 }}>
          <a className="dsm-btn dsm-btn--ghost dsm-btn--xs" style={{ textDecoration: "none" }} href="https://github.com/zdx8637-gitdog/dshmobile#readme" target="_blank" rel="noreferrer">帮助文档</a>
        </div>
      </div>
      <div className="dsm-sec">
        <div className="dsm-h">
          <span>登录</span>
          <span className="dsm-h__meta">{value.enabled === false ? "已停用" : ""}</span>
        </div>
        {loginBody}
      </div>
      <div className="dsm-sec">
        <div className="dsm-h">
          <span>二维码</span>
          <span className="dsm-h__meta">{value.mode === "grant" ? "未登录 · 授权码" : "已登录 · 登录码"}</span>
        </div>
        {pairCard}
        {e2eeCard}
      </div>
    </div>
  );
}

export function apply(ctx: any) {
  ensureStyle();
  const post = async (path: string, body: any): Promise<void> => {
    const res = await fetch(PANEL_HTTP + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
    }
  };

  // 动作一律走本地 HTTP 通道（宿主 127.0.0.1:17653）；错误上抛给卡片显示
  const actions = {
    refreshPairing: () => post("/action", { action: "refreshPairing" }),
    save: (patch: Record<string, unknown>) => post("/action", { action: "save", payload: patch }),
    register: (req: { username: string; password: string }) =>
      post("/action", { action: "register", payload: req }),
    logout: () => post("/action", { action: "logout" }),
    // E2EE 策略切换：require=false 时一并解除配对（clearPin），与手机端"永久改用非加密"等价
    e2eePolicy: (payload: { require: boolean; clearPin?: boolean }) =>
      post("/action", { action: "e2eePolicy", payload }),
  };

  const store = createSnapshotStore<CardSnapshot>({
    status: "connecting",
    value: null,
    actions,
  });

  // 轮询宿主状态（1s）；失败保留上次快照并显示原因
  let alive = true;
  let lastValue: CardSnapshot["value"] = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (alive) {
      try {
        const res = await fetch(`${PANEL_HTTP}/state`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok !== true) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        lastValue = (body?.data ?? null) as CardSnapshot["value"];
        store.set({ status: "ok", value: lastValue, actions });
      } catch (e: any) {
        store.set({ status: `unavailable: ${e?.message ?? e}`, value: lastValue, actions });
      }
      await sleep(1000);
    }
  })();

  // 左侧栏底部的可折叠入口：图标 + 名称 + 状态点 + 箭头 → 点开浮层面板
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    {
      name: "sidebar.footer.action",
      id: "dshmobile",
      order: 10,
      inject: () => ({
        hooks: { dshmobileCard: store },
      }),
    },
    DshmobileSidebarAction,
  ));

  return () => {
    alive = false;
  };
}

/** 宽窗口用横版三栏（920px 面板），窄窗口回退竖排；阈值 1040 = 面板 960 + 遮罩内边距 48 + 余量。 */
const WIDE_MIN = 1000;
function usePanelWide(): boolean {
  const [wide, setWide] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth >= WIDE_MIN
  );
  React.useEffect(() => {
    const on = () => setWide(window.innerWidth >= WIDE_MIN);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return wide;
}

/** 侧栏动作：入口按钮；点开后在**屏幕中央弹出模态面板**（点遮罩空白处或 Esc 关闭）。 */
function DshmobileSidebarAction(props: any) {
  const [open, setOpen] = React.useState(false);
  const wide = Boolean(props.wide);      // 侧栏是否展开（宽栏/窄轨）
  const panelWide = usePanelWide();      // 面板用横版还是竖排
  const btnRef = React.useRef<HTMLButtonElement | null>(null);
  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  // 兜底定位：仅当遮罩被祖先的包含块（transform 等）裁掉时才启用
  const [anchored, setAnchored] = React.useState<{ left: number; top: number; maxH: number } | null>(null);
  const snap: CardSnapshot | null = props.useDshmobileCard?.((s: CardSnapshot) => s);
  const st = bridgeState(snap ?? null);
  const title = `${open ? "关闭" : "打开"} DSH Mobile 远程桥接 · ${st.text}`;
  ensureStyle();

  // Esc 关闭 + 焦点处理
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      try { prev?.focus?.(); } catch { /* 忽略 */ }
    };
  }, [open]);

  // 自检：遮罩必须铺满视口。若祖先建了包含块 → 退回锚定定位（宁可贴边也不被裁）
  React.useLayoutEffect(() => {
    if (!open) return;
    const check = () => {
      const el = overlayRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const clipped = Math.abs(r.left) > 1 || Math.abs(r.top) > 1 ||
        Math.abs(r.width - window.innerWidth) > 2 || Math.abs(r.height - window.innerHeight) > 2;
      if (!clipped) { setAnchored(null); return; }
      console.warn("[dshmobile] 弹窗遮罩被祖先裁剪（含 transform 的包含块），已退回锚定定位");
      const b = btnRef.current?.getBoundingClientRect();
      const vh = window.innerHeight;
      const maxH = Math.max(200, vh - 32);
      const left = Math.min(Math.max(8, b ? b.right + 12 : 8), Math.max(8, window.innerWidth - T.panelW - 8));
      const top = Math.max(8, Math.min(b ? b.top - 8 : 8, vh - 200));
      setAnchored({ left, top, maxH });
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        className={wide ? "dsm-entry" : "dsm-entry dsm-entry--rail"}
        data-open={open ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-expanded={open}
      >
        <WhaleTile size={wide ? 22 : 24} />
        {wide ? (
          <>
            <span className="dsm-entry__label">DSH Mobile</span>
            <span className="dsm-entry__status">
              <StatusDot kind={st.kind} />
              {st.text}
            </span>
            <Chevron open={open} />
          </>
        ) : (
          <StatusDot kind={st.kind} badge />
        )}
      </button>
      {open ? (
        <div
          ref={overlayRef}
          className={anchored ? "dsm-overlay dsm-overlay--anchored" : "dsm-overlay"}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal={anchored ? undefined : true}
            aria-label="DSH Mobile 远程桥接"
            className={"dsm-panel" + (panelWide ? " dsm-panel--wide" : "") + (anchored ? " dsm-panel--anchored" : "")}
            style={anchored ? { left: anchored.left, top: anchored.top, maxHeight: anchored.maxH } : undefined}
          >
            <DshmobileCard {...props} layout={panelWide ? "wide" : "stack"} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
