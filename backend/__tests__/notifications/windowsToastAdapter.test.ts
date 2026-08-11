/**
 * VSCodeNotificationAdapter 单元测试（F-07）
 *
 * 覆盖：调用 VS Code 原生通知 API 并立即返回；选择「Open Chat」后执行 onClick；
 * 不要求打开聊天时不添加操作按钮；通知 API 抛错时返回 shown: false 和错误信息。
 */

import * as vscode from 'vscode'
import { VSCodeNotificationAdapter } from '../../modules/notifications/WindowsToastAdapter'

jest.mock('vscode', () => ({
  window: {
    showInformationMessage: jest.fn()
  }
}))

const showInformationMessage = vscode.window.showInformationMessage as jest.Mock

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('VSCodeNotificationAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('调用 VS Code 原生通知 API 并立即返回 shown: true（不等待用户关闭）', async () => {
    // 挂起的 Promise 模拟「用户尚未关闭通知」
    showInformationMessage.mockReturnValue(new Promise(() => {}))
    const adapter = new VSCodeNotificationAdapter()

    const result = await adapter.show({
      title: 'Build done',
      message: 'All tests passed',
      silent: true,
      waitForAction: true,
      onClick: jest.fn()
    })

    expect(showInformationMessage).toHaveBeenCalledWith(
      'Build done',
      { detail: 'All tests passed', modal: false },
      'Open Chat'
    )
    expect(result).toEqual({ shown: true })
  })

  test('选择 Open Chat 操作按钮后执行 onClick', async () => {
    showInformationMessage.mockResolvedValue('Open Chat')
    const onClick = jest.fn()
    const adapter = new VSCodeNotificationAdapter()

    await adapter.show({
      title: 'T',
      message: 'M',
      silent: true,
      waitForAction: true,
      onClick
    })
    await flushMicrotasks()

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test('没有 onClick 时不添加操作按钮', async () => {
    showInformationMessage.mockResolvedValue(undefined)
    const adapter = new VSCodeNotificationAdapter()

    const result = await adapter.show({
      title: 'T',
      message: 'M',
      silent: false,
      waitForAction: false
    })

    expect(showInformationMessage).toHaveBeenCalledWith('T', { detail: 'M', modal: false })
    expect(result).toEqual({ shown: true })
  })

  test('通知 API 抛错时返回 shown: false 和错误信息', async () => {
    showInformationMessage.mockImplementation(() => {
      throw new Error('notification api unavailable')
    })
    const adapter = new VSCodeNotificationAdapter()

    const result = await adapter.show({
      title: 'T',
      message: 'M',
      silent: true,
      waitForAction: false
    })

    expect(result).toEqual({ shown: false, error: 'notification api unavailable' })
  })
})
