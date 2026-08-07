/**
 * MarkdownRenderer 流式代码块滚动修复测试
 *
 * 背景：MarkdownRenderer 通过 v-html 渲染，内容每次更新都会整体重建 DOM，
 * 代码块内部滚动容器（pre.code-block-wrapper，max-height: 400px + overflow-y: auto）
 * 因此被销毁重建、scrollTop 归零——流式输出中长代码块一旦出现滚动条就无法滚动。
 *
 * 修复：流式期间（is-streaming）在根节点挂 is-streaming 类，CSS 据此放开
 * pre 的 max-height（自然展开）；流式结束后移除类、恢复 max-height 限制。
 *
 * B-M1：流式结束后对“流式期间超高”的代码块保留 keep-expanded 展开态，
 * 避免 is-streaming 类移除瞬间高度塌缩回 400px 导致阅读位置丢失；
 * 用户点击换行按钮（或滚动离开）后恢复正常高度限制。
 *
 * 覆盖：
 * - is-streaming 类绑定随 props 切换（CSS 触发源，含完成态滞后释放）
 * - 流式结束后超高块挂 keep-expanded、点击换行按钮后移除
 * - 代码块结构完整（pre 滚动容器 / 工具栏容器 / 行号保留，不破坏现有功能）
 * - fence 渲染器仍生成复制/换行按钮（artifactSafe 路径不经 sanitize，可验证按钮产出）
 * - 流式内容追加后 DOM 同步渲染新增行（渲染管线仍工作）
 * - CSS 静态断言：流式规则 / keep-expanded 规则 / is-nowrap 源码顺序
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import MarkdownRendererSource from '../MarkdownRenderer.vue?raw'

// 打桩 vscode 桥接：MarkdownRenderer 后处理会异步调用文件存在性校验/图片读取，
// 测试环境没有 acquireVsCodeApi，统一返回空结果，避免警告与未捕获异常。
vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ results: {} }),
  showNotification: vi.fn().mockResolvedValue(undefined)
}))

/** 构造一个超过 400px 高度限制的长代码块（61 行），确保滚动容器会出现 */
const LONG_CODE = [
  '```typescript',
  '// line 1',
  ...Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`),
  '```'
].join('\n')

function mountRenderer(props: Record<string, unknown> = {}) {
  return mount(MarkdownRenderer, {
    props: {
      content: '',
      ...props
    }
  })
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// 完成态渲染路径含 setTimeout(0) + prevalidate + nextTick，多等几个 tick 让其稳定收敛
const flushRender = async () => {
  for (let i = 0; i < 4; i++) await tick()
}

/** jsdom 不做布局，scrollHeight 恒为 0：临时桩成 500，模拟超过 400px 折叠阈值的代码块 */
async function withFakeScrollHeight(run: () => Promise<void>): Promise<void> {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 500 })
  try {
    await run()
  } finally {
    if (desc) {
      Object.defineProperty(Element.prototype, 'scrollHeight', desc)
    } else {
      delete (Element.prototype as unknown as { scrollHeight?: number }).scrollHeight
    }
  }
}

