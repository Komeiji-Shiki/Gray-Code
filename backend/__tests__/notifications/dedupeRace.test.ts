/**
 * WindowsAgentStopNotificationService 去重竞态测试
 *
 * 覆盖：
 * - 并发相同 dedupeKey 的 notify 只弹一次 toast（先记录去重键再弹窗）
 * - 弹窗完成后的后续 notify 仍被去重拦截
 * - TTL 过期后去重键被清理，可再次弹窗
 */
import { WindowsAgentStopNotificationService } from '../../modules/notifications/WindowsAgentStopNotificationService'
import type {
  AgentStopNotificationPayload,
  WindowsToastAdapter,
  WindowsToastRequest,
  WindowsToastShowResult
} from '../../modules/notifications/types'

/** 受控适配器：show() 挂起直到显式放行，用于制造并发窗口 */
class ControlledToastAdapter implements WindowsToastAdapter {
  requests: WindowsToastRequest[] = []
  private resolvers: Array<() => void> = []
  private readonly result: WindowsToastShowResult

  constructor(result: WindowsToastShowResult = { shown: true }) {
    this.result = result
  }

  async show(request: WindowsToastRequest): Promise<WindowsToastShowResult> {
    this.requests.push(request)
    await new Promise<void>(resolve => this.resolvers.push(resolve))
    return this.result
  }

  releaseAll(): void {
    for (const resolve of this.resolvers.splice(0)) {
      resolve()
    }
  }
}

const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function makePayload(overrides: Partial<AgentStopNotificationPayload> = {}): AgentStopNotificationPayload {
  return {
    reason: 'error',
    dedupeKey: 'key-1',
    createdAt: Date.now(),
    ...overrides
  }
}

function makeService(adapter: WindowsToastAdapter, dedupeTtlMs = 5000): WindowsAgentStopNotificationService {
  return new WindowsAgentStopNotificationService({
    settingsManager: {
      getSettings: () => ({
        ui: {
          sound: {
            windowsAgentStopNotification: { enabled: true }
          }
        }
      })
    } as any,
    adapter,
    platform: 'win32',
    getWindowState: () => ({ focused: false }),
    onDidChangeWindowState: () => ({ dispose: () => {} }),
    executeCommand: async () => {},
    logger: { warn: () => {}, error: () => {} },
    dedupeTtlMs
  })
}

describe('WindowsAgentStopNotificationService dedupe race', () => {
  test('并发相同 dedupeKey 的 notify 只弹一次 toast', async () => {
    const adapter = new ControlledToastAdapter()
    const service = makeService(adapter)

    // 第一个 notify 进入 showToast 等待窗口（此时去重键已记录）
    const p1 = service.notify(makePayload())
    await flushMicrotasks()
    expect(adapter.requests).toHaveLength(1)

    // 第二个并发 notify：命中去重，直接跳过，不再弹窗
    const p2 = service.notify(makePayload())
    await flushMicrotasks()
    expect(adapter.requests).toHaveLength(1)

    // 放行第一个 toast
    adapter.releaseAll()
    const r1 = await p1
    const r2 = await p2

    expect(r1.shown).toBe(true)
    expect(r2.skipped).toBe(true)
    expect(r2.reason).toBe('duplicate')

    service.dispose()
  })

  test('弹窗完成后的相同 dedupeKey 仍被去重拦截', async () => {
    const adapter = new ControlledToastAdapter()
    const service = makeService(adapter)

    const p1 = service.notify(makePayload())
    await flushMicrotasks()
    adapter.releaseAll()
    const r1 = await p1
    expect(r1.shown).toBe(true)

    const r2 = await service.notify(makePayload())
    expect(r2.skipped).toBe(true)
    expect(r2.reason).toBe('duplicate')

    service.dispose()
  })

  test('TTL 过期后去重键被清理，可再次弹窗', async () => {
    const adapter = new ControlledToastAdapter()
    // TTL 1ms：下一次 notify 时过期清理生效
    const service = makeService(adapter, 1)

    const p1 = service.notify(makePayload({ dedupeKey: 'expired-key' }))
    await flushMicrotasks()
    adapter.releaseAll()
    const r1 = await p1
    expect(r1.shown).toBe(true)

    // 等待 TTL 过期
    await new Promise<void>(resolve => setTimeout(resolve, 20))

    const p2 = service.notify(makePayload({ dedupeKey: 'expired-key' }))
    await flushMicrotasks()
    adapter.releaseAll()
    const r2 = await p2
    expect(r2.shown).toBe(true)

    service.dispose()
  })
})
