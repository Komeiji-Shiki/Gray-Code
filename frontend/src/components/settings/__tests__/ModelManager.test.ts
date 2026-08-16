/**
 * ModelManager - openDialog 等待 prepare 后再显示模型选择对话框
 *
 * 覆盖：
 * - 点击「获取模型」先 await prepare（父组件用于 flush 未保存的 url/apiKey），完成后才显示对话框
 * - prepare 被拒绝：不显示对话框，并给用户已有通用错误提示（alert）
 * - 未提供 prepare：点击后立即显示对话框（向后兼容）
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, vi, afterEach } from 'vitest'
import ModelManager from '../ModelManager.vue'
import ModelSelectionDialog from '../ModelSelectionDialog.vue'
import { t } from '@/i18n'

function mountManager(props: Record<string, unknown> = {}) {
  return mount(ModelManager, {
    props: {
      configId: 'cfg-1',
      models: [],
      selectedModel: '',
      ...props
    },
    global: {
      stubs: {
        ModelSelectionDialog: true,
        ConfirmDialog: true,
        CustomScrollbar: true
      }
    }
  })
}

describe('ModelManager.openDialog 等待 prepare', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('点击「获取模型」先 await prepare，完成后才显示对话框', async () => {
    let resolvePrepare!: () => void
    const prepare = vi.fn(() => new Promise<void>(res => { resolvePrepare = res }))
    const wrapper = mountManager({ prepare })

    await wrapper.find('.fetch-btn').trigger('click')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(false)

    resolvePrepare()
    await flushPromises()
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(true)
  })

  test('prepare 被拒绝：不显示对话框，并给用户已有通用错误提示', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepare = vi.fn().mockRejectedValue(new Error('save failed'))
    const wrapper = mountManager({ prepare })

    await wrapper.find('.fetch-btn').trigger('click')
    await flushPromises()

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(false)
    expect(alertSpy).toHaveBeenCalledWith(t('components.settings.modelSelectionDialog.error'))
  })

  test('未提供 prepare：点击后立即显示对话框', async () => {
    const wrapper = mountManager()
    await wrapper.find('.fetch-btn').trigger('click')
    expect(wrapper.findComponent(ModelSelectionDialog).props('visible')).toBe(true)
  })
})
