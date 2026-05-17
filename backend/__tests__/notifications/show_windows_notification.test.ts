import { createShowWindowsNotificationTool, createShowWindowsNotificationToolDeclaration } from '../../tools/notification/show_windows_notification'
import type { WindowsToastAdapter, WindowsToastRequest, WindowsToastShowResult } from '../../modules/notifications/types'

class FakeToastAdapter implements WindowsToastAdapter {
  requests: WindowsToastRequest[] = []
  constructor(private readonly result: WindowsToastShowResult = { shown: true }) {}

  async show(request: WindowsToastRequest): Promise<WindowsToastShowResult> {
    this.requests.push(request)
    return this.result
  }
}

describe('show_windows_notification tool', () => {
  it('declares custom title and message as required parameters', () => {
    const declaration = createShowWindowsNotificationToolDeclaration()

    expect(declaration.name).toBe('show_windows_notification')
    expect(declaration.category).toBe('notification')
    expect(declaration.strict).toBe(true)
    expect(declaration.parameters.required).toEqual(['title', 'message'])
  })

  it('shows a Windows toast with normalized custom content', async () => {
    const adapter = new FakeToastAdapter()
    const executedCommands: string[] = []
    const tool = createShowWindowsNotificationTool(
      adapter,
      'win32',
      async command => {
        executedCommands.push(command)
      }
    )

    const result = await tool.handler({
      title: '  Build done  ',
      message: '  All tests passed  '
    })

    expect(result.success).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      title: 'Build done',
      message: 'All tests passed',
      silent: true,
      waitForAction: true
    })

    await adapter.requests[0].onClick?.()
    expect(executedCommands).toEqual(['limcode.openChat'])
  })

  it('allows disabling click-to-open-chat and sound suppression', async () => {
    const adapter = new FakeToastAdapter()
    const tool = createShowWindowsNotificationTool(adapter, 'win32')

    const result = await tool.handler({
      title: 'Hello',
      message: 'World',
      silent: false,
      openChatOnClick: false
    })

    expect(result.success).toBe(true)
    expect(adapter.requests[0].silent).toBe(false)
    expect(adapter.requests[0].waitForAction).toBe(false)
    expect(adapter.requests[0].onClick).toBeUndefined()
  })

  it('reports unsupported platform without calling the toast adapter', async () => {
    const adapter = new FakeToastAdapter()
    const tool = createShowWindowsNotificationTool(adapter, 'linux')

    const result = await tool.handler({ title: 'Hi', message: 'Message' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('only supported on Windows')
    expect(adapter.requests).toHaveLength(0)
  })

  it('rejects empty messages', async () => {
    const adapter = new FakeToastAdapter()
    const tool = createShowWindowsNotificationTool(adapter, 'win32')

    const result = await tool.handler({ title: 'Hi', message: '   ' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('message must be a non-empty string')
    expect(adapter.requests).toHaveLength(0)
  })
})
