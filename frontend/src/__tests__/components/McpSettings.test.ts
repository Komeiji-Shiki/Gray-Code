import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

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
    setActivePinia(createPinia())
    sendToExtension.mockReset()
    sendToExtension.mockImplementation((command: string) => {
      if (command === 'getMcpServers') return Promise.resolve(serverResponse())
      if (command === 'updateMcpServer') return Promise.resolve({ success: true })
      return Promise.resolve({ success: true })
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    setActivePinia(undefined)
  })

  test('读取失败显示原因并可重试，不显示虚假的空列表', async () => {
    let attempt = 0
    sendToExtension.mockImplementation((command: string) => command === 'getMcpServers'
      ? ++attempt === 1 ? Promise.resolve({ success: false, error: { message: '读取服务暂时中断' } }) : Promise.resolve(serverResponse())
      : Promise.resolve({ success: true }))
    wrapper = mount(McpSettings); await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('读取服务暂时中断')
    expect(wrapper.find('.empty-state').exists()).toBe(false)
    await wrapper.get('.load-error button').trigger('click'); await flushPromises()
    expect(wrapper.find('.load-error').exists()).toBe(false)
    expect(wrapper.get('.server-name').text()).toBe('Stdio Test')
  })

  test('配置通知触发的新列表不被迟到的旧查询覆盖', async () => {
    let release!: (value: ReturnType<typeof serverResponse>) => void
    let attempt = 0
    sendToExtension.mockImplementation((command: string) => command === 'getMcpServers'
      ? ++attempt === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve(serverResponse())
      : Promise.resolve({ success: true }))
    wrapper = mount(McpSettings); await flushPromises()
    commandHandlers.get('mcp.configChanged')!({}); await flushPromises()
    release({ success: true, servers: [] }); await flushPromises()
    expect(wrapper.get('.server-name').text()).toBe('Stdio Test')
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

  test('超时输入不再静默替换，修正后保存用户实际填写的毫秒数', async () => {
    wrapper = mount(McpSettings)
    await flushPromises()
    await wrapper.findAll('.server-card .action-btn')[1].trigger('click')
    const input = wrapper.find<HTMLInputElement>('input[type="number"]')
    const save = wrapper.find('.form-actions .action-button.primary')
    for (const value of ['', '0', '1000.5', '300001']) {
      await input.setValue(value)
      await save.trigger('click')
      await flushPromises()
      expect(wrapper.find('.form-error').text()).toContain('components.settings.mcpSettings.validation.timeoutInvalid')
      expect(sendToExtension.mock.calls.some(([command]) => command === 'updateMcpServer')).toBe(false)
      expect(input.element.value).toBe(value)
    }
    await input.setValue('120000')
    await save.trigger('click')
    await flushPromises()
    expect(sendToExtension.mock.calls.find(([command]) => command === 'updateMcpServer')?.[1].updates.timeout).toBe(120000)
  })
})