describe('MarkdownRenderer 流式代码块滚动修复', () => {
  it('流式期间根节点带 is-streaming 类；流式结束后移除', async () => {
    const wrapper = mountRenderer({ content: LONG_CODE, isStreaming: true })
    await tick()
    await tick()
    expect(wrapper.find('.markdown-content').classes()).toContain('is-streaming')

    await wrapper.setProps({ isStreaming: false })
    // 完成态渲染 + keep-expanded 应用后，流式类才被滞后解除（B-M1 原子过渡）
    await flushRender()
    expect(wrapper.find('.markdown-content').classes()).not.toContain('is-streaming')
    wrapper.unmount()
  })

  it('非流式默认不带 is-streaming 类', async () => {
    const wrapper = mountRenderer({ content: LONG_CODE })
    await tick()
    await tick()
    expect(wrapper.find('.markdown-content').classes()).not.toContain('is-streaming')
    wrapper.unmount()
  })

  it('代码块结构完整：pre 滚动容器、工具栏容器、行号均保留', async () => {
    const wrapper = mountRenderer({ content: LONG_CODE })
    await tick()
    await tick()

    const container = wrapper.find('.code-block-container')
    expect(container.exists()).toBe(true)

    // 滚动容器（非流式时受 max-height 限制）
    const pre = container.find('pre.code-block-wrapper')
    expect(pre.exists()).toBe(true)
    expect(pre.element.tagName.toLowerCase()).toBe('pre')

    // 工具栏容器（标题栏内，固定于滚动区外）
    expect(container.find('.code-block-toolbar').exists()).toBe(true)

    // 行号：61 行代码
    const codeLines = container.findAll('.code-line')
    expect(codeLines.length).toBeGreaterThanOrEqual(61)
    expect(container.find('.code-line-number').exists()).toBe(true)
    expect(container.find('.code-line-content').exists()).toBe(true)
    wrapper.unmount()
  })

  it('fence 渲染器仍生成复制/换行按钮（artifactSafe 路径）', async () => {
    const wrapper = mountRenderer({ content: LONG_CODE, renderProfile: 'artifactSafe' })
    await tick()
    await tick()

    const container = wrapper.find('.code-block-container')
    expect(container.exists()).toBe(true)
    // artifactSafe 不经过 sanitizeHtml，可验证 fence 渲染器自身产出按钮
    expect(container.find('.code-copy-btn').exists()).toBe(true)
    expect(container.find('.code-wrap-btn').exists()).toBe(true)
    wrapper.unmount()
  })

  it('default 路径经 sanitizeHtml 后复制/换行按钮仍保留（sanitize 放行 code-tool-btn）', async () => {
    // 回归：sanitizeHtml 黑名单含 button，会把代码块工具栏按钮一并移除，
    // 导致默认渲染路径下代码块无法复制。sanitize 需放行 class 受控的工具栏按钮。
    const wrapper = mountRenderer({ content: LONG_CODE })
    await tick()
    await tick()

    const container = wrapper.find('.code-block-container')
    expect(container.exists()).toBe(true)
    const copyBtn = container.find('.code-copy-btn')
    expect(copyBtn.exists()).toBe(true)
    // data-code 保留（base64 编码的原始代码），点击时可解码出原文
    const encoded = copyBtn.attributes('data-code')
    expect(encoded).toBeTruthy()
    expect(decodeURIComponent(atob(encoded!))).toContain('// line 1')
    expect(container.find('.code-wrap-btn').exists()).toBe(true)
    wrapper.unmount()
  })

  it('流式内容追加后 DOM 同步渲染新增行', async () => {
    // markdown-it fence 内容带尾部换行，splitHighlightedHtmlByNewline 会产生尾随空行
    const part1 = '```typescript\nconst a = 1;\n```'
    const part2 = '```typescript\nconst a = 1;\nconst b = 2;\n```'

    const wrapper = mountRenderer({ content: part1, isStreaming: true })
    await tick()
    await tick()
    expect(wrapper.findAll('.code-line')).toHaveLength(2)

    await wrapper.setProps({ content: part2 })
    // 流式渲染有 120ms debounce，等待其触发
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await tick()

    expect(wrapper.findAll('.code-line')).toHaveLength(3)
    expect(wrapper.find('.code-block-container').exists()).toBe(true)
    expect(wrapper.find('.markdown-content').classes()).toContain('is-streaming')
    wrapper.unmount()
  })

  it('流式结束后对超高代码块保留 keep-expanded 展开态（不塌缩回 400px）', async () => {
    await withFakeScrollHeight(async () => {
      const wrapper = mountRenderer({ content: LONG_CODE, isStreaming: true })
      await tick()
      await tick()
      // 流式期间：由 is-streaming 类放开高度，不挂 keep-expanded
      expect(wrapper.find('.code-block-container').classes()).not.toContain('keep-expanded')

      await wrapper.setProps({ isStreaming: false })
      await flushRender()
      // 流式类已解除，且超高块保留展开态（阅读位置不因高度塌缩丢失）
      expect(wrapper.find('.markdown-content').classes()).not.toContain('is-streaming')
      expect(wrapper.find('.code-block-container').classes()).toContain('keep-expanded')
      wrapper.unmount()
    })
  })

  it('用户点击换行按钮后移除 keep-expanded，恢复正常高度限制', async () => {
    await withFakeScrollHeight(async () => {
      // artifactSafe 路径不经 sanitizeHtml，工具栏按钮保留在 DOM 中可触发点击
      const wrapper = mountRenderer({ content: LONG_CODE, renderProfile: 'artifactSafe', isStreaming: true })
      await tick()
      await tick()
      await wrapper.setProps({ isStreaming: false })
      await flushRender()
      expect(wrapper.find('.code-block-container').classes()).toContain('keep-expanded')

      await wrapper.find('.code-wrap-btn').trigger('click')
      expect(wrapper.find('.code-block-container').classes()).not.toContain('keep-expanded')
      // 换行切换按钮本身仍可用（不破坏现有交互）
      expect(wrapper.find('.code-wrap-btn').exists()).toBe(true)
      wrapper.unmount()
    })
  })

  it('CSS 静态断言：流式规则放开 pre 高度、keep-expanded 保留展开态、is-nowrap 在其后生效', () => {
    const source = MarkdownRendererSource
    // 流式规则存在且放开 max-height
    expect(source).toMatch(/\.markdown-content\.is-streaming[\s\S]*?\{[\s\S]*?max-height:\s*none/)
    // 用 overflow: visible（两轴声明），而非无效的 overflow-y: visible
    expect(source).toMatch(/\.markdown-content\.is-streaming[\s\S]*?\{[\s\S]*?overflow:\s*visible/)
    expect(source).not.toMatch(/\.markdown-content\.is-streaming[\s\S]*?\{[\s\S]*?overflow-y:\s*visible/)
    // keep-expanded 规则保留展开态
    expect(source).toMatch(/\.code-block-container\.keep-expanded[\s\S]*?pre\.code-block-wrapper[\s\S]*?\{[\s\S]*?max-height:\s*none/)
    // is-nowrap 的 overflow-x: auto 声明在流式规则之后（同优先级按源码顺序覆盖生效）
    const streamingIdx = source.indexOf('.markdown-content.is-streaming')
    const nowrapIdx = source.indexOf('.code-block-container.is-nowrap pre.code-block-wrapper')
    expect(streamingIdx).toBeGreaterThan(-1)
    expect(nowrapIdx).toBeGreaterThan(streamingIdx)
  })
})
