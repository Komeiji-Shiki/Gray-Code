import { ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * 安全读取当前应用视图：未安装 Pinia（组件单测环境）时返回 undefined，
 * 此时「离开设置页回填」行为自动降级为不可用（组件单测不依赖它）。
 */
export function getSettingsView(): string | undefined {
  try {
    return useSettingsStore().currentView
  } catch {
    return undefined
  }
}

/**
 * 「清空后延迟回填」数字输入框草稿管理。
 *
 * 设置页数字输入框存在两类不良交互：
 * 1. 受控 :value 绑定 + 校验拒绝空值 → 输入框清空后立即回退显示旧值；
 * 2. parseInt/Number 回退默认值 → 输入框清空后立即写入并显示默认值。
 * 统一为「草稿」模式：
 * - 编辑期间允许输入框保持为空（不保存、不回退、不写入默认值）；
 * - 输入有效数字时立即提交保存（保持原有即时保存语义）；
 * - 离开设置页时，仍为空/无效的输入框自动回填最后一次保存的值（默认占位符语义）。
 *
 * @param getStored 返回当前已保存值（未保存过返回 undefined）
 * @param isValid 可选校验器：合法数字才允许提交（如「-1 或 ≥1」）
 */
export function useDeferredNumberInput(
  getStored: () => number | string | undefined,
  isValid?: (value: number) => boolean
) {
  const draft = ref('')
  /** 用户是否已手动输入过该输入框（外部配置刷新时避免覆盖未提交的草稿） */
  const touched = ref(false)

  function syncFromStored() {
    const stored = getStored()
    if (stored === undefined || stored === null) {
      draft.value = ''
    } else if (typeof stored === 'number' && Number.isNaN(stored)) {
      draft.value = ''
    } else {
      draft.value = String(stored)
    }
    touched.value = false
  }

  /** 解析草稿：空/非有限/未通过校验 → null */
  function parseDraft(): number | null {
    const text = draft.value.trim()
    if (text === '') return null
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return null
    if (isValid && !isValid(parsed)) return null
    return parsed
  }

  /** @input 处理：草稿跟随输入；有效数字立即提交，空值/无效值不提交。返回提交值（未提交为 null） */
  function handleInput(raw: string, commit: (value: number) => void): number | null {
    draft.value = raw
    touched.value = true
    const parsed = parseDraft()
    if (parsed === null) return null
    commit(parsed)
    return parsed
  }

  // 离开设置页时，仍为空/无效的输入框自动回填最后保存的值。
  // 仍在设置页（currentView 不变，含页内切换页签——此时组件被 v-if 卸载
  // 重挂载，草稿自然随挂载重置）时不自动补全。
  watch(
    getSettingsView,
    (view) => {
      if (view !== 'settings' && parseDraft() === null) {
        syncFromStored()
      }
    }
  )

  syncFromStored()

  return { draft, handleInput, syncFromStored, touched }
}
