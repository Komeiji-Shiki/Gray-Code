import { MESSAGE_NAMES } from '../../../shared/protocol'
import {
  scheduleWebviewMessage,
  shouldBypassWebviewMessageQueue
} from '../../../webview/messageHandlingQueue'

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

describe('主 Webview 消息调度', () => {
  test('只有 webviewReady 绕过串行队列', () => {
    expect(shouldBypassWebviewMessageQueue({ type: MESSAGE_NAMES.webviewReady })).toBe(true)
    expect(shouldBypassWebviewMessageQueue({ type: MESSAGE_NAMES['config.listConfigs'] })).toBe(false)
    expect(shouldBypassWebviewMessageQueue(null)).toBe(false)
    expect(shouldBypassWebviewMessageQueue([])).toBe(false)
  })

  test('前置 BackendHost 请求挂起时 webviewReady 仍立即处理，后续普通消息继续排队', async () => {
    let releaseBackendRequest!: () => void
    const backendRequestGate = new Promise<void>(resolve => {
      releaseBackendRequest = resolve
    })
    const events: string[] = []
    const errors: unknown[] = []

    const handleMessage = async (message: { type: string }) => {
      if (message.type === MESSAGE_NAMES['config.listConfigs']) {
        events.push('config:start')
        await backendRequestGate
        events.push('config:end')
        return
      }
      events.push(message.type)
    }

    let queue = Promise.resolve()
    queue = scheduleWebviewMessage(
      queue,
      { type: MESSAGE_NAMES['config.listConfigs'] },
      handleMessage,
      error => errors.push(error)
    )
    await flushMicrotasks()
    expect(events).toEqual(['config:start'])

    queue = scheduleWebviewMessage(
      queue,
      { type: MESSAGE_NAMES.webviewReady },
      handleMessage,
      error => errors.push(error)
    )
    queue = scheduleWebviewMessage(
      queue,
      { type: MESSAGE_NAMES.getSettings },
      handleMessage,
      error => errors.push(error)
    )
    await flushMicrotasks()

    // ready 不等待 config；普通 getSettings 仍保持原有串行语义。
    expect(events).toEqual(['config:start', MESSAGE_NAMES.webviewReady])

    releaseBackendRequest()
    await queue

    expect(events).toEqual([
      'config:start',
      MESSAGE_NAMES.webviewReady,
      'config:end',
      MESSAGE_NAMES.getSettings
    ])
    expect(errors).toEqual([])
  })
})
