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
 * 覆盖：
 * - is-streaming 类绑定随 props 切换（CSS 触发源）
 * - 代码块结构完整（pre 滚动容器 / 工具栏容器 / 行号保留，不破坏现有功能）
 * - fence 渲染器仍生成复制/换行按钮（artifactSafe 路径不经 sanitize，可验证按钮产出）
 * - 流式内容追加后 DOM 同步渲染新增行（渲染管线仍工作）
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownRenderer from '../MarkdownRenderer.vue'

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

describe('MarkdownRenderer 流式代码块滚动修复', () => {
  it('流式期间根节点带 is-streaming 类；流式结束后移除', async () => {
    const wrapper = mountRenderer({ content: LONG_CODE, isStreaming: true })
    await tick()
    await tick()
    expect(wrapper.find('.markdown-content').classes()).toContain('is-streaming')

    await wrapper.setProps({ isStreaming: false })
    await tick()
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
})
