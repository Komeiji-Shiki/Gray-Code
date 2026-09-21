import { h, type Component, type VNode } from 'vue'
import type { ToolUsage } from '../../../types'
import { DefaultToolResult, getToolConfig } from '../../../utils/toolRegistry'
import {
  confirmDiff,
  rejectDiff,
  globalApplyDiffConfig,
  getDiffAutoSaveTimeLeftById,
  getDiffAutoSaveProgressById,
  isDiffSessionProcessing,
  getDiffActionError,
  getPendingDiffSessions
} from '../diffReviewController'

type Translate = (key: string, params?: Record<string, any>) => string

/**
 * 渲染工具详细内容（自定义组件 / contentFormatter / 通用结构化展示）。
 * 从 ToolMessage.vue 原样抽出（F-07），t 由调用方通过 useI18n 传入。
 */
export function renderToolContent(
  tool: ToolUsage,
  messageBackendIndex: number | undefined,
  t: Translate
): VNode {
  const config = getToolConfig(tool.name)

  // 如果有自定义组件，使用自定义组件
  if (config?.contentComponent) {
    return h(config.contentComponent as Component, {
      args: tool.args,
      result: tool.result,
      error: tool.error,
      status: tool.status,
      toolId: tool.id,
      toolName: tool.name,
      messageBackendIndex,
      pendingDiffs: getPendingDiffSessions(tool.id),
      diffActionController: {
        autoSaveEnabled: globalApplyDiffConfig.value.autoSave,
        getTimeLeft: getDiffAutoSaveTimeLeftById,
        getProgress: getDiffAutoSaveProgressById,
        isProcessing: isDiffSessionProcessing,
        getError: getDiffActionError,
        confirm: confirmDiff,
        reject: rejectDiff
      }
    })
  }

  // 如果有内容格式化器，使用格式化器
  if (config?.contentFormatter) {
    let content: unknown = null
    try {
      content = config.contentFormatter(tool.args, tool.result)
    } catch {
      // formatter 崩溃时仍提供结构化结果，避免整个工具块渲染失败。
      content = null
    }

    // formatter 正常返回非空内容时保留原有结构，否则使用通用展示。
    if (content) {
      const children: any[] = []

      // content 类型为 unknown（formatter 返回值容错化）；h() 的 children 参数要求 RawChildren，此处断言 any 保持运行时行为不变
      children.push(h('div', { class: 'tool-content-text' }, content as any))

      if (tool.error) {
        children.push(
          h('div', { class: 'content-section error-section' }, [
            h('div', { class: 'section-label' }, t('components.message.tool.error') + ':'),
            h('div', { class: 'error-message' }, tool.error)
          ])
        )
      }

      return h('div', { class: 'tool-content-default' }, children)
    }
  }

  // 已注册工具没有内容或格式化失败时，同样使用可展开的结构化展示。
  return h(DefaultToolResult, { args: tool.args, result: tool.result, error: tool.error, status: tool.status, toolName: tool.name })
}
