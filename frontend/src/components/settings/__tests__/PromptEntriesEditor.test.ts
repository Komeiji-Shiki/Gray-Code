/**
 * PromptEntriesEditor 条目名称草稿模式测试
 *
 * 覆盖：
 * - 清空条目名称后保持为空（编辑期间不再自动回填「Prompt N」）
 * - 新建条目名称输入框为空（不自动补全）
 * - 离开设置页时，空名称自动回填并随数据提交
 */
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import PromptEntriesEditor from '../PromptEntriesEditor.vue'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ComponentPublicInstance } from 'vue'

interface PromptEntry {
  id: string
  name: string
  type?: 'prompt' | 'chat_history'
  enabled: boolean
  role: 'system' | 'user' | 'assistant'
  content: string
  fakeThought?: string
  order: number
}

function makeEntries(): PromptEntry[] {
  return [
    { id: 'entry-1', name: '我的工具', type: 'prompt', enabled: true, role: 'system', content: 'c1', order: 0 },
    { id: 'chat-history', name: 'Chat History', type: 'chat_history', enabled: true, role: 'user', content: '', order: 1 }
  ]
}

let wrapper: VueWrapper<ComponentPublicInstance>

async function mountEditor(entries: PromptEntry[] = makeEntries()) {
  wrapper = mount(PromptEntriesEditor, {
    props: {
      modelValue: entries,
      staticModules: [],
      dynamicModules: []
    }
  })
  await flushPromises()
  return wrapper
}

function emittedEntries(): PromptEntry[] {
  const calls = wrapper.emitted('update:modelValue')
  if (!calls || calls.length === 0) return []
  return calls[calls.length - 1][0] as PromptEntry[]
}

describe('PromptEntriesEditor 条目名称草稿', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  it('清空条目名称后保持为空，不再自动回填「Prompt N」', async () => {
    const w = await mountEditor()
    const nameInput = w.find('.entry-name-input')
    expect((nameInput.element as HTMLInputElement).value).toBe('我的工具')

    await nameInput.setValue('')
    await flushPromises()

    expect((nameInput.element as HTMLInputElement).value).toBe('')
  })

  it('新建条目：名称输入框为空（不自动补全）', async () => {
    const w = await mountEditor()
    await w.findAll('button').find(b => b.text().includes('新增条目'))!.trigger('click')
    await flushPromises()

    // 受控组件：回传 update:modelValue 以便新条目渲染
    const next = emittedEntries()
    await w.setProps({ modelValue: next, staticModules: [], dynamicModules: [] })
    await flushPromises()

    const nameInputs = w.findAll('.entry-name-input')
    expect(nameInputs).toHaveLength(3)
    const lastInput = nameInputs[nameInputs.length - 1].element as HTMLInputElement
    expect(lastInput.value).toBe('')
  })

  it('离开设置页时，被清空的自定义名称回填「最后一次提交的名称」而非 Prompt N', async () => {
    const w = await mountEditor()
    const settingsStore = useSettingsStore()
    settingsStore.showSettings()

    const nameInput = w.find('.entry-name-input')
    await nameInput.setValue('')
    await flushPromises()

    settingsStore.showChat()
    await flushPromises()

    // 回填的是上次提交的自定义名称（不覆盖用户命名）；
    // 回填值 = entry.name（已是「我的工具」），无需额外 emit（modelValue 不变）
    expect((w.find('.entry-name-input').element as HTMLInputElement).value).toBe('我的工具')
    const emitted = w.emitted('update:modelValue')
    expect(emitted ?? []).toHaveLength(0)
  })

  it('离开设置页时，新建条目空名称回填「Prompt N」', async () => {
    const w = await mountEditor()
    const settingsStore = useSettingsStore()
    settingsStore.showSettings()

    await w.findAll('button').find(b => b.text().includes('新增条目'))!.trigger('click')
    await flushPromises()
    const next = emittedEntries()
    await w.setProps({ modelValue: next, staticModules: [], dynamicModules: [] })
    await flushPromises()

    settingsStore.showChat()
    await flushPromises()

    const nameInputs = w.findAll('.entry-name-input')
    const lastInput = nameInputs[nameInputs.length - 1].element as HTMLInputElement
    // 新建条目从未提交过自定义名 → 回填按位置生成的 Prompt N（第 3 条 → Prompt 3）
    expect(lastInput.value).toBe('Prompt 3')
    const entries = emittedEntries()
    expect(entries.find(e => e.name === 'Prompt 3')?.name).toBe('Prompt 3')
  })

  it('离开设置页时，非空名称保持用户输入', async () => {
    const w = await mountEditor()
    const settingsStore = useSettingsStore()
    settingsStore.showSettings()

    const nameInput = w.find('.entry-name-input')
    await nameInput.setValue('我的自定义名')
    await flushPromises()

    settingsStore.showHistory()
    await flushPromises()

    expect((w.find('.entry-name-input').element as HTMLInputElement).value).toBe('我的自定义名')
  })
})
