/**
 * useDeferredNumberInput - 「清空后延迟回填」草稿模式测试
 *
 * 覆盖：
 * - 初始化草稿 = 已保存值（未保存过为空）
 * - 输入有效数字立即提交；清空/无效值不提交且不回退
 * - 校验器（isValid）拦截越界值
 * - 仍在设置页时清空保持为空；离开设置页时自动回填已保存值
 * - 外部 loadConfig 后 syncFromStored 重新对齐草稿
 * - 无 Pinia 环境（组件单测）不抛错：由不安装 Pinia 的组件测试
 *   （BranchCleanupSettings / ChannelSettings / PromptSettings 等）间接覆盖
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useDeferredNumberInput, getSettingsView } from '../../composables/useDeferredNumberInput'
import { useSettingsStore } from '../../stores/settingsStore'

describe('useDeferredNumberInput', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初始化草稿为已保存值', () => {
    const { draft } = useDeferredNumberInput(() => 30)
    expect(draft.value).toBe('30')
  })

  it('未保存过时草稿为空（显示占位符）', () => {
    const { draft } = useDeferredNumberInput(() => undefined)
    expect(draft.value).toBe('')
  })

  it('输入有效数字立即提交，草稿跟随原始输入', () => {
    const commit = vi.fn()
    const { draft, handleInput } = useDeferredNumberInput(() => 30)
    const committed = handleInput('50', commit)
    expect(committed).toBe(50)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(50)
    expect(draft.value).toBe('50')
  })

  it('清空输入：不提交、不回填默认值（编辑期间保持为空）', () => {
    const commit = vi.fn()
    const { draft, handleInput } = useDeferredNumberInput(() => 30)
    const committed = handleInput('', commit)
    expect(committed).toBeNull()
    expect(commit).not.toHaveBeenCalled()
    expect(draft.value).toBe('')
  })

  it('校验器拦截非法值（如 0 对「-1 或 ≥1」无效），合法值正常提交', () => {
    const commit = vi.fn()
    const { handleInput } = useDeferredNumberInput(() => 30, v => v === -1 || v >= 1)
    expect(handleInput('0', commit)).toBeNull()
    expect(commit).not.toHaveBeenCalled()
    expect(handleInput('-1', commit)).toBe(-1)
    expect(commit).toHaveBeenCalledWith(-1)
    expect(handleInput('5', commit)).toBe(5)
    expect(commit).toHaveBeenLastCalledWith(5)
  })

  it('非有限值（如 1e999）不提交', () => {
    const commit = vi.fn()
    const { handleInput } = useDeferredNumberInput(() => 30)
    expect(handleInput('1e999', commit)).toBeNull()
    expect(commit).not.toHaveBeenCalled()
  })

  it('小数中间值（如 2. / .5 / 1e3）不提交，完整小数正常提交', () => {
    const commit = vi.fn()
    const { draft, handleInput } = useDeferredNumberInput(() => 30)
    // Number('2.') === 2：若不拦截会在输入过程中提交中间值
    expect(handleInput('2.', commit)).toBeNull()
    expect(commit).not.toHaveBeenCalled()
    expect(draft.value).toBe('2.')
    // Number('.5') === 0.5：同样拦截
    expect(handleInput('.5', commit)).toBeNull()
    expect(commit).not.toHaveBeenCalled()
    // 科学计数法中间态也不提交
    expect(handleInput('1e3', commit)).toBeNull()
    expect(commit).not.toHaveBeenCalled()
    // 完整小数正常提交
    expect(handleInput('2.5', commit)).toBe(2.5)
    expect(commit).toHaveBeenCalledWith(2.5)
  })

  it('在设置页时切换到其他视图：空输入框自动回填已保存值', async () => {
    const settingsStore = useSettingsStore()
    settingsStore.showSettings()

    const { draft, handleInput } = useDeferredNumberInput(() => 30)
    handleInput('', vi.fn())
    expect(draft.value).toBe('')

    // 仍在设置页：切换页签/保持视图不触发回填（currentView 未变）
    await nextTick()
    expect(draft.value).toBe('')

    // 离开设置页（回到聊天）：空输入框自动回填
    settingsStore.showChat()
    await nextTick()
    expect(draft.value).toBe('30')
  })

  it('离开设置页时有效草稿不回填（保留用户输入）', async () => {
    const settingsStore = useSettingsStore()
    settingsStore.showSettings()

    const { draft, handleInput } = useDeferredNumberInput(() => 30)
    handleInput('50', vi.fn())

    settingsStore.showHistory()
    await nextTick()
    expect(draft.value).toBe('50')
  })

  it('syncFromStored 重新对齐草稿（loadConfig 完成后调用）', () => {
    const stored = { value: 5 }
    const { draft, syncFromStored } = useDeferredNumberInput(() => stored.value)
    draft.value = ''
    stored.value = 7
    syncFromStored()
    expect(draft.value).toBe('7')
  })

  it('getSettingsView 返回当前视图', () => {
    const settingsStore = useSettingsStore()
    settingsStore.showSettings()
    expect(getSettingsView()).toBe('settings')
    settingsStore.showChat()
    expect(getSettingsView()).toBe('chat')
  })
})
