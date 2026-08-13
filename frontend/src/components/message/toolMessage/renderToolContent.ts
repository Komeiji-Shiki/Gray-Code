import { h, type Component, type VNode } from 'vue'
import type { ToolUsage } from '../../../types'
import { getToolConfig } from '../../../utils/toolRegistry'
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
 * 渲染工具详细内容（自定义组件 / contentFormatter / 默认 JSON 展示）。
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
      // formatter 崩溃时降级到默认 JSON 展示，避免整个工具块渲染失败
      content = null
    }

    // formatter 正常返回非空内容：按原有结构展示；否则落到下方默认 JSON 展示
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

  // 默认显示：参数和结果的 JSON
  return h('div', { class: 'tool-content-default' }, [
    tool.args && h('div', { class: 'content-section' }, [
      h('div', { class: 'section-label' }, t('components.message.tool.parameters') + ':'),
      h('pre', { class: 'section-data' }, JSON.stringify(tool.args, null, 2))
    ]),
    tool.result && h('div', { class: 'content-section' }, [
      h('div', { class: 'section-label' }, t('components.message.tool.result') + ':'),
      h('pre', { class: 'section-data' }, JSON.stringify(tool.result, null, 2))
    ]),
    tool.error && h('div', { class: 'content-section error-section' }, [
      h('div', { class: 'section-label' }, t('components.message.tool.error') + ':'),
      h('div', { class: 'error-message' }, tool.error)
    ])
  ])
}
