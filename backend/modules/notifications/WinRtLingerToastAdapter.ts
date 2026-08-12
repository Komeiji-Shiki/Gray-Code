import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import type { WindowsToastAdapter, WindowsToastRequest, WindowsToastShowResult } from './types'
import { Logger } from '../../core/logger'
import { getProductExtensionId } from '../../core/productMetadata'

const log = Logger.get('WinRtLingerToastAdapter')

const DEFAULT_AUMID = 'GrayCode.Notification'
const DEFAULT_LINGER_MS = 30000
const MAX_TITLE_LENGTH = 120
const MAX_MESSAGE_LENGTH = 1000

/** 解析扩展自带 toast-linger.exe（resources/bin/）的绝对路径 */
function resolveToastLingerPath(): string | undefined {
  try {
    const extension = vscode.extensions?.getExtension?.(getProductExtensionId())
    if (extension?.extensionPath) {
      const candidate = path.join(extension.extensionPath, 'resources', 'bin', 'toast-linger.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    // 测试/非 VS Code 环境拿不到扩展路径时返回 undefined，不阻塞通知
  }
  return undefined
}

function normalizeText(value: string, maxLength: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * WinRT 驻留式 toast 适配器。
 *
 * 背景：Windows 11 24H2/25H2 收紧 toast 激活——shortcut 激活与 COM 激活器
 * （ToastNotificationActivation）均不再投递，只有「发送进程驻留 + 进程内
 * Activated 事件」仍可靠（node-notifier/SnoreToast 发完即退，点击无回调）。
 *
 * 实现：spawn 扩展自带的 toast-linger.exe（12KB，.NET Framework 4.x 编译，
 * 系统自带运行时），由它发 WinRT toast 并驻留 lingerMs 毫秒。用户点击 toast
 * 时进程内 Activated 触发：exe 聚焦 VSCode 窗口并写标记文件
 * （%TEMP%\graycode-toast-clicked.flag），扩展侧轮询该文件后执行
 * graycode.openChat（见 extension.ts）。同时 exe 启动时自注册 AUMID
 * shortcut（发 toast 的前提）。
 *
 * 注意：onClick/waitForAction 在本适配器中被忽略（点击处理由 exe + 扩展轮询
 * 完成），接口保留以兼容现有调用方与测试。
 */
export class WinRtLingerToastAdapter implements WindowsToastAdapter {
  constructor(
    private readonly exePath: string | undefined = resolveToastLingerPath(),
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly lingerMs: number = DEFAULT_LINGER_MS,
    private readonly aumid: string = DEFAULT_AUMID
  ) {}

  async show(request: WindowsToastRequest): Promise<WindowsToastShowResult> {
    if (this.platform !== 'win32') {
      log.debug('skip_show_not_win32', { platform: this.platform })
      return {
        shown: false,
        skippedReason: 'unsupported_platform'
      }
    }

    if (!this.exePath || !fs.existsSync(this.exePath)) {
      log.error('toast_linger_missing', { exePath: this.exePath })
      return {
        shown: false,
        error: 'toast-linger.exe not found in extension resources'
      }
    }

    const title = normalizeText(request.title || 'GrayCode', MAX_TITLE_LENGTH)
    const message = normalizeText(request.message || '', MAX_MESSAGE_LENGTH)
    const silent = request.silent !== false

    try {
      const child = spawn(
        this.exePath,
        [this.aumid, title, message, String(this.lingerMs), String(silent)],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }
      )
      child.on('error', (error) => {
        log.error('toast_linger_spawn_failed', { error: String(error) })
      })
      // 驻留进程独立于扩展宿主生命周期，不阻塞扩展退出
      child.unref()
    } catch (error) {
      log.error('toast_linger_spawn_threw', { error: String(error) })
      return {
        shown: false,
        error: error instanceof Error ? error.message : 'Failed to spawn toast-linger.exe'
      }
    }

    log.debug('toast_linger_spawned', {
      title,
      lingerMs: this.lingerMs,
      aumid: this.aumid
    })
    return { shown: true }
  }
}
