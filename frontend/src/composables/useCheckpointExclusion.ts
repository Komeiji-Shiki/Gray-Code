/**
 * useCheckpointExclusion - 存档点设置：排除配置（EX-08 / EX-09）
 *
 * 从 CheckpointSettings.vue 拆分（S2 批次），纯重构不改行为：
 * - 默认排除类别开关/模式编辑（toggleProfile / openProfileEditor / saveProfilePatterns / profilePatterns）
 * - 单文件大小上限（maxFileSizeMiB / saveMaxFileSize）
 * - 自定义排除模式（onCustomPatternsChange）
 * - 排除预览（runPreview / previewRows / reasonLabel / togglePreviewProfile）
 *
 * 依赖注入：config（reactive 整包配置）、updateConfigField（保存链路），均由 useCheckpointConfig 提供
 */

import { ref, computed } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { previewExclusions, type ExclusionPreviewResult } from '@/stores/chat/checkpointActions'
import { t } from '@/i18n'
import type { CheckpointConfig, UpdateCheckpointConfigField } from './useCheckpointConfig'

// 默认排除类别元数据（id 列表；名称走 i18n，模式清单由后端 checkpoint.getExclusionProfiles 提供）
export const DEFAULT_PROFILE_IDS = ['logs', 'aiModels', 'datasets', 'caches', 'pythonVenvs', 'buildArtifacts', 'largeMedia', 'archives'] as const

