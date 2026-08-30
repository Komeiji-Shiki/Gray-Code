import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

const { sendToExtension, onExtensionCommand, commandHandlers } = vi.hoisted(() => {
  // 捕获组件注册的推送命令处理器，便于测试直接触发后端广播
  const commandHandlers = new Map<string, (data: any) => void>()
  return {
    sendToExtension: vi.fn(),
    commandHandlers,
    onExtensionCommand: vi.fn((command: string, handler: (data: any) => void) => {
      commandHandlers.set(command, handler)
      return () => commandHandlers.delete(command)
    })
  }
})

vi.mock('@/utils/vscode', () => ({
  sendToExtension,
  onExtensionCommand
}))

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key })
  }
})

import McpSettings from '../../components/settings/McpSettings.vue'

const originalArgs = [
  '--directory',
  'C:\\Program Files\\MCP server',
  '--label=a b',
  '',
  'a "quoted" value'
]

function serverResponse() {
  return {
    success: true,
    servers: [{
      config: {
        id: 'stdio-test',
        name: 'Stdio Test',
        enabled: true,
        autoConnect: false,
        transport: {
          type: 'stdio',
          command: 'node',
          args: originalArgs
        }
      },
      status: 'disconnected'
    }]
  }
}

describe('McpSettings stdio arguments', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sendToExtension.mockReset()
    sendToExtension.mockImplementation((command: string) => {
      if (command === 'getMcpServers') return Promise.resolve(serverResponse())
      if (command === 'updateMcpServer') return Promise.resolve({ success: true })
      return Promise.resolve({ success: true })
    })
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  test('loads and saves a lossless JSON argument array', async () => {
    wrapper = mount(McpSettings)
    await flushPromises()

    const editButton = wrapper.findAll('.server-card .action-btn')[1]
    expect(editButton).toBeDefined()
    await editButton.trigger('click')

    const argsInput = wrapper.find('[data-search-anchor="mcp-stdio-config"] .form-group:nth-child(2) input')
    expect((argsInput.element as HTMLInputElement).value).toBe(JSON.stringify(originalArgs))

    await wrapper.find('.form-actions .action-button.primary').trigger('click')
    await flushPromises()

    const updateCall = sendToExtension.mock.calls.find(([command]) => command === 'updateMcpServer')
    expect(updateCall).toBeDefined()
    expect(updateCall![1].updates.transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: originalArgs
    })
  })

  test('收到 mcp.configChanged 推送后重拉服务器列表（导入 MCP 配置无需重启插件）', async () => {
    wrapper = mount(McpSettings)
    await flushPromises()

    const handler = commandHandlers.get('mcp.configChanged')
    expect(handler).toBeDefined()
    const loadCountBefore = sendToExtension.mock.calls.filter(([command]) => command === 'getMcpServers').length

    handler!({})
    await flushPromises()

    expect(
      sendToExtension.mock.calls.filter(([command]) => command === 'getMcpServers').length
    ).toBe(loadCountBefore + 1)
  })

  test('卸载后取消订阅（不残留全局推送监听）', async () => {
    wrapper = mount(McpSettings)
    await flushPromises()
    expect(commandHandlers.has('mcp.configChanged')).toBe(true)

    wrapper.unmount()
    wrapper = undefined as unknown as VueWrapper

    expect(commandHandlers.has('mcp.configChanged')).toBe(false)
  })

  test('shows the string-array validation message for invalid argument JSON', async () => {
    wrapper = mount(McpSettings)
    await flushPromises()

    await wrapper.findAll('.server-card .action-btn')[1].trigger('click')
    const argsInput = wrapper.find('[data-search-anchor="mcp-stdio-config"] .form-group:nth-child(2) input')
    await argsInput.setValue('["valid", 123]')
    await wrapper.find('.form-actions .action-button.primary').trigger('click')

    expect(wrapper.find('.form-error').text()).toContain(
      'components.settings.mcpSettings.validation.invalidArgsJsonArray'
    )
    expect(sendToExtension.mock.calls.some(([command]) => command === 'updateMcpServer')).toBe(false)
  })
})
