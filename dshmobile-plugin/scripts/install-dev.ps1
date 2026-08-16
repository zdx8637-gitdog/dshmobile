# Dev install: link this plugin into the web profile and add its patch row.
# Usage: powershell -File scripts/install-dev.ps1
$ErrorActionPreference = "Stop"
$plugin = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$profile = Join-Path $env:USERPROFILE ".dsh\profiles\web"
if (-not (Test-Path $profile)) { throw "profile not found: $profile" }

# 1) build (cwd must be the plugin root for esbuild's relative entry points)
Push-Location $plugin
try {
  node (Join-Path $PSScriptRoot "build.mjs")
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
} finally {
  Pop-Location
}

# 2) link dependency into the profile workspace
$pkgJson = Join-Path $profile "package.json"
$pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
$pkg.dependencies = @{ "@liustack/dshmobile-bridge" = "link:$plugin" }
$pkg | ConvertTo-Json -Depth 8 | Set-Content $pkgJson -Encoding UTF8

& npx.cmd --yes pnpm@9 install --dir $profile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

# 3) patch row (idempotent)
$patchFile = Join-Path $profile "cordis.patch.yml"
$patch = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { "[]" }
if ($patch -notmatch "dshmobile-bridge") {
  $block = @"
- insert:
    - id: dshmobile-bridge
      name: '@liustack/dshmobile-bridge'
"@
  $patch = $patch.TrimEnd() + "`n" + $block
  Set-Content $patchFile -Value $patch -Encoding UTF8
  Write-Host "patch row added"
} else {
  Write-Host "patch row already present"
}

Write-Host ""
Write-Host "Install done. Restart dsh, then open Settings -> Plugins: the 'DSH Mobile Bridge' card should appear."
