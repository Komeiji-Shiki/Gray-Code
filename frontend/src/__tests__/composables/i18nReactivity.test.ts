/**
 * i18n 响应式回归测试：翻译缓存短路导致计算属性冻结
 *
 * 背景：t() 有按 key 的翻译缓存。若某个计算属性首次求值时命中缓存
 * （同一 key 已被其它计算属性/模板先求值缓存），t() 走缓存短路返回，
 * 不会读取 currentMessages——该计算属性因此丢失对语言切换的响应式依赖，
 * 之后语言无论怎么切，标签都冻结在首帧语言（实测：工作区选择器标签
 * 「未打开工作区」在切到 English/日本語 后仍不更新，用户误以为是 i18n 漏译）。
 *
 * 修复：t() 在缓存命中前先读取 currentMessages（建立响应式依赖，热路径
 * 仅为一次 computed getter，currentMessages 只在语言变化时重算）。
 * 本测试按真实组件的求值顺序复现：tooltip 计算属性先求值（命中路径），
 * label 计算属性后求值（修复前走缓存短路）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, nextTick } from 'vue'
import { setLanguage, setDetectedLanguage, t } from '@/i18n'

const KEY = 'components.tabs.workspaceSelector.noWorkspace'

/** 复现组件：tooltip 先求值（写缓存），label 后求值（读缓存短路） */
function createLabelComponent() {
  return {
    setup() {
      const tooltip = computed(() => t(KEY))
      const label = computed(() => t(KEY))
      return { tooltip, label }
    },
    template: `<div><span class="tip">{{ tooltip }}</span><span class="label">{{ label }}</span></div>`
  }
}

describe('i18n 计算属性响应性（缓存短路回归）', () => {
  beforeEach(() => {
    setDetectedLanguage('zh-CN')
    setLanguage('zh-CN')
  })

  it('缓存命中后切换语言，计算属性标签仍跟随语言更新（zh→en→ja）', async () => {
    const wrapper = mount(createLabelComponent())
    expect(wrapper.find('.label').text()).toBe('未打开工作区')
    // tooltip 先求值已写入缓存；切语言后 label 必须仍响应式更新
    setLanguage('en')
    await nextTick()
    expect(wrapper.find('.label').text()).toBe('No Workspace')
    setLanguage('ja')
    await nextTick()
    expect(wrapper.find('.label').text()).toBe('ワークスペースなし')
    setLanguage('zh-CN')
    await nextTick()
    expect(wrapper.find('.label').text()).toBe('未打开工作区')
  })

  it('模板直接调用 t() 的标签同样跟随语言更新', async () => {
    const wrapper = mount({
      setup() {
        return { t }
      },
      template: `<span class="direct">{{ t('components.tabs.workspaceSelector.noWorkspace') }}</span>`
    })
    expect(wrapper.find('.direct').text()).toBe('未打开工作区')
    setLanguage('en')
    await nextTick()
    expect(wrapper.find('.direct').text()).toBe('No Workspace')
    setLanguage('ja')
    await nextTick()
    expect(wrapper.find('.direct').text()).toBe('ワークスペースなし')
  })
})
