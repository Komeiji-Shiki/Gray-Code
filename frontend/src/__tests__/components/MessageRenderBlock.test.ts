import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { defineComponent, nextTick, watch } from 'vue'
import MessageRenderBlock from '../../components/message/MessageRenderBlock.vue'
import {
  disposeAllSmoothStreams,
  finishSmoothStream,
  pushSmoothText
} from '../../stores/chat/smoothStreamManager'

function stubAnimationFrame(): void {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: {
    content: { type: String, default: '' },
    isStreaming: Boolean,
    latexOnly: Boolean
  },
  emits: ['rendered'],
  setup(props, { emit }) {
    watch(
      () => props.content,
      async (source) => {
        await nextTick()
        emit('rendered', source)
      },
      { immediate: true }
    )
    return {}
  },
  template: '<div class="markdown-stub">{{ content }}</div>'
})

function mountBlock(props: Record<string, unknown> = {}) {
  return mount(MessageRenderBlock, {
    props: {
      block: { type: 'thought', text: 'base ', partKey: 'thought:0', partCount: 1 },
      messageId: 'thought-message',
      messageRole: 'assistant',
      isStreaming: true,
      thoughtViewMode: 'collapsed',
      isThinking: true,
      thinkingTimeDisplay: '1.0s',
      smoothDisplayActive: true,
      setThoughtViewMode: vi.fn(),
      ...props
    },
    global: {
      stubs: {
        MarkdownRenderer: MarkdownRendererStub,
        InlineContextMessage: true,
        ToolMessage: true
      }
    }
  })
}

