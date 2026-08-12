<#
toast-linger 一键编译脚本（E-05）

用 MSBuild 编译 scripts/toast-linger/toast-linger.csproj（.NET Framework 4.7.2 +
WinRT 投影），产物覆盖输出到 resources/bin/toast-linger.exe（随扩展打包分发）。

用法（在仓库任意位置执行均可，脚本自动定位仓库根）：
    powershell -ExecutionPolicy Bypass -File scripts\toast-linger\build.ps1

依赖：
    - Visual Studio Build Tools / Visual Studio（MSBuild.exe）
    - Windows 10 SDK（UnionMetadata 下的 Windows.winmd，脚本与 csproj 自动探测版本）
    - .NET Framework 4.7.2 开发包（引用程序集）

退出码：0 = 成功；非 0 = 未找到 MSBuild / 编译失败（直接透传 MSBuild 退出码）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$csproj = Join-Path $scriptDir 'toast-linger.csproj'
$outExe = Join-Path $repoRoot 'resources\bin\toast-linger.exe'

$msbuild = $null
# 1) vswhere 定位 VS 2017+ 的 MSBuild（VS / Build Tools 安装时的标准位置）
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
    $msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
}
# 2) 回退：PATH 中直接可用的 msbuild（老式完整 VS 安装）
if (-not $msbuild) {
    $cmd = Get-Command msbuild -ErrorAction SilentlyContinue
    if ($cmd) { $msbuild = $cmd.Source }
}
if (-not $msbuild) {
    Write-Error '未找到 MSBuild.exe：请安装 Visual Studio Build Tools（含 MSBuild 组件）或把 msbuild 加入 PATH。'
    exit 2
}

Write-Host "[toast-linger] MSBuild: $msbuild"
Write-Host "[toast-linger] 编译 $csproj（Release，自动探测 Windows SDK UnionMetadata 版本）"

# 编译到默认 OutputPath（scripts/toast-linger/bin/Release），成功后再覆盖发布产物
& $msbuild $csproj /t:Build /p:Configuration=Release /v:minimal /nologo
if ($LASTEXITCODE -ne 0) {
    Write-Error "[toast-linger] 编译失败（MSBuild 退出码 $LASTEXITCODE）"
    exit $LASTEXITCODE
}

$built = Join-Path $scriptDir 'bin\Release\toast-linger.exe'
if (-not (Test-Path $built)) {
    Write-Error "[toast-linger] 编译产物不存在：$built"
    exit 3
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outExe) | Out-Null
Copy-Item -Path $built -Destination $outExe -Force
Write-Host "[toast-linger] 已输出: $outExe"
Write-Host '[toast-linger] 提醒：resources/bin/toast-linger.exe 已被覆盖，请实际验证通知显示后再提交。'
exit 0
