import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, ref } from 'vue'
import ConversationTabs from '../../components/tabs/ConversationTabs.vue'
import ToolItem from '../../components/message/toolMessage/ToolItem.vue'
import SettingsSearchBox from '../../components/settings/panel/SettingsSearchBox.vue'
import ChannelSelector from '../../components/input/ChannelSelector.vue'
import ModelSelector from '../../components/input/ModelSelector.vue'
import ModeSelector from '../../components/input/ModeSelector.vue'
import { createContextChipElement } from '../../components/input/inputBox/ContextChipFactory'
import type { ToolUsage } from '../../types'

const wrappers: Array<{ unmount: () => void }> = []
function remember<T extends { unmount: () => void }>(wrapper: T): T {
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

beforeEach(() => {
  setActivePinia(createPinia())
})

const CustomScrollbarStub = defineComponent({
  name: 'CustomScrollbar',
  setup(_props, { expose }) {
    const root = ref<HTMLElement>()
    expose({
      getContainer: () => root.value,
      update: vi.fn()
    })
    return { root }
  },
  template: '<div ref="root"><slot /></div>'
})

describe('core accessibility semantics', () => {
  test('conversation tabs use a tablist, roving tabindex and arrow-key activation', async () => {
    const wrapper = remember(mount(ConversationTabs, {
      attachTo: document.body,
      props: {
        tabs: [
          { id: 'a', title: 'Alpha', conversationId: 'ca', isStreaming: false },
          { id: 'b', title: 'Beta', conversationId: 'cb', isStreaming: false }
        ],
        activeTabId: 'a'
      },
      global: { stubs: { CustomScrollbar: CustomScrollbarStub } }
    }))

    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('对话标签页')
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs[0].attributes('tabindex')).toBe('0')
    expect(tabs[1].attributes('tabindex')).toBe('-1')

    await tabs[0].trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(wrapper.emitted('switchTab')?.[0]).toEqual(['b'])
    expect(document.activeElement).toBe(tabs[1].element)
  })

  test('expandable tool summary is a named native button with status and controlled content', async () => {
    const ContentHost = defineComponent({ template: '<div>Tool content</div>' })
    const tool: ToolUsage = {
      id: 'tool-1',
      name: 'sample_tool',
      args: {},
      status: 'executing'
    }
    const wrapper = remember(mount(ToolItem, {
      props: {
        tool,
        isExpanded: false,
        isExpandable: true,
        showContent: false,
        isProcessing: false,
        showStreamingPreview: false,
        streamingPreviewText: '',
        pendingDiffs: [],
        diffGuardWarning: null,
        contentHost: ContentHost,
        registerStreamingPreviewRef: () => {}
      }
    }))

    const summary = wrapper.get('button.tool-summary')
    expect(summary.attributes('aria-expanded')).toBe('false')
    expect(summary.attributes('aria-controls')).toBeTruthy()
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('执行中')
    await summary.trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  test('settings search exposes active result through combobox/listbox semantics', () => {
    const wrapper = remember(mount(SettingsSearchBox, {
      props: {
        query: 'set',
        focused: true,
        activeIndex: 0,
        searchActive: true,
        results: [{
          key: 'general',
          tab: 'general',
          labelKey: 'common.settings',
          keywords: ['settings']
        }],
        tabIcon: () => 'codicon-settings'
      }
    }))

    const input = wrapper.get('[role="combobox"]')
    const listbox = wrapper.get('[role="listbox"]')
    const option = wrapper.get('[role="option"]')
    expect(input.attributes('aria-controls')).toBe(listbox.attributes('id'))
    expect(input.attributes('aria-activedescendant')).toBe(option.attributes('id'))
    expect(option.attributes('aria-selected')).toBe('true')
  })

  test('channel/model/mode selectors share combobox semantics and restore focus after selection', async () => {
    const cases = [
      {
        component: ChannelSelector,
        props: {
          modelValue: 'channel-a',
          options: [{ id: 'channel-a', name: 'Channel A', model: 'model-a', type: 'openai' }]
        },
        itemSelector: '.channel-item'
      },
      {
        component: ModelSelector,
        props: {
          modelValue: 'model-a',
          models: [{ id: 'model-a', name: 'Model A' }]
        },
        itemSelector: '.model-item'
      },
      {
        component: ModeSelector,
        props: {
          modelValue: 'mode-a',
          options: [{ id: 'mode-a', name: 'Mode A', icon: 'code' }]
        },
        itemSelector: '.mode-item'
      }
    ] as const

    for (const entry of cases) {
      const wrapper = remember(mount(entry.component as any, {
        attachTo: document.body,
        props: entry.props as any,
        global: { stubs: { CustomScrollbar: CustomScrollbarStub } }
      }))
      const trigger = wrapper.get('button[role="combobox"]')
      await trigger.trigger('click')
      expect(wrapper.get('[role="listbox"]').attributes('role')).toBe('listbox')
      expect(wrapper.get('[role="option"]').attributes('aria-selected')).toBe('true')
      await wrapper.get(entry.itemSelector).trigger('click')
      await Promise.resolve()
      expect(document.activeElement).toBe(trigger.element)
      wrapper.unmount()
      wrappers.splice(wrappers.indexOf(wrapper), 1)
    }
  })

  test('context chips expose separate keyboard actions for opening and removal', () => {
    const open = vi.fn()
    const remove = vi.fn()
    const chip = createContextChipElement(
      { id: 'ctx-1', type: 'file', title: 'README.md', content: '', enabled: true, addedAt: 1 },
      'codicon codicon-file',
      { onClick: open, onRemove: remove, onMouseEnter: vi.fn(), onMouseLeave: vi.fn() }
    )
    document.body.appendChild(chip)

    const title = chip.querySelector<HTMLElement>('.context-chip__text')!
    const removeButton = chip.querySelector<HTMLButtonElement>('.context-chip__remove')!
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(removeButton.getAttribute('aria-label')).toBe('移除: README.md')
    removeButton.click()
    expect(remove).toHaveBeenCalledWith('ctx-1')
  })
})
