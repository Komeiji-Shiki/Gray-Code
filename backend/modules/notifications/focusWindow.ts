import { execFile } from 'child_process'
import { Logger } from '../../core/logger'

const log = Logger.get('FocusVSCodeWindow')

/**
 * PowerShell 脚本主体：从起始 PID 向上追溯进程树，定位 VSCode 主窗口并置为 Windows 前台。
 * - 优先匹配进程名（Code / VSCodium / codium），找不到时兜底取第一个带主窗口句柄的祖先。
 * - SW_RESTORE(9) 先恢复最小化窗口，再经 FocusWindow 置前。
 * - 置前组合拳：模拟 Alt 键 + AttachThreadInput 绕过 Windows 前台锁（SetForegroundWindow
 *   默认只允许前台进程/刚接收过输入的进程调用），最后 BringWindowToTop 兜底。
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
      [GrayCode.Win32Focus]::FocusWindow($p.MainWindowHandle) | Out-Null
      exit 0
    }
    if ($null -eq $fallback) { $fallback = $p.MainWindowHandle }
  }
  $wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue
  if ($null -eq $wmi -or $wmi.ParentProcessId -le 0) { break }
  $currentId = [int]$wmi.ParentProcessId
}
if ($null -ne $fallback) {
  [GrayCode.Win32Focus]::FocusWindow($fallback) | Out-Null
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
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // 恢复最小化窗口并置为前台。绕 Windows 前台锁：先模拟一次 Alt 键（让系统认为本进程
    // 刚收到用户输入），再把调用线程附加到前台线程输入队列后 SetForegroundWindow，最后
    // BringWindowToTop 兜底（即使激活被拒也尽量把窗口提到 Z 序顶部）。
    public static void FocusWindow(IntPtr hWnd) {
      ShowWindowAsync(hWnd, 9); // SW_RESTORE

      keybd_event(0x12, 0, 0, UIntPtr.Zero); // VK_MENU down
      keybd_event(0x12, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP

      uint fgPid;
      uint fgThread = 0;
      IntPtr fg = GetForegroundWindow();
      if (fg != IntPtr.Zero) {
        fgThread = GetWindowThreadProcessId(fg, out fgPid);
      }
      uint targetPid;
      uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
      if (fgThread != 0 && targetThread != 0 && fgThread != targetThread) {
        AttachThreadInput(fgThread, targetThread, true);
        SetForegroundWindow(hWnd);
        AttachThreadInput(fgThread, targetThread, false);
      } else {
        SetForegroundWindow(hWnd);
      }
      BringWindowToTop(hWnd);
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
    `try { Add-Type -TypeDefinition $sig -ErrorAction Stop } catch { }\n` +
    FOCUS_WINDOW_SCRIPT
  const encoded = Buffer.from(fullScript, 'utf16le').toString('base64')

  return new Promise<boolean>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 5000 },
      (error) => {
        if (error) {
          log.warn('focus_window_failed', { error: String(error) })
          resolve(false)
          return
        }
        resolve(true)
      }
    )
  })
}
