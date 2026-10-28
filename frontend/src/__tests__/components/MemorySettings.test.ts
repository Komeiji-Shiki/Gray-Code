import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, test, vi } from 'vitest'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/utils/vscode', () => ({ sendToExtension: send }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: { path?: string }) => params?.path ? `${key}:${params.path}` : key }) }))

import MemorySettings from '../../components/settings/MemorySettings.vue'

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); send.mockReset() })

test('记忆设置显示宿主给出的记忆目录，不再自行拼接路径分隔符', async () => {
  send.mockImplementation(async (type: string) => type === 'getSettings'
    ? { settings: { toolsConfig: { memory: { enabled: true } } } }
    : { effectivePath: 'A:\\pending-restart', memoryDirectory: 'A:\\current\\memory' })
  const wrapper = mount(MemorySettings)
  wrappers.push(wrapper)
  await flushPromises()
  expect(send).toHaveBeenCalledWith('storagePath.getConfig', {})
  expect(wrapper.find('.memory-location').text()).toContain('A:\\current\\memory')
  expect(wrapper.text()).not.toContain('pending-restart')
})
