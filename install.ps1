# 识屏助手一键安装：找 CLI -> 备份 profile -> 安装 -> 检查 bundles。
$ErrorActionPreference = 'Stop'

$packageDir = $PSScriptRoot
$cli = $null

# 1. PATH 里的 dsh
$command = Get-Command dsh -ErrorAction SilentlyContinue
if ($command) {
  $cli = $command.Source
}

# 2. 桌面版自带的 CLI：从正在运行的 DeepSeek Harness 推断安装目录
if (-not $cli) {
  $process = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($process -and $process.Path) {
    $candidate = Join-Path (Split-Path $process.Path) 'resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path $candidate) { $cli = $candidate }
  }
}

# 3. 常见安装位置兜底
if (-not $cli) {
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
      (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )) {
    if (Test-Path $candidate) { $cli = $candidate; break }
  }
}

if (-not $cli) {
  throw '找不到 dsh CLI。请在 DSH 里用「插件」页面安装，或手动执行：dsh plugin --profile desktop add "' + $packageDir + '"'
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\desktop'
if (Test-Path $profileDir) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($name in @('package.json', 'cordis.patch.yml', 'pnpm-lock.yaml')) {
    $source = Join-Path $profileDir $name
    if (Test-Path $source) {
      Copy-Item $source (Join-Path $profileDir ($name + '.bak-' + $stamp))
    }
  }
  Write-Host "已备份 profile 配置到 $profileDir（后缀 .bak-$stamp）"
}

Write-Host "使用 CLI：$cli"
& $cli plugin --profile desktop add $packageDir
if ($LASTEXITCODE -ne 0) { throw "安装失败（exit $LASTEXITCODE）" }

Write-Host ''
Write-Host '安装完成，正在检查 profile 的 bundles 列表…'
$profileJson = Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($profileJson.dsh.profile.bundles -notcontains 'dsh-screen-assistant') {
  throw '安装命令结束了，但 bundles 列表里没有 dsh-screen-assistant；请打开 DSH 的「插件」页面确认。'
}
Write-Host '已加入 dsh.profile.bundles：dsh-screen-assistant'

Write-Host ''
Write-Host '刷新页面后聊天页右下角会出现「识屏」按钮；全局快捷键由宿主注册，需要重启一次 DSH 才会生效。'
