param([switch]$NoPrompt, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Quote-NativeArgument([string]$Value) {
    # 按 Windows 命令行规则保护空格、双引号与末尾反斜线。
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

try {
    $record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.format -ne 1 -or $record.packageSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw '恢复记录无效。' }
    $installDirectory = [IO.Path]::GetFullPath([string]$record.installDirectory)
    if ($installDirectory.TrimEnd('\') -eq [IO.Path]::GetPathRoot($installDirectory).TrimEnd('\')) { throw '不能向磁盘根目录恢复程序。' }
    if ([IO.Path]::GetFileName([string]$record.packageFile) -ne $record.packageFile) { throw '回退包路径无效。' }
    $packageFile = Join-Path $PSScriptRoot $record.packageFile
    $currentDirectory = Join-Path $installDirectory 'current'
    if ((Test-Path -LiteralPath $currentDirectory) -and ((Get-Item -LiteralPath $currentDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw '程序目录是链接，请先确认安装位置。'
    }
    Write-Host ('安装位置：' + $installDirectory)
    Write-Host ('恢复版本：' + $record.version)
    Write-Host '此入口只修复程序文件，数据目录不会被修改。'
    if (-not $NoPrompt -and (Read-Host '确认继续请输入 Y') -ne 'Y') { exit 0 }

    # Chromium 沙箱进程不能读取 MainModule，使用只查询映像路径的系统权限。
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GrayCodeRepairProcess {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder value, ref uint length);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static string PathFor(int id) {
        IntPtr handle = OpenProcess(0x1000, false, id);
        if (handle == IntPtr.Zero) return null;
        try { var value = new StringBuilder(32768); uint length = 32768; return QueryFullProcessImageName(handle, 0, value, ref length) ? value.ToString() : null; }
        finally { CloseHandle(handle); }
    }
}
'@
    # 只检查本安装目录的进程；不按名称终止其他 GrayCode 实例。
    foreach ($process in Get-Process -Name 'GrayCode','GrayCode.ComputerHost' -ErrorAction SilentlyContinue) {
        $executable = [GrayCodeRepairProcess]::PathFor($process.Id)
        if (-not $executable) { throw ('无法确认进程 ' + $process.Id + ' 的归属，请退出应用后重试。') }
        if ($executable.StartsWith($currentDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw ('请先退出本安装目录的程序再修复。进程 ' + $process.Id + '：' + $executable)
        }
    }
    Write-Host '正在校验回退包…'
    $packageStream = [IO.File]::OpenRead($packageFile)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $packageHash = [BitConverter]::ToString($hasher.ComputeHash($packageStream)).Replace('-', '') }
    finally { $packageStream.Dispose(); $hasher.Dispose() }
    if ($packageHash -ne $record.packageSha256) { throw '回退包校验失败，程序文件未被修改。' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($packageFile)
    try {
        $manifestEntry = $archive.GetEntry('lib/app/sq.version')
        $updaterEntry = $archive.GetEntry('lib/app/Squirrel.exe')
        if (-not $manifestEntry -or -not $updaterEntry) { throw '回退包缺少安装元数据或更新器。' }
        $reader = New-Object IO.StreamReader($manifestEntry.Open())
        try { $manifestText = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $manifest = [xml]$manifestText
        if ($manifest.package.metadata.id -ne 'GrayCode' -or $manifest.package.metadata.version -ne $record.version) { throw '回退包不属于指定的 GrayCode 版本。' }
        $repairUpdater = Join-Path $PSScriptRoot 'RepairUpdate.exe'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($updaterEntry, $repairUpdater, $true)
        # 安装中断可能留下空的 current；补回清单后交由原生安装器完整重建。
        $currentManifest = Join-Path $currentDirectory 'sq.version'
        if (Test-Path -LiteralPath $currentManifest) {
            $existing = [xml](Get-Content -LiteralPath $currentManifest -Raw -Encoding UTF8)
            if ($existing.package.metadata.id -ne 'GrayCode') { throw '当前安装位置已属于其他应用，未执行修复。' }
        } else {
            [IO.Directory]::CreateDirectory($currentDirectory) | Out-Null
            [IO.File]::WriteAllText($currentManifest, $manifestText, (New-Object Text.UTF8Encoding($false)))
        }
    } finally { $archive.Dispose() }
    Write-Host '正在恢复程序文件…'
    $nativeArguments = @('--silent', '--rootDir', $installDirectory, '--log', (Join-Path $PSScriptRoot 'repair.log'),
        'apply', '--package', $packageFile, '--norestart')
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $repairUpdater
    $start.Arguments = ($nativeArguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $repair = [Diagnostics.Process]::Start($start)
    $repair.WaitForExit()
    if ($repair.ExitCode -ne 0) { throw ('原生安装器未完成修复，退出码 ' + $repair.ExitCode + '。请查看本目录的 repair.log，解除文件占用后重试。') }
    $program = Join-Path $currentDirectory 'GrayCode.exe'
    if (-not (Test-Path -LiteralPath $program)) { throw '修复后未找到程序入口，请保留本目录中的回退包。' }
    Write-Host ('程序文件已恢复到 ' + $record.version + '，数据目录保持原样。')
    if (-not $NoLaunch) {
        $launchArguments = (@($record.restartArgs) | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' '
        if ($launchArguments) { Start-Process -FilePath $program -ArgumentList $launchArguments -WorkingDirectory $currentDirectory -WindowStyle Hidden }
        else { Start-Process -FilePath $program -WorkingDirectory $currentDirectory -WindowStyle Hidden }
    }
} catch {
    Write-Error $_
    exit 1
}