export function useCheckpointExclusion(
  config: CheckpointConfig,
  updateConfigField: UpdateCheckpointConfigField
) {
  // 后端默认排除类别元数据（模式清单等）
  const exclusionProfileMeta = ref<Array<{ id: string; patterns: string[]; defaultEnabled: boolean }>>([])

  // 预览排除结果状态（EX-09）
  const isPreviewing = ref(false)
  const previewResult = ref<ExclusionPreviewResult | null>(null)
  const previewError = ref<string | null>(null)
  const expandedPreviewProfile = ref<string | null>(null)

  // 加载后端默认排除类别元数据（失败不阻断配置编辑，仅告警）
  async function loadExclusionProfiles() {
    try {
      // 加载默认排除类别元数据
      const profilesResponse = await sendToExtension<{ profiles: Array<{ id: string; patterns: string[]; defaultEnabled: boolean }> }>('checkpoint.getExclusionProfiles', {})
      if (profilesResponse?.profiles) {
        exclusionProfileMeta.value = profilesResponse.profiles
      }
    } catch (error) {
      console.warn('Failed to load exclusion profiles:', error)
    }
  }

  // ========== 排除配置（EX-08 / EX-09） ==========

  // 默认类别是否启用（缺省按默认启用处理）
  function isProfileEnabled(profileId: string): boolean {
    return config.exclusion?.enabledProfiles?.[profileId] !== false
  }

  // 切换默认类别开关
  async function toggleProfile(profileId: string, enabled: boolean) {
    if (!config.exclusion) {
      config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
    }
    config.exclusion.enabledProfiles = {
      ...(config.exclusion.enabledProfiles || {}),
      [profileId]: enabled
    }
    await updateConfigField('exclusion', { ...config.exclusion })
  }

  // ========== 每类别模式编辑 ==========

  // 正在编辑模式的类别 id（null = 未在编辑）
  const editingProfileId = ref<string | null>(null)
  // 编辑草稿（模式数组，PatternListEditor 双向绑定）
  const profilePatternsDraft = ref<string[]>([])

  // 打开类别模式编辑器（预填生效清单，方便基于默认值修改）
  function openProfileEditor(profileId: string) {
    editingProfileId.value = profileId
    profilePatternsDraft.value = [...profilePatterns(profileId)]
  }

  // 保存类别模式覆盖（清空 = 恢复默认清单）
  async function saveProfilePatterns(profileId: string) {
    const lines = [...profilePatternsDraft.value]
    if (!config.exclusion) {
      config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
    }
    const next = { ...(config.exclusion.profilePatterns || {}) }
    if (lines.length === 0) {
      delete next[profileId]  // 空 = 使用默认清单
    } else {
      next[profileId] = lines
    }
    config.exclusion.profilePatterns = next
    editingProfileId.value = null
    await updateConfigField('exclusion', { ...config.exclusion })
  }

  // 类别显示名（i18n）
  function profileLabel(profileId: string): string {
    const key = `components.settings.checkpoint.sections.exclusion.profiles.${profileId}`
    const translated = t(key)
    return translated === key ? profileId : translated
  }

  // 类别生效模式清单（自定义覆盖优先，否则用后端元数据的默认清单）
  function profilePatterns(profileId: string): string[] {
    const custom = config.exclusion?.profilePatterns?.[profileId]
    if (custom && custom.length > 0) return custom
    return exclusionProfileMeta.value.find(p => p.id === profileId)?.patterns || []
  }

  // 单文件大小上限（MiB 显示，保留 1 位小数避免取整误差）
  const maxFileSizeMiB = computed(() => {
    const bytes = config.exclusion?.maxFileSizeBytes ?? 0
    return Math.round((bytes / (1024 * 1024)) * 10) / 10
  })

  // L-1: 非法输入提示（不再静默归一化为 0）
  const maxFileSizeError = ref<string | null>(null)

  // 保存大小上限（MiB -> 字节；0 = 不限制）
  // 空值不保存不报错（编辑期间允许清空，离开设置页时由组件回填已保存值）
  async function saveMaxFileSize(raw: string) {
    const text = String(raw ?? '').trim()
    if (!text) {
      maxFileSizeError.value = null
      return
    }
    const parsed = parseFloat(text)
    if (!Number.isFinite(parsed) || parsed < 0) {
      maxFileSizeError.value = t('components.settings.checkpoint.sections.exclusion.maxFileSize.invalid')
      return
    }
    if (!config.exclusion) {
      config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] }
    }
    config.exclusion.maxFileSizeBytes = Math.round(parsed * 1024 * 1024)
    maxFileSizeError.value = null
    await updateConfigField('exclusion', { ...config.exclusion })
  }

  // 自定义排除模式变更（chips 编辑器每次添加/删除即时触发，立即保存）
  // 输入草稿由 PatternListEditor 内部维护，与 config 重渲染解耦，无需 v-model.lazy 兜底
  async function onCustomPatternsChange(next: string[]) {
    if (!config.exclusion) {
      config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
    }
    config.exclusion.customPatterns = next
    await updateConfigField('exclusion', { ...config.exclusion })
  }

  // 执行排除预览（EX-09）
  async function runPreview() {
    isPreviewing.value = true
    previewError.value = null
    try {
      const result = await previewExclusions()
      previewResult.value = result
      expandedPreviewProfile.value = null
      if (!result) {
        previewError.value = t('components.settings.checkpoint.sections.exclusion.preview.failed')
      }
    } catch (error: any) {
      previewError.value = error?.message || t('components.settings.checkpoint.sections.exclusion.preview.failed')
    } finally {
      isPreviewing.value = false
    }
  }

  // 预览：按类别聚合的行（默认类别 + other）
  const previewRows = computed(() => {
    const result = previewResult.value
    if (!result) return []
    const rows: Array<{ key: string; label: string; summary: ExclusionPreviewResult['summary'] }> = []
    for (const profileId of DEFAULT_PROFILE_IDS) {
      const summary = result.byProfile[profileId]
      if (summary && summary.excludedCount > 0) {
        rows.push({ key: profileId, label: profileLabel(profileId), summary })
      }
    }
    const other = result.byProfile['other']
    if (other && other.excludedCount > 0) {
      rows.push({ key: 'other', label: t('components.settings.checkpoint.sections.exclusion.preview.other'), summary: other })
    }
    return rows
  })

  // 预览：原因文案
  function reasonLabel(reason: string): string {
    const key = `components.settings.checkpoint.sections.exclusion.preview.reasons.${reason}`
    const translated = t(key)
    return translated === key ? reason : translated
  }

  // 预览：展开/收起某个类别
  function togglePreviewProfile(key: string) {
    expandedPreviewProfile.value = expandedPreviewProfile.value === key ? null : key
  }

  return {
    DEFAULT_PROFILE_IDS,
    exclusionProfileMeta,
    loadExclusionProfiles,
    isProfileEnabled,
    toggleProfile,
    editingProfileId,
    profilePatternsDraft,
    openProfileEditor,
    saveProfilePatterns,
    profileLabel,
    profilePatterns,
    maxFileSizeMiB,
    maxFileSizeError,
    saveMaxFileSize,
    onCustomPatternsChange,
    runPreview,
    previewRows,
    reasonLabel,
    togglePreviewProfile,
    isPreviewing,
    previewResult,
    previewError,
    expandedPreviewProfile
  }
}
