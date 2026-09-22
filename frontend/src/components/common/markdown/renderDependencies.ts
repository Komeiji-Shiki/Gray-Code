import { readonly, ref } from 'vue'

type MathRenderer = typeof import('katex')['default']
type SyntaxHighlighter = typeof import('highlight.js')['default']
const dependencyRevision = ref(0)
export const renderDependencyRevision = readonly(dependencyRevision)
let mathRenderer: MathRenderer | undefined
let syntaxHighlighter: SyntaxHighlighter | undefined
let mathLoading: Promise<void> | undefined
let syntaxLoading: Promise<void> | undefined

/** 首次遇到公式时加载，普通正文不需要执行整个数学库。 */
export function getMathRenderer(): MathRenderer | undefined {
  mathLoading ??= import('katex').then(module => {
    mathRenderer = module.default
    dependencyRevision.value++
  }).catch(error => { console.warn('无法加载数学渲染库，保留公式原文。', error) })
  return mathRenderer
}

/** 保留完整语法集合和自动识别，只调整首次加载的时机。 */
export function getSyntaxHighlighter(): SyntaxHighlighter | undefined {
  syntaxLoading ??= import('highlight.js').then(module => {
    syntaxHighlighter = module.default
    dependencyRevision.value++
  }).catch(error => { console.warn('无法加载语法高亮库，保留代码原文。', error) })
  return syntaxHighlighter
}
