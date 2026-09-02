// 生成 docs/images/banner.html（1280×640 横幅源文件，用真实截图叠层排版）
// 布局：左 = 文字区（品牌/卖点/三端），中缝分隔线，右 = 插件面板主图 + 三张手机截图扇形叠层
// 用法: node gen-banner.mjs   → 再用 Edge 无头截图 banner.html 得 banner.png
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 1280px; height: 640px; overflow: hidden;
    font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; }
  body {
    background:
      radial-gradient(circle, rgba(93,113,153,.30) 1px, transparent 1.2px) 0 0 / 40px 44px,
      radial-gradient(640px 480px at 14% 10%, rgba(34,211,238,.13), transparent 62%),
      radial-gradient(700px 520px at 88% 92%, rgba(124,58,237,.16), transparent 62%),
      linear-gradient(135deg, #0A101F 0%, #0E1A33 55%, #132648 100%);
    color: #F3F7FF;
  }
  .badge { position: absolute; left: 80px; top: 64px; font-size: 17px; letter-spacing: 5px; color: #22D3EE; }
  .title { position: absolute; left: 74px; top: 132px; font-size: 78px; font-weight: 700; line-height: 1; }
  .title .m { background: linear-gradient(90deg, #4FC3F7, #A78BFA); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tag1 { position: absolute; left: 80px; top: 252px; font-size: 26px; color: #A9BCDD; }
  .tag2 { position: absolute; left: 80px; top: 292px; font-size: 20px; color: #7E93B8; }
  .item { position: absolute; left: 80px; font-size: 22px; color: #C9D8F2; }
  .item i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 14px; vertical-align: 2px; }
  .i1 { top: 356px; } .i1 i { background: #34D399; }
  .i2 { top: 400px; } .i2 i { background: #22D3EE; }
  .i3 { top: 444px; } .i3 i { background: #A78BFA; }
  .rule { position: absolute; left: 80px; top: 498px; width: 350px; height: 1px; background: rgba(255,255,255,.10); }
  .foot { position: absolute; left: 80px; top: 528px; font-size: 18px; color: #5D7199; }
  .divider { position: absolute; left: 470px; top: 100px; width: 1px; height: 440px; background: rgba(255,255,255,.12); }
  .panel { position: absolute; right: 20px; top: 76px; width: 520px; height: 489px; object-fit: cover;
    border-radius: 16px; border: 1px solid rgba(255,255,255,.22); transform: rotate(-1.5deg);
    box-shadow: 0 24px 60px rgba(0,0,0,.55); }
  .pcaption { position: absolute; right: 120px; top: 586px; font-size: 17px; color: #7E93B8; }
  .phone { position: absolute; border-radius: 18px; border: 1px solid rgba(255,255,255,.25);
    box-shadow: 0 18px 44px rgba(0,0,0,.5); }
  .p1 { left: 520px; top: 224px; width: 150px; transform: rotate(-7deg); }
  .p2 { left: 596px; top: 168px; width: 150px; transform: rotate(-3deg); }
  .p3 { left: 672px; top: 196px; width: 150px; transform: rotate(2.5deg); }
</style></head>
<body>
  <div class="badge">DEEPSEEK HARNESS</div>
  <div class="title">dsh<span class="m">mobile</span></div>
  <div class="tag1">手机远程控制</div>
  <div class="tag2">DeepSeek Harness · 扫码登录 / 授权 / 远程对话</div>
  <div class="item i1"><i></i>Android 客户端</div>
  <div class="item i2"><i></i>云端 Relay</div>
  <div class="item i3"><i></i>DSH 插件</div>
  <div class="rule"></div>
  <div class="foot">github.com/zdx8637-gitdog/dshmobile · MIT</div>
  <div class="divider"></div>
  <img class="panel" src="plugin-panel.jpg" alt=""/>
  <div class="pcaption">电脑端插件 · 左侧栏常驻二维码</div>
  <img class="phone p1" src="phone-1.jpg" alt=""/>
  <img class="phone p2" src="phone-2.jpg" alt=""/>
  <img class="phone p3" src="phone-3.jpg" alt=""/>
</body></html>`

mkdirSync(here, { recursive: true })
writeFileSync(join(here, 'banner.html'), html)
console.log('banner.html written')
