import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { loadDiffContent as requestDiffContent } from '../../../utils/vscode'

export type ToolDiffContent = Awaited<ReturnType<typeof requestDiffContent>>
export interface ToolDiffSource { key: string; diffContentId?: string }
type ToolDiffView = 'content' | 'matches' | 'diff'

/** 文件与搜索卡片共用差异资源生命周期，缓存身份采用回执中的差异 ID。 */
export function useToolDiffPreviews(sources: Readonly<Ref<ToolDiffSource[]>>, initialView: 'content' | 'matches') {
  const diffContents = ref(new Map<string, ToolDiffContent>())
  const loadingDiffs = ref(new Set<string>())
  const diffLoadErrors = ref(new Map<string, string>())
  const viewModes = ref(new Map<string, ToolDiffView>())
  const sourceIds = new Map<string, string>()
  let disposed = false

  async function loadDiffContent(key: string, id: string) {
    if (disposed || loadingDiffs.value.has(key) && sourceIds.get(key) === id) return
    sourceIds.set(key, id)
    diffContents.value.delete(key)
    diffLoadErrors.value.delete(key)
    loadingDiffs.value.add(key)
    const current = () => !disposed && sourceIds.get(key) === id
      && sources.value.some(source => source.key === key && source.diffContentId === id)
    try {
      const content = await requestDiffContent(id)
      if (!current()) return
      diffContents.value.set(key, content)
      viewModes.value.set(key, 'diff')
    } catch (error) {
      if (current()) diffLoadErrors.value.set(key, error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) loadingDiffs.value.delete(key)
    }
  }

  watch(sources, entries => {
    const next = new Map(entries.filter(source => source.diffContentId).map(source => [source.key, source.diffContentId!]))
    for (const [key, id] of sourceIds) {
      if (next.get(key) === id) continue
      sourceIds.delete(key); diffContents.value.delete(key); loadingDiffs.value.delete(key)
      diffLoadErrors.value.delete(key); viewModes.value.delete(key)
    }
    for (const [key, id] of next) if (sourceIds.get(key) !== id) void loadDiffContent(key, id)
  }, { immediate: true })

  onScopeDispose(() => { disposed = true; sourceIds.clear() })
  return { diffContents, diffLoadErrors, viewModes, loadDiffContent,
    getViewMode: (key: string) => viewModes.value.get(key) ?? initialView,
    hasDiffContent: (key: string) => diffContents.value.has(key),
    isLoadingDiff: (key: string) => loadingDiffs.value.has(key) }
}
