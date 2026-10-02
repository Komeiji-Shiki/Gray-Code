/**
 * renderStreamingContent：按顶层块缓存的流式渲染必须与整篇 renderContent 逐字节一致。
 *
 * 覆盖：
 * - 多种块（列表松紧、setext、表格、引用、代码/mermaid/数学块、定义列表）的每个前缀
 * - 命中缓存时只重新 render 末尾块，且后续代码块 data-block-id 不错位
 * - 引用式链接定义 / 脚注 / 原始 HTML 存在时回退整篇渲染
 * - 工作区文件存在性变化使相关缓存块失效
 */
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { getMarkdownItInstance, renderContent, renderStreamingContent, type RenderProfile } from '../markdown/markdownItEngine'
import { fileExistenceCache, streamingBlockRenderCache } from '../markdown/markdownItCore'
import { workspaceAssetCacheKey } from '../markdown/assetChanges'

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ results: {} }),
  showNotification: vi.fn().mockResolvedValue(undefined)
}))

const CORPUS = [
  '# Title',
  '',
  'Intro with "quotes" -- and https://example.com plus $x^2$ and \\(y\\).',
  '',
  'Setext heading',
  '---',
  '',
  '- tight one',
  '- tight two',
  '  - nested',
  '',
  '1. loose one',
  '',
  '2. loose two',
  '',
  '- [ ] task',
  '- [x] done',
  '',
  '| A | B |',
  '| :-- | --: |',
  '| 1 | 2 |',
  '',
  '> quote',
  '> - item',
  '',
  '```ts',
  'const a = 1',
  '',
  'const b = 2',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```',
  'plain   code',
  '```',
  '',
  '    indented code',
  '',
  '$$',
  'a + b',
  '$$',
  '',
  '\\[ c \\]',
  '',
  'Term',
  ': definition',
  '',
  '***',
  '',
  'Spaces  kept   here ![img](picture.png)',
  '',
  '```js',
  'tail()',
  '```',
  '',
  'Last paragraph'
].join('\n')

/** markdown-it-task-lists 每次渲染都生成随机 checkbox id（可能为负数），比较前归一。 */
const normalizeIds = (html: string) => html.replace(/task-item--?\d+/g, 'task-item-N')

function streamingPrefixes(source: string): string[] {
  const prefixes: string[] = []
  for (let i = 1; i <= source.length; i += 7) prefixes.push(source.slice(0, i))
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) {
    prefixes.push(source.slice(0, i + 1))
  }
  prefixes.push(source)
  return prefixes
}

beforeAll(async () => {
  // 预热高亮与 KaTeX 懒加载，避免两次渲染之间依赖状态变化。
  renderContent('```ts\nx\n```\n\n$x$', false, 'default')
  await vi.dynamicImportSettled()
})

beforeEach(() => {
  streamingBlockRenderCache.clear()
  fileExistenceCache.clear()
  vi.restoreAllMocks()
})

describe('renderStreamingContent', () => {
  test.each<RenderProfile>(['default', 'artifactSafe'])('matches renderContent for every streamed prefix (%s)', (profile) => {
    for (const source of [CORPUS, CORPUS.replace(/\n/g, '\r\n')]) {
      for (const prefix of streamingPrefixes(source)) {
        expect(normalizeIds(renderStreamingContent(prefix, false, profile, 'c1', 'zh-CN')))
          .toBe(normalizeIds(renderContent(prefix, false, profile, 'c1')))
      }
    }
  })

  test('re-renders only the growing tail block on cache hits and keeps code block ids aligned', () => {
    const markdownIt = getMarkdownItInstance('default')
    const render = vi.spyOn(markdownIt.renderer, 'render')
    const head = '```ts\na\n```\n\npara\n\n```js\nb\n```\n\n'

    renderStreamingContent(`${head}tail`, false, 'default', 'c1', 'zh-CN')
    expect(render).toHaveBeenCalledTimes(4)

    render.mockClear()
    const next = `${head}tail grows\n\n\`\`\`py\nc\n\`\`\``
    const html = renderStreamingContent(next, false, 'default', 'c1', 'zh-CN')
    // 前三块命中缓存；只渲染已不再是末块的 tail 段落与新的末块。
    expect(render).toHaveBeenCalledTimes(2)
    expect(html).toBe(renderContent(next, false, 'default', 'c1'))
    expect(html).toContain('data-block-id="3"')
  })

  test('does not reuse blocks across render contexts', () => {
    const markdownIt = getMarkdownItInstance('default')
    const source = 'one\n\ntwo'
    renderStreamingContent(source, false, 'default', 'c1', 'zh-CN')
    const render = vi.spyOn(markdownIt.renderer, 'render')
    renderStreamingContent(source, false, 'default', 'c2', 'zh-CN')
    renderStreamingContent(source, false, 'default', 'c1', 'en')
    expect(render).toHaveBeenCalledTimes(4)
  })

  test('matches renderContent for every streamed prefix without task lists (block cache active)', () => {
    // 任务列表由插件生成 html_inline，会走整篇回退；去掉后确保上面的前缀用例确实覆盖分块路径。
    const source = CORPUS.replace(/- \[[ x]\] /g, '- ')
    for (const prefix of streamingPrefixes(source)) {
      expect(renderStreamingContent(prefix, false, 'default', 'c1', 'zh-CN')).toBe(renderContent(prefix, false, 'default', 'c1'))
    }
    expect(streamingBlockRenderCache.size).toBeGreaterThan(10)
  })

  test.each([
    ['task lists (plugin html_inline)', '- [ ] todo\n\nmore'],
    ['reference definitions', 'See [docs][d].\n\n[d]: https://example.com\n\nmore'],
    ['footnotes', 'Text[^1]\n\nmore\n\n[^1]: note'],
    ['raw HTML spanning blocks', '<div>\n\ninside\n\n</div>\n\nafter'],
    ['inline HTML', 'a <b>bold\n\nb</b> c']
  ])('falls back to a whole-document render for %s', (_label, source) => {
    const markdownIt = getMarkdownItInstance('default')
    const render = vi.spyOn(markdownIt.renderer, 'render')
    expect(normalizeIds(renderStreamingContent(source, false, 'default', 'c1', 'zh-CN')))
      .toBe(normalizeIds(renderContent(source, false, 'default', 'c1')))
    // 第一次调用来自 renderStreamingContent 的整篇渲染，第二次来自对照的 renderContent。
    expect(render.mock.calls[0][0]).toHaveLength(markdownIt.parse(source, {}).length)
    expect(streamingBlockRenderCache.size).toBe(0)
  })

  test('invalidates cached blocks when workspace file existence changes', () => {
    const source = 'see `src/a.ts` and src/b.ts\n\n```1:2:src/c.ts\ncode\n```\n\ntail'
    const before = renderStreamingContent(source, false, 'default', 'c1', 'zh-CN')
    expect(before).not.toContain('workspace-file-link')

    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      fileExistenceCache.set(workspaceAssetCacheKey(path, 'c1'), true)
    }
    const after = renderStreamingContent(source, false, 'default', 'c1', 'zh-CN')
    expect(after).toBe(renderContent(source, false, 'default', 'c1'))
    expect(after.match(/workspace-file-link/g)?.length).toBe(3)
  })
})
