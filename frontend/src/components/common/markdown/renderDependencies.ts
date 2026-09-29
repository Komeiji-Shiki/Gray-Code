import { readonly, ref } from 'vue'
import { lazyDependency } from './lazyDependency'

type MathRenderer = typeof import('katex')['default']
type SyntaxHighlighter = typeof import('highlight.js')['default']
const dependencyRevision = ref(0)
export const renderDependencyRevision = readonly(dependencyRevision)

/** 首次遇到公式时加载，普通正文不需要执行整个数学库。 */
export const getMathRenderer = lazyDependency<MathRenderer>(() => import('katex').then(module => module.default),
  () => { dependencyRevision.value++ }, error => console.warn('无法加载数学渲染库，保留公式原文。', error))

/** 保留完整语法集合和自动识别，只调整首次加载的时机。 */
export const getSyntaxHighlighter = lazyDependency<SyntaxHighlighter>(() => import('highlight.js').then(module => module.default),
  () => { dependencyRevision.value++ }, error => console.warn('无法加载语法高亮库，保留代码原文。', error))
