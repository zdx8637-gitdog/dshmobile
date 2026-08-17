// 生成 docs/images/banner.svg（1280×640 深色横幅，用于 GitHub Social preview 与 README 顶部）
// 用法: node gen-banner.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ---- 装饰性二维码（21×21，确定性图案） ----
let seed = 20260817
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const N = 21
const m = Array.from({ length: N }, () => Array(N).fill(false))
const set = (r, c, v = true) => { if (r >= 0 && r < N && c >= 0 && c < N) m[r][c] = v }
const finder = (r, c) => {
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
    const edge = i === 0 || i === 6 || j === 0 || j === 6
    const core = i >= 2 && i <= 4 && j >= 2 && j <= 4
    set(r + i, c + j, edge || core)
  }
}
finder(0, 0); finder(0, 14); finder(14, 0)
for (let i = 8; i < 13; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
  if ((r <= 7 && c <= 7) || (r <= 7 && c >= 13) || (r >= 13 && c <= 7)) continue
  if (r === 6 || c === 6 || (r === 13 && c === 13)) continue
  m[r][c] = rnd() > 0.5
}
set(13, 13, true)

// ---- 二维码 SVG 片段 ----
const MOD = 13
const QX = 830, QY = 150 // 含静区的左上角
let qrRects = ''
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
  if (m[r][c]) {
    const x = QX + 4 * MOD + c * MOD // 4 模块静区
    const y = QY + 4 * MOD + r * MOD
    qrRects += `<rect x="${x}" y="${y}" width="${MOD}" height="${MOD}" rx="2.4" fill="#0D1526"/>`
  }
}

const chips = [
  { t: 'Android 客户端', c: '#34D399', x: 100 },
  { t: '云端 Relay', c: '#22D3EE', x: 300 },
  { t: 'DSH 插件', c: '#A78BFA', x: 500 },
].map(({ t, c, x }) => `
  <g>
    <rect x="${x}" y="404" width="176" height="52" rx="26" fill="#152238" stroke="#2E4470"/>
    <circle cx="${x + 26}" cy="430" r="7" fill="${c}"/>
    <text x="${x + 44}" y="438" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="22" fill="#C9D8F2">${t}</text>
  </g>`).join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A101F"/>
      <stop offset="0.55" stop-color="#0E1A33"/>
      <stop offset="1" stop-color="#132648"/>
    </linearGradient>
    <linearGradient id="ttl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#4FC3F7"/>
      <stop offset="1" stop-color="#A78BFA"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.15" cy="0.12" r="0.6">
      <stop offset="0" stop-color="#22D3EE" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#22D3EE" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.88" cy="0.9" r="0.6">
      <stop offset="0" stop-color="#7C3AED" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#7C3AED" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1280" height="640" fill="url(#bg)"/>
  <rect width="1280" height="640" fill="url(#glow1)"/>
  <rect width="1280" height="640" fill="url(#glow2)"/>
  <g fill="#5D7199" opacity="0.35">
    ${Array.from({ length: 30 }, (_, i) => Array.from({ length: 14 }, (_, j) =>
      `<circle cx="${40 + i * 40}" cy="${30 + j * 44}" r="1.2"/>`).join('')).join('')}
  </g>
  <text x="100" y="150" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="22" letter-spacing="6" fill="#22D3EE">DEEPSEEK HARNESS · 手机远程控制</text>
  <text x="94" y="278" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="116" font-weight="700" fill="#F3F7FF">dsh<tspan fill="url(#ttl)">mobile</tspan></text>
  <text x="100" y="336" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="30" fill="#A9BCDD">一个二维码，手机一扫：登录 / 授权 / 远程对话 / 审批</text>
  <text x="100" y="378" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="24" fill="#7E93B8">扫码配对 → 设备 → 会话树 → 对话 · 审批 · 提问应答 · 模型切换 · 文件浏览</text>
  ${chips}
  <text x="100" y="556" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="22" fill="#5D7199">github.com/zdx8637-gitdog/dshmobile · MIT</text>
  <!-- 二维码卡片 -->
  <g>
    <rect x="808" y="112" width="432" height="432" rx="18" fill="#FFFFFF" fill-opacity="0.04" stroke="#FFFFFF" stroke-opacity="0.10"/>
    <rect x="814" y="118" width="420" height="420" rx="14" fill="#F4F8FF"/>
    ${qrRects}
    <text x="1024" y="580" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="22" fill="#A9BCDD" text-anchor="middle">常驻二维码 · 一码三用</text>
  </g>
</svg>`

mkdirSync(here, { recursive: true })
writeFileSync(join(here, 'banner.svg'), svg)
console.log('banner.svg written')
