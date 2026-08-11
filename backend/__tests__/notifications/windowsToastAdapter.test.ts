/**
 * NodeNotifierWindowsToastAdapter 单元测试
 *
 * 覆盖：Windows 平台经 node-notifier 弹系统 toast（snoretoast）并返回 shown；
 * 非 Windows 平台跳过且不创建 toaster；silent/waitForAction 参数映射；
 * 点击事件触发 onClick；无 onClick 不注册 click 监听；notify 回调/同步抛错返回失败；
 * toaster 实例创建失败返回失败；默认 appID 跟随 VS Code Insiders 变体。
 *
 * 注意：process.platform 是只读属性，jest.replaceProperty 恢复时会赋值导致
 * "Cannot assign to read only property"，这里用 defineProperty 手动接管并在 afterEach 恢复。
 */

import * as vscode from 'vscode'
import { NodeNotifierWindowsToastAdapter } from '../../modules/notifications/WindowsToastAdapter'
import type { WindowsToastRequest } from '../../modules/notifications/types'

jest.mock('vscode', () => ({
  env: {
    appName: 'Visual Studio Code',
    uriScheme: 'vscode'
  },
  extensions: {
    getExtension: jest.fn()
  }
}))

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

interface FakeToaster {
  notify: jest.Mock
  once: jest.Mock
  removeListener: jest.Mock
  listeners: Map<string, Set<(...args: any[]) => void>>
  emit: (eventName: string, ...args: any[]) => void
}

function createFakeToaster(): FakeToaster {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const toaster: FakeToaster = {
    notify: jest.fn(),
    once: jest.fn((eventName: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set())
      listeners.get(eventName)!.add(listener)
    }),
    removeListener: jest.fn((eventName: string, listener: (...args: any[]) => void) => {
      listeners.get(eventName)?.delete(listener)
    }),
    listeners,
    emit(eventName: string, ...args: any[]) {
      for (const listener of Array.from(listeners.get(eventName) ?? [])) {
        listener(...args)
      }
    }
  }
  return toaster
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function makeRequest(overrides: Partial<WindowsToastRequest> = {}): WindowsToastRequest {
  return {
    title: 'Build done',
    message: 'All tests passed',
    silent: true,
    waitForAction: true,
    ...overrides
  }
}

describe('NodeNotifierWindowsToastAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(vscode.env).appName = 'Visual Studio Code'
    jest.mocked(vscode.env).uriScheme = 'vscode'
    jest.mocked(vscode.extensions.getExtension).mockReset()
  })

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR)
    }
  })

  test('非 Windows 平台跳过且不创建 toaster', async () => {
    mockPlatform('linux')
    const createWindowsToaster = jest.fn()
    const adapter = new NodeNotifierWindowsToastAdapter(createWindowsToaster)

    const result = await adapter.show(makeRequest())

    expect(result).toEqual({ shown: false, skippedReason: 'unsupported_platform' })
    expect(createWindowsToaster).not.toHaveBeenCalled()
  })

  test('Windows 平台调用 node-notifier 弹系统 toast 并返回 shown: true', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    const result = await adapter.show(makeRequest())

    expect(result).toEqual({ shown: true })
    expect(toaster.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Build done',
        message: 'All tests passed',
        sound: false,
        wait: true,
        appID: 'Microsoft.VisualStudioCode'
      }),
      expect.any(Function)
    )
  })

  test('silent=false 时 sound 为 true，waitForAction=false 时 wait 为 false', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    await adapter.show(makeRequest({ silent: false, waitForAction: false }))

    expect(toaster.notify).toHaveBeenCalledWith(
      expect.objectContaining({ sound: true, wait: false }),
      expect.any(Function)
    )
  })

  test('注册 click 监听，点击后触发 onClick', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const onClick = jest.fn()
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    await adapter.show(makeRequest({ onClick }))
    expect(toaster.once).toHaveBeenCalledWith('click', expect.any(Function))

    toaster.emit('click')
    await flushMicrotasks()

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test('无 onClick 时不注册 click 监听', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    await adapter.show(makeRequest({ onClick: undefined }))

    const clickCalls = toaster.once.mock.calls.filter(([event]) => event === 'click')
    expect(clickCalls).toHaveLength(0)
  })

  test('notify 回调带 error 时返回 shown: false 与错误信息', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(new Error('toast failed'))
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    const result = await adapter.show(makeRequest())

    expect(result).toEqual({ shown: false, error: 'toast failed' })
  })

  test('notify 同步抛错时返回 shown: false 与错误信息', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation(() => {
      throw new Error('notify unavailable')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    const result = await adapter.show(makeRequest())

    expect(result).toEqual({ shown: false, error: 'notify unavailable' })
  })

  test('toaster 实例创建失败时返回 shown: false', async () => {
    mockPlatform('win32')
    const adapter = new NodeNotifierWindowsToastAdapter(() => {
      throw new Error('require failed')
    })

    const result = await adapter.show(makeRequest())

    expect(result).toEqual({ shown: false, error: 'require failed' })
  })

  test('默认 appID 跟随 VS Code Insiders 变体', async () => {
    mockPlatform('win32')
    jest.mocked(vscode.env).appName = 'Visual Studio Code Insiders'
    jest.mocked(vscode.env).uriScheme = 'vscode-insiders'
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    await adapter.show(makeRequest())

    expect(toaster.notify).toHaveBeenCalledWith(
      expect.objectContaining({ appID: 'Microsoft.VisualStudioCode.Insiders' }),
      expect.any(Function)
    )
  })

  test('默认使用 GrayCode 扩展自身的 icon.png 作为 toast 图标', async () => {
    mockPlatform('win32')
    jest.mocked(vscode.extensions.getExtension).mockReturnValue({
      extensionPath: 'C:\\Users\\gray\\extensions\\komeiji-shiki.graycode-1.5.1'
    } as any)
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(() => toaster)

    await adapter.show(makeRequest())

    expect(toaster.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: 'C:\\Users\\gray\\extensions\\komeiji-shiki.graycode-1.5.1\\resources\\icon.png'
      }),
      expect.any(Function)
    )
  })

  test('显式传入 iconPath 时传给 node-notifier', async () => {
    mockPlatform('win32')
    const toaster = createFakeToaster()
    toaster.notify.mockImplementation((_options, callback) => {
      callback?.(null, 'OK')
    })
    const adapter = new NodeNotifierWindowsToastAdapter(
      () => toaster,
      console,
      5 * 60 * 1000,
      'Microsoft.VisualStudioCode',
      'D:\\gray\\icon.png'
    )

    await adapter.show(makeRequest())

    expect(toaster.notify).toHaveBeenCalledWith(
      expect.objectContaining({ icon: 'D:\\gray\\icon.png' }),
      expect.any(Function)
    )
  })
})
