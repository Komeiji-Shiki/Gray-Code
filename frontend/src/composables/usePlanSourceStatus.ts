/**
 * MessageTaskCards 拆分：计划「来源工件」状态（up_to_date / mismatched / missing_source / untracked）
 * 的刷新与查询编排。
 *
 * 原实现内联在主组件里，此处整体搬出，函数体与原组件逐字一致，保证来源状态
 * 刷新（逐 plan 卡去重、逐条 IPC、失败容忍）与展示判断逻辑不变。
 */
import { ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'
import {
  normalizePlanSourceState,
  type PlanSourceState,
  type TaskCardItem
} from '@/components/message/messageTaskCards/taskCardTypes'

export function usePlanSourceStatus() {
  const planSourceStatusByPath = ref<Map<string, PlanSourceState>>(new Map())

  async function refreshPlanSourceStatuses(cards: TaskCardItem[]) {
    const next = new Map<string, PlanSourceState>()
    const uniquePlanCards = new Map<string, TaskCardItem>()

    for (const card of cards) {
      if (card.kind !== 'plan' || !card.path) continue
      if (!uniquePlanCards.has(card.path)) {
        uniquePlanCards.set(card.path, card)
      }
    }

    for (const [path, card] of uniquePlanCards.entries()) {
      try {
        const result = await sendToExtension<unknown>(MESSAGE_NAMES['plan.getSourceStatus'], {
          path,
          originalContent: card.content
        })
        next.set(path, normalizePlanSourceState(result))
      } catch (error) {
        console.error('[task-cards] Failed to load plan source status:', error)
      }
    }

    planSourceStatusByPath.value = next
  }

  function getPlanSourceState(card: TaskCardItem): PlanSourceState | null {
    if (card.kind !== 'plan' || !card.path) return null
    return planSourceStatusByPath.value.get(card.path) || null
  }

  function isPlanSourceBlocked(card: TaskCardItem): boolean {
    const state = getPlanSourceState(card)
    return !!state && (state.sourceStatus === 'mismatched' || state.sourceStatus === 'missing_source' || state.blocked === true)
  }

  function getPlanSourceLabel(card: TaskCardItem): string {
    const state = getPlanSourceState(card)
    if (!state) return ''

    if (state.sourceStatus === 'up_to_date') return t('components.message.tool.planCard.sourceUpToDate')
    if (state.sourceStatus === 'mismatched') return t('components.message.tool.planCard.sourceMismatched')
    if (state.sourceStatus === 'missing_source') return t('components.message.tool.planCard.sourceMissing')
    return t('components.message.tool.planCard.sourceUntracked')
  }

  function getPlanBlockedReason(card: TaskCardItem): string {
    const state = getPlanSourceState(card)
    if (!state) return ''
    if (typeof state.error === 'string' && state.error.trim()) return state.error
    if (state.sourceStatus === 'mismatched') return t('components.message.tool.planCard.sourceBlockedMismatched')
    if (state.sourceStatus === 'missing_source') return t('components.message.tool.planCard.sourceBlockedMissing')
    return ''
  }

  return {
    planSourceStatusByPath,
    refreshPlanSourceStatuses,
    getPlanSourceState,
    isPlanSourceBlocked,
    getPlanSourceLabel,
    getPlanBlockedReason
  }
}
