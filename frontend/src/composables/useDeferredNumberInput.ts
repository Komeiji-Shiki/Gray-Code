import { ref, watch } from 'vue'
import { getSettingsView } from './useSettingsView'

// getSettingsView（设置视图 getter）已迁移到独立模块 useSettingsView；
// 此处 re-export 保持既有引用兼容（多个设置组件仍从本文件导入）。
export { getSettingsView }

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

  /** 解析草稿：空/非有限/格式非法/未通过校验 → null */
  function parseDraft(): number | null {
    const text = draft.value.trim()
    if (text === '') return null
    // 只接受完整数字格式（整数与普通小数），拒绝「2.」「.5」「1e3」等中间态：
    // Number('2.') === 2、Number('.5') === 0.5，直接提交会在输入过程中写入中间值。
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null
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
