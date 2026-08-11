import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

const { sendToExtension } = vi.hoisted(() => ({ sendToExtension: vi.fn() }))

vi.mock('@/utils/vscode', () => ({
  sendToExtension
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