describe('MessageRenderBlock thought 三段式视图', () => {
  beforeEach(() => {
    disposeAllSmoothStreams()
    stubAnimationFrame()
  })

  afterEach(() => {
    disposeAllSmoothStreams()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  test('collapsed 完全折叠：只保留头部，无内容区与流式预览 host', async () => {
    pushSmoothText('thought-message', 'thought:0', 'thinking', 'balanced', 'base ', () => {})

    const wrapper = mountBlock()

    await nextTick()
    // 三段式按钮组常驻头部
    expect(wrapper.findAll('.thought-view-btn')).toHaveLength(3)
    expect(wrapper.find('.thought-block').classes()).toContain('view-collapsed')
    // 完全折叠不渲染任何内容区（中展开区 / 展开区 / 流式预览 host 都不存在）
    expect(wrapper.find('.thought-medium').exists()).toBe(false)
    expect(wrapper.find('.thought-content').exists()).toBe(false)
    expect(wrapper.find('.thought-flow-medium').exists()).toBe(false)
    expect(wrapper.find('.thought-flow-content').exists()).toBe(false)

    wrapper.unmount()
  })

  test('medium 中展开：完整段落提升到渐进 markdown，未完成尾巴留在 CharFlow', async () => {
    pushSmoothText('thought-message', 'thought:0', '续', 'balanced', '前段\n\n', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    await Promise.resolve() // rendered emit 后 bridge release 位于下一微任务
    // 注册即恢复基线并立即提升：已定型完整段落（\n\n 边界）进入渐进 markdown 层即时渲染格式
    expect(wrapper.get('.thought-block').classes()).toContain('view-medium')
    expect(wrapper.get('.markdown-stub').element.textContent).toBe('前段\n\n')
    expect(wrapper.get('.thought-flow-medium').element.textContent).toBe('')

    finishSmoothStream('thought-message')
    // append 增量无 \n\n 边界不提升：留在 CharFlow host 多行滚动预览
    expect(wrapper.get('.thought-flow-medium').element.textContent).toBe('续')

    wrapper.unmount()
  })

  test('medium 切到 expanded 时 CharFlow 重新注册为展开态（渐进 markdown）', async () => {
    pushSmoothText('thought-message', 'thought:0', 'para one\n\npara two', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    expect(wrapper.get('.thought-flow-medium').element.textContent).toBe('')

    await wrapper.setProps({ thoughtViewMode: 'expanded' })
    await nextTick()
    // 展开态：未完成尾巴走 CharFlow host，已定型完整段落走渐进 markdown
    expect(wrapper.find('.thought-flow-medium').exists()).toBe(false)
    expect(wrapper.get('.thought-flow-content').element.textContent).toBe('')

    finishSmoothStream('thought-message')
    await nextTick()
    await nextTick()
    await Promise.resolve()
    // flush 后完整段落（\n\n 边界）被提升到渐进渲染层即时出格式，未完成尾巴留在 CharFlow host
    // （用 element.textContent 断言：test-utils 的 .text() 会 trim 尾随换行）
    expect(wrapper.get('.markdown-stub').element.textContent).toBe('para one\n\n')
    expect(wrapper.get('.thought-flow-content').text()).toBe('para two')

    wrapper.unmount()
  })

  test('medium 切到 expanded 并 replay 相同 source 时会重新确认 Markdown DOM', async () => {
    const source = 'para one\n\n'
    const tail = 'para two'
    pushSmoothText('thought-message', 'thought:0', '', 'balanced', source + tail, () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })
    await nextTick()
    await Promise.resolve()
    expect(wrapper.get('.markdown-stub').element.textContent).toBe(source)
    expect(wrapper.get('.thought-flow-medium').element.textContent).toBe(tail)

    // release 与 replay 同处一个 Vue flush，source 值最终未变；generation key 必须强制新 ack。
    await wrapper.setProps({ thoughtViewMode: 'expanded' })
    await nextTick()
    await nextTick()
    await Promise.resolve()

    expect(wrapper.get('.markdown-stub').element.textContent).toBe(source)
    expect(wrapper.get('.thought-flow-content').element.textContent).toBe(tail)

    wrapper.unmount()
  })

  test('expanded 完全展开：非流式完整 markdown 渲染', async () => {
    const wrapper = mountBlock({
      thoughtViewMode: 'expanded',
      isStreaming: false,
      smoothDisplayActive: false
    })

    await nextTick()
    expect(wrapper.get('.thought-block').classes()).toContain('view-expanded')
    expect(wrapper.get('.markdown-stub').element.textContent).toBe('base ')
    expect(wrapper.find('.thought-medium').exists()).toBe(false)

    wrapper.unmount()
  })

  test('非流式中展开：markdown 渲染 + 固定高度滚动区', async () => {
    const wrapper = mountBlock({
      thoughtViewMode: 'medium',
      isStreaming: false,
      smoothDisplayActive: false
    })

    await nextTick()
    // 非流式走 MarkdownRenderer（与展开态同渲染，容器固定高度滚动）
    expect(wrapper.get('.markdown-stub').element.textContent).toBe('base ')
    expect(wrapper.find('.thought-medium-text').exists()).toBe(false)

    wrapper.unmount()
  })

  test('头部单击循环切换三段式：collapsed → medium → expanded → collapsed', async () => {
    const setThoughtViewMode = vi.fn()
    const wrapper = mountBlock({ setThoughtViewMode })

    await wrapper.get('.thought-header').trigger('click')
    expect(setThoughtViewMode).toHaveBeenLastCalledWith('medium')

    await wrapper.setProps({ thoughtViewMode: 'medium' })
    await wrapper.get('.thought-header').trigger('click')
    expect(setThoughtViewMode).toHaveBeenLastCalledWith('expanded')

    await wrapper.setProps({ thoughtViewMode: 'expanded' })
    await wrapper.get('.thought-header').trigger('click')
    expect(setThoughtViewMode).toHaveBeenLastCalledWith('collapsed')

    wrapper.unmount()
  })

  test('中展开：尾部窗口裁剪后显示「内容过长」提示条', async () => {
    // 单段超长内容（无 \n\n 边界不提升），超过 tailWindow 4096 触发裁剪
    pushSmoothText('thought-message', 'thought:0', 'x'.repeat(5000), 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    expect(wrapper.find('.thought-trim-hint').exists()).toBe(false)

    finishSmoothStream('thought-message')
    await nextTick()
    // onTrimmed 回调置位：提示条出现在内容区顶部
    expect(wrapper.find('.thought-trim-hint').exists()).toBe(true)

    wrapper.unmount()
  })

  test('中展开：用户滚离底部后内容更新不再强制贴底', async () => {
    pushSmoothText('thought-message', 'thought:0', 'abc', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 0
    // 模拟用户向上滚动：scrollTop=0 距底部 400px，超过 40px 阈值 → 暂停吸底
    await wrapper.get('.thought-medium').trigger('scroll')

    finishSmoothStream('thought-message')
    // 内容追加但 scrollTop 未被拉回（不打扰用户查看历史）
    expect(el.scrollTop).toBe(0)

    wrapper.unmount()
  })

  test('中展开：用户滚回底部附近后恢复自动贴底', async () => {
    pushSmoothText('thought-message', 'thought:0', 'abc', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 0
    await wrapper.get('.thought-medium').trigger('scroll') // 暂停吸底

    el.scrollTop = 480 // 距底部 20px < 40px 阈值 → 恢复吸底
    await wrapper.get('.thought-medium').trigger('scroll')

    finishSmoothStream('thought-message')
    // 恢复吸底后内容追加贴到底部（scrollHeight=500）
    expect(el.scrollTop).toBe(500)

    wrapper.unmount()
  })

  test('中展开：scroll 事件滞后时内容更新按当前位置复验，不误拉回', async () => {
    pushSmoothText('thought-message', 'thought:0', 'abc', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 0
    await wrapper.get('.thought-medium').trigger('scroll') // userScrolled=true，距底 400px → 暂停吸底

    el.scrollTop = 480 // 距底 20px → 恢复吸底
    await wrapper.get('.thought-medium').trigger('scroll')

    el.scrollTop = 200 // 用户又向上滚动（模拟 scroll 事件尚未派发：不再 trigger）
    finishSmoothStream('thought-message')
    // shouldStickBottom 实时复验：距底 200px ≥ 40 → 不贴底，且状态同步置 false
    expect(el.scrollTop).toBe(200)

    wrapper.unmount()
  })

  test('中展开：promote 后等 Vue 渲染完成（nextTick）按最终高度贴底', async () => {
    pushSmoothText('thought-message', 'thought:0', 'tail', 'balanced', '前段\n\n', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })
    // mount 后立即 stub：post watch（注册 → promote → nextTick 校正）尚未 flush，
    // 校正执行时 scrollHeight 已是模拟的「Vue 渲染完成后的最终高度」
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 0

    await nextTick()
    // 用户未干预（userScrolled=false）无条件贴底；promote 后的 nextTick 校正落在最终高度
    expect(el.scrollTop).toBe(500)

    wrapper.unmount()
  })

  test('中展开：用户滚回底部后内容大段增长不丢吸底', async () => {
    pushSmoothText('thought-message', 'thought:0', 'abc', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 0
    await wrapper.get('.thought-medium').trigger('scroll') // 暂停吸底

    el.scrollTop = 480 // 距底 20px → 恢复吸底
    await wrapper.get('.thought-medium').trigger('scroll')

    // 大段输出/md 解析：内容暴涨但用户没动（scrollTop 未变）
    Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true })

    finishSmoothStream('thought-message')
    // 吸底状态保持：贴到最新底部（旧实现在此按 scrollHeight 复验误判「滚离」丢吸底）
    expect(el.scrollTop).toBe(1500)

    wrapper.unmount()
  })

  test('中展开：wheel 滚动期间内容增长不拉回（高 tps 抵消滚动距离）', async () => {
    pushSmoothText('thought-message', 'thought:0', 'abc', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 480 // 距底 20px（贴底附近）
    await wrapper.get('.thought-medium').trigger('scroll') // 吸底状态就位

    // 用户滚轮向上滚动 50px：wheel 输入事件标记冷静期；scrollTop 同步生效
    await wrapper.get('.thought-medium').trigger('wheel')
    el.scrollTop = 430
    // 高 tps：内容同步增长 40px（scrollHeight 500 → 540），抵消大部分滚动距离
    Object.defineProperty(el, 'scrollHeight', { value: 540, configurable: true })

    finishSmoothStream('thought-message')
    // 冷静期内不贴底：用户位置保持（旧实现按距底 10px < 40 判定贴底拉回）
    expect(el.scrollTop).toBe(430)

    wrapper.unmount()
  })

  test('中展开：贴底写入后代码块异步渲染高度骤增不丢吸底', async () => {
    pushSmoothText('thought-message', 'thought:0', 'abc', 'balanced', '', () => {})

    const wrapper = mountBlock({ thoughtViewMode: 'medium' })

    await nextTick()
    const el = wrapper.get('.thought-medium').element
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 0
    await wrapper.get('.thought-medium').trigger('scroll') // 暂停吸底
    el.scrollTop = 480 // 距底 20px → 恢复吸底
    await wrapper.get('.thought-medium').trigger('scroll')

    // 第一次内容更新：CharFlow 贴底写入（scrollTop → 500）
    pushSmoothText('thought-message', 'thought:0', 'def', 'balanced', 'abc', () => {})
    finishSmoothStream('thought-message')
    // 等微任务读回程序写入位置
    await nextTick()
    expect(el.scrollTop).toBe(500)

    // 模拟代码块异步渲染（hljs 高亮）：scrollHeight 骤增 500 → 1500，用户没动
    Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true })

    // 又一段内容更新：吸底必须保持（旧实现把程序写入误判为用户滚动 →
    // 距底 900px ≥ 40 → 丢吸底，scrollTop 停在 500）
    pushSmoothText('thought-message', 'thought:0', 'ghi', 'balanced', 'abcdef', () => {})
    finishSmoothStream('thought-message')
    expect(el.scrollTop).toBe(1500)

    wrapper.unmount()
  })
})
