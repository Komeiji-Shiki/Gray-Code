import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStoragePathSettings } from '../../composables/useStoragePathSettings'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/utils/vscode', () => ({ sendToExtension: send }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('存储路径设置', () => {
  beforeEach(() => { vi.useFakeTimers(); send.mockReset() })
  afterEach(() => vi.useRealTimers())

  it('打开当前自定义目录不触发迁移校验，实际更换目录后才校验', async () => {
    send.mockImplementation(async type => type === 'storagePath.getConfig'
      ? { effectivePath: 'A:\\current', defaultPath: 'A:\\default', config: { customDataPath: 'A:\\current' } }
      : { valid: true })
    let api!: ReturnType<typeof useStoragePathSettings>
    const host = mount(defineComponent({ setup() { api = useStoragePathSettings(); return () => null } }))
    try {
      await api.loadStorageConfig(); await nextTick(); await vi.advanceTimersByTimeAsync(600)
      expect(send).toHaveBeenCalledTimes(1)
      expect(api.pathValidationResult.value).toBeNull()
      api.storageSettings.customPath = 'A:\\new'; await nextTick(); await vi.advanceTimersByTimeAsync(600)
      expect(send).toHaveBeenLastCalledWith('storagePath.validate', { path: 'A:\\new' })
      expect(api.pathValidationResult.value?.valid).toBe(true)
    } finally { host.unmount() }
  })

  it('启动参数指定的目录保持只读，并在界面显示重启被拒绝的原因', async () => {
    send.mockImplementation(async type => {
      if (type === 'reloadWindow') throw new Error('请先保存编辑器中的修改。')
      return { effectivePath: 'A:\\explicit', defaultPath: 'A:\\default', externallyConfigured: true, config: { customDataPath: 'A:\\explicit' } }
    })
    let api!: ReturnType<typeof useStoragePathSettings>
    const host = mount(defineComponent({ setup() { api = useStoragePathSettings(); return () => null } }))
    try {
      await api.loadStorageConfig(); await nextTick(); await vi.advanceTimersByTimeAsync(600)
      expect(api.storageSettings.externallyConfigured).toBe(true)
      await api.resetStoragePath(); await api.applyStoragePath()
      expect(send).toHaveBeenCalledTimes(1)
      await api.reloadWindow()
      expect(api.storageMessage.value).toBe('请先保存编辑器中的修改。')
      expect(api.storageMessageType.value).toBe('error')
    } finally { host.unmount() }
  })
})
