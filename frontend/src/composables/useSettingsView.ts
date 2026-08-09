import { useSettingsStore } from '@/stores/settingsStore'

/**
 * 安全读取当前应用视图：未安装 Pinia（组件单测环境）时返回 undefined，
 * 此时「离开设置页回填」行为自动降级为不可用（组件单测不依赖它）。
 *
 * 供多个设置组件与 composable 共用（PromptEntriesEditor / CheckpointSettings /
 * SummarizeSettings / useBranchCleanup / useDeferredNumberInput 等）：
 * 放在独立模块，避免「设置视图 getter」寄生在数字输入草稿 composable 里。
 */
export function getSettingsView(): string | undefined {
  try {
    return useSettingsStore().currentView
  } catch {
    return undefined
  }
}
