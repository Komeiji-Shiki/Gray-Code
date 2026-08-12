import { execFile } from 'child_process'
import { Logger } from '../../core/logger'

const log = Logger.get('FocusVSCodeWindow')

/**
 * PowerShell 脚本主体：从起始 PID 向上追溯进程树，定位 VSCode 主窗口并置为 Windows 前台。
 * - 优先匹配进程名（Code / VSCodium / codium），找不到时兜底取第一个带主窗口句柄的祖先。
 * - SW_RESTORE(9) 先恢复最小化窗口，再经 FocusWindow 置前。
 * - 置前策略见 WINDOWS_FOCUS_TYPE：先直接 SetForegroundWindow，被前台锁拒绝时用
 *   "最小化→恢复"（系统视为任务栏恢复，属于合法激活路径）绕过，最后 SetWindowPos
 *   TOPMOST 兜底保证 Z 序置顶。FocusWindow 返回是否成功取得前台，失败时脚本 exit 1。
 * - 向上追溯上限 32 层，避免异常进程树导致死循环。
 */
const FOCUS_WINDOW_SCRIPT = `
$currentId = $StartPid
$fallback = $null
for ($i = 0; $i -lt 32; $i++) {
  $p = Get-Process -Id $currentId -ErrorAction SilentlyContinue
  if ($null -eq $p) { break }
  if ($p.MainWindowHandle -ne 0) {
    if ($p.ProcessName -match 'Code|VSCodium|codium') {
      $focused = [GrayCode.Win32Focus]::FocusWindow($p.MainWindowHandle)
      if (-not $focused) { exit 1 }
      exit 0
    }
    if ($null -eq $fallback) { $fallback = $p.MainWindowHandle }
  }
  $wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue
  if ($null -eq $wmi -or $wmi.ParentProcessId -le 0) { break }
  $currentId = [int]$wmi.ParentProcessId
}
if ($null -ne $fallback) {
  $focused = [GrayCode.Win32Focus]::FocusWindow($fallback)
  if (-not $focused) { exit 1 }
  exit 0
}
exit 1
`

const WINDOWS_FOCUS_TYPE = `
using System;
using System.Runtime.InteropServices;
namespace GrayCode {
  public static class Win32Focus {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    // 把窗口恢复并置为前台。Windows 前台锁在 Win10/11 24H2+ 已收紧：AttachThreadInput、
    // 模拟 Alt 键（keybd_event）等传统 hack 均被拒绝（实测 SetForegroundWindow 返回 false）。
    // 系统唯一放行的"外部进程激活"路径是用户操作触发的激活（如任务栏恢复窗口）：
    // 先最小化再恢复即被系统视为一次合法的恢复激活，随后 SetForegroundWindow 会被允许。
    // 策略：已最小化 → 直接恢复并激活；未最小化 → 先直接激活（无闪烁），被拒后
    // 最小化→恢复→激活（会闪一下，但保证生效）；最后 SetWindowPos TOPMOST 置顶后
    // 立即恢复 NOTOPMOST，即使激活仍被拒也能保证窗口 Z 序跳到最前。
    public static bool FocusWindow(IntPtr hWnd) {
      if (IsIconic(hWnd)) {
        ShowWindowAsync(hWnd, 9); // SW_RESTORE
        bool ok = SetForegroundWindow(hWnd);
        BringWindowToTop(hWnd);
        SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_TOPMOST | SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
        SetWindowPos(hWnd, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_NOTOPMOST
        return ok;
      }

      bool focused = SetForegroundWindow(hWnd);
      if (!focused) {
        ShowWindowAsync(hWnd, 6); // SW_MINIMIZE
        ShowWindowAsync(hWnd, 9); // SW_RESTORE
        focused = SetForegroundWindow(hWnd);
      }
      BringWindowToTop(hWnd);
      SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_TOPMOST
      SetWindowPos(hWnd, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_NOTOPMOST
      return focused;
    }
  }
}
`

export type FocusWindowFunction = (startPid?: number) => Promise<boolean>

/**
 * 把 VSCode 主窗口带到 Windows 前台（恢复最小化并置前）。
 *
 * 扩展宿主进程的父进程链上能追溯到主进程（Code.exe）的主窗口句柄；脚本从 process.ppid
 * 向上追溯定位。脚本以 UTF-16LE base64 经 -EncodedCommand 传给 powershell.exe，避免引号转义。
 * 非 Windows / 无法定位 / 调用失败时返回 false 且不抛错（点击打开聊天的核心行为不受影响）。
 */
export function focusVSCodeWindow(startPid?: number): Promise<boolean> {
  const pid = startPid ?? process.ppid
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return Promise.resolve(false)
  }

  const fullScript =
    `$StartPid = ${pid}\n` +
    `$sig = @'\n${WINDOWS_FOCUS_TYPE}\n'@\n` +
    `try { Add-Type -TypeDefinition $sig -ErrorAction Stop } catch { Write-Error $_.Exception.Message; exit 1 }\n` +
    FOCUS_WINDOW_SCRIPT
  const encoded = Buffer.from(fullScript, 'utf16le').toString('base64')

  return new Promise<boolean>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          log.warn('focus_window_failed', {
            error: String(error),
            stdout: String(stdout).trim(),
            stderr: String(stderr).trim()
          })
          resolve(false)
          return
        }
        log.debug('focus_window_ok', { stdout: String(stdout).trim() })
        resolve(true)
      }
    )
  })
}
