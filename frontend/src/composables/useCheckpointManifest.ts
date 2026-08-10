/**
 * useCheckpointManifest - 存档点设置：存档排除清单详情（EX-11，checkpoint.getManifest）
 *
 * 从 CheckpointSettings.vue 拆分（S2 批次），纯重构不改行为：
 * - 打开/关闭某存档的排除清单详情（含加载态/错误态/防串台）
 * - 清单统计（excludedCount / 启用类别）与「快照规则 vs 当前规则」差异提示
 *
 * 依赖注入：config（reactive 整包配置）、loadError（配置加载失败状态），均由 useCheckpointConfig 提供
 */

import { ref, computed, type Ref } from 'vue'
import { getCheckpointManifest } from '@/stores/chat/checkpointActions'
import type { CheckpointRecord, CheckpointManifest } from '@/types'
import type { CheckpointConfig } from './useCheckpointConfig'
import { DEFAULT_PROFILE_IDS } from './useCheckpointExclusion'

export function useCheckpointManifest(
  config: CheckpointConfig,
  loadError: Ref<string | null>
) {
  // EX-11: 查看存档排除清单（checkpoint.getManifest）
  const manifestCheckpointId = ref<string | null>(null)
  const manifestDetail = ref<CheckpointManifest | null>(null)
  const isManifestLoading = ref(false)
  const manifestLoadError = ref<string | null>(null)

  // 排除文件总数（后端 excludedCount 优先，缺省由 excluded 清单长度推导）
  const manifestExcludedCount = computed(() =>
    manifestDetail.value?.excludedCount ?? manifestDetail.value?.excluded?.length ?? 0
  )

  // 快照中启用的排除类别（缺省按默认启用处理，与 isProfileEnabled 同约定）
  const manifestEnabledProfileIds = computed(() => {
    const snap = manifestDetail.value?.ignoreSnapshot
    if (!snap) return []
    return DEFAULT_PROFILE_IDS.filter(id => snap.enabledProfiles[id] !== false)
  })

  // 数组深比较（顺序敏感）：join('\n') 在模式本身含换行或顺序不同时会误判
  function samePatternList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index])
  }

  // 快照规则与当前规则是否不一致（EX-11：解释“快照规则 vs 当前规则”）
  // 仅当配置已成功加载（无 loadError）时比较，避免默认配置误报差异。
  function manifestRulesChanged(): boolean {
    if (loadError.value) return false
    const snap = manifestDetail.value?.ignoreSnapshot
    const cur = config.exclusion
    if (!snap || !cur) return false
    if (snap.maxFileSizeBytes !== cur.maxFileSizeBytes) return true
    // 深比较：join('\n') 在模式本身含换行或顺序不同时会误判
    if (!samePatternList(snap.customPatterns || [], cur.customPatterns || [])) return true
    const snapProfiles = JSON.stringify(snap.enabledProfiles || {}, Object.keys(snap.enabledProfiles || {}).sort())
    const curProfiles = JSON.stringify(cur.enabledProfiles || {}, Object.keys(cur.enabledProfiles || {}).sort())
    return snapProfiles !== curProfiles
  }

  // 打开某存档的排除清单详情（旧存档无 manifest 时提示不可用）
  async function openManifestDetail(cp: CheckpointRecord) {
    manifestCheckpointId.value = cp.id
    manifestDetail.value = null
    manifestLoadError.value = null
    isManifestLoading.value = true
    try {
      const { manifest, error } = await getCheckpointManifest(cp.id)
      // 防串台：期间用户已关闭/切换到其他存档则丢弃
      if (manifestCheckpointId.value !== cp.id) return
      if (error) {
        manifestLoadError.value = error
        return
      }
      manifestDetail.value = manifest
    } finally {
      if (manifestCheckpointId.value === cp.id) {
        isManifestLoading.value = false
      }
    }
  }

  function closeManifestDetail() {
    manifestCheckpointId.value = null
    manifestDetail.value = null
    manifestLoadError.value = null
    isManifestLoading.value = false
  }

  return {
    manifestCheckpointId,
    manifestDetail,
    isManifestLoading,
    manifestLoadError,
    manifestExcludedCount,
    manifestEnabledProfileIds,
    manifestRulesChanged,
    openManifestDetail,
    closeManifestDetail
  }
}
