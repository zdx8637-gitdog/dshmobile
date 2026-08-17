# 把本插件的 settings 命名空间加进 DSH 的浏览器暴露白名单。
#
# 背景：DSH 0.1.0-rc.6 的 dsh-host-apiproxy 用硬编码 WEB_SETTINGS_NAMESPACES
# 决定哪些命名空间对 Web 配置客户端可见/可写；第三方插件注册的命名空间默认
# 不暴露（上游注释明确标注为 deferred work）。本脚本做本地单行补丁。
# dsh 包升级（npx 缓存换新目录）后需重跑本脚本。
param(
  [string]$FilePath = $null
)

$ErrorActionPreference = "Stop"

$candidates = @()
if ($FilePath) {
  $candidates = @($FilePath)
} else {
  $root = Join-Path $env:LOCALAPPDATA "npm-cache\_npx"
  if (Test-Path $root) {
    $candidates = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Join-Path $_.FullName "node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js"
    } | Where-Object { Test-Path $_ }
  }
}

if ($candidates.Count -eq 0) {
  Write-Host "No dsh-host-apiproxy found under npx cache. Pass the path manually:"
  Write-Host "  powershell -File expose-settings-namespace.ps1 -FilePath <index.js>"
  exit 1
}

foreach ($f in $candidates) {
  $t = [System.IO.File]::ReadAllText($f)
  if ($t -match '"dshmobile"') {
    Write-Host "already patched: $f"
    continue
  }
  Copy-Item $f "$f.bak-dshmobile" -Force
  $t = $t.Replace('"web-search-deepseek"' + "`n" + ']', '"web-search-deepseek",' + "`n" + '	"dshmobile"' + "`n" + ']')
  [System.IO.File]::WriteAllText($f, $t, [System.Text.UTF8Encoding]::new($false))
  Write-Host "patched: $f"
}
Write-Host "Restart dsh for the change to take effect."
