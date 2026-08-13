<script setup lang="ts">
/**
 * MessageTaskCards - 在消息正文里显示 Design / Plan / Review / Progress 卡片
 *
 * 当前同时承载 design、plan、review 与 progress 的结果摘要展示。
 * 拆分后：工具结果提取 → messageTaskCards/taskEntries.ts；渠道/模式选择 →
 * useTaskCardChannels；计划来源状态 → usePlanSourceStatus。本组件只保留编排、
 * 卡片展示判断与执行/生成动作。
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { sendToExtension, saveState, showNotification, onExtensionCommand } from '@/utils/vscode'
import type { ToolUsage } from '../../types'
import ReviewTaskCard from './ReviewTaskCard.vue'
import ProgressTaskCard from './ProgressTaskCard.vue'
import { MarkdownRenderer, CustomScrollbar } from '../common'
import ModeSelector from '../input/ModeSelector.vue'
import ChannelSelector from '../input/ChannelSelector.vue'
import ModelSelector from '../input/ModelSelector.vue'
import { stripPlanSourceArtifactSection } from '../../utils/taskCards'
import { generateId } from '../../utils/format'
import { useChatStore } from '@/stores'
import { useI18n } from '../../i18n'
import {
  useTaskCardChannels,
  PLAN_EXECUTION_MODE_STATE_KEY,
  PLAN_GENERATION_MODE_STATE_KEY
} from '@/composables/useTaskCardChannels'
import { usePlanSourceStatus } from '@/composables/usePlanSourceStatus'
import { buildTaskCards } from './messageTaskCards/taskEntries'
import type { TaskCardItem, TaskCardKind } from './messageTaskCards/taskCardTypes'

const props = defineProps<{
  tools: ToolUsage[]
  messageModelVersion?: string
}>()

const chatStore = useChatStore()

let unsubscribeConfigChanged: (() => void) | null = null

const { t } = useI18n()

const {
  selectedChannelId,
  selectedPlanExecutionModeId,
  selectedPlanGenerationModeId,
  selectedModelId,
  modelOptions,
  isLoadingChannels,
  isLoadingModes,
  promptModeOptions,
  isLoadingModels,
  channelOptions,
  openModeSettings,
  getModeIdForKind,
  handleModeChange,
  loadPromptModes,
  loadChannels
} = useTaskCardChannels()

const {
  refreshPlanSourceStatuses,
  getPlanSourceState,
  isPlanSourceBlocked,
  getPlanSourceLabel,
  getPlanBlockedReason
} = usePlanSourceStatus()

const isExecutingPlan = ref(false)
const isGeneratingPlan = ref(false)
const expandedCards = ref<Set<string>>(new Set())
const autoOpenedCardKeys = ref<Set<string>>(new Set())

const isAnyTaskActionRunning = computed(() => isExecutingPlan.value || isGeneratingPlan.value)

function toggleCardExpand(key: string) {
  if (expandedCards.value.has(key)) {
    expandedCards.value.delete(key)
  } else {
    expandedCards.value.add(key)
  }
}

function isCardExpanded(key: string): boolean {
  return expandedCards.value.has(key)
}

function getCreateFallbackTitle(kind: TaskCardKind): string {
  if (kind === 'plan') return t('components.message.tool.createPlan.fallbackTitle')
  if (kind === 'design') return t('components.message.tool.createDesign.fallbackTitle')
  if (kind === 'progress') return t('components.message.tool.createProgress.fallbackTitle')
  return t('components.message.tool.createReview.fallbackTitle')
}

function getDocumentTitle(docContent: string, docPath: string, kind: TaskCardKind): string {
  const m = (docContent || '').match(/^\s*#\s+(.+)\s*$/m)
  if (m && m[1] && m[1].trim()) return m[1].trim()

  if (docPath) {
    const parts = docPath.replace(/\\/g, '/').split('/')
    const file = parts[parts.length - 1] || docPath
    return file.replace(/\.md$/i, '') || getCreateFallbackTitle(kind)
  }

  return getCreateFallbackTitle(kind)
}

function getOpenFileLabel(kind: TaskCardKind): string {
  return kind === 'plan'
    ? t('components.message.tool.planCard.openFile')
    : t('components.message.tool.designCard.openFile')
}

function getOpenFileFailedMessage(kind: TaskCardKind): string {
  return kind === 'plan'
    ? t('components.message.tool.planCard.openFileFailed')
    : t('components.message.tool.designCard.openFileFailed')
}

async function openDocFile(card: TaskCardItem) {
  if (!card?.path) return
  try {
    await sendToExtension(MESSAGE_NAMES.openWorkspaceFileAt, {
      path: card.path,
      highlight: false,
      preview: false
    })
  } catch (error) {
    console.error(getOpenFileFailedMessage(card.kind), error)
  }
}

function isCardActionCompleted(card: TaskCardItem): boolean {
  if (card.kind === 'plan' && isPlanSourceBlocked(card)) return false
  return card.isActionCompleted
}

function getCardActionTitle(card: TaskCardItem): string {
  if (card.kind === 'plan' && isPlanSourceBlocked(card)) {
    return getPlanBlockedReason(card)
  }
  return getActionText(card)
}

function getCardPreviewContent(card: TaskCardItem): string {
  if (card.kind !== 'plan') return card.content
  return stripPlanSourceArtifactSection(card.content)
}

function isCardActionRunning(kind: TaskCardKind): boolean {
  return kind === 'plan' ? isExecutingPlan.value : isGeneratingPlan.value
}

function getActionLabel(kind: TaskCardKind): string {
  return kind === 'plan'
    ? t('components.message.tool.planCard.executeLabel')
    : t('components.message.tool.designCard.generateLabel')
}

function getActionText(card: TaskCardItem): string {
  if (card.kind === 'plan') {
    if (isCardActionCompleted(card)) return t('components.message.tool.planCard.executed')
    if (isExecutingPlan.value) return t('components.message.tool.planCard.executing')
    return t('components.message.tool.planCard.executePlan')
  }

  if (isCardActionCompleted(card)) return t('components.message.tool.designCard.generated')
  if (isGeneratingPlan.value) return t('components.message.tool.designCard.generating')
  return t('components.message.tool.designCard.generatePlan')
}

function getActionIconClass(card: TaskCardItem): string {
  if (isCardActionCompleted(card)) return 'codicon-check'
  if (isCardActionRunning(card.kind)) return 'codicon-loading codicon-modifier-spin'
  return card.kind === 'plan' ? 'codicon-play' : 'codicon-arrow-right'
}

function isActionDisabled(card: TaskCardItem): boolean {
  const modeId = getModeIdForKind(card.kind)
  return (
    isAnyTaskActionRunning.value ||
    isCardActionCompleted(card) ||
    (card.kind === 'plan' && isPlanSourceBlocked(card)) ||
    !modeId ||
    !selectedChannelId.value ||
    !selectedModelId.value
  )
}

async function executePlan(card: TaskCardItem) {
  if (card.kind !== 'plan') return
  if (isExecutingPlan.value || isCardActionCompleted(card) || isPlanSourceBlocked(card) || !card.content.trim()) return

  isExecutingPlan.value = true
  try {
    const confirmResult = await sendToExtension<{
      success: boolean
      prompt: string
      planContent: string
      blocked?: boolean
      blockReason?: 'source_mismatched' | 'source_missing'
      sourceStatus?: 'up_to_date' | 'mismatched' | 'missing_source' | 'untracked'
      sourceArtifactType?: 'design' | 'review'
      sourcePath?: string
      error?: string
      approvalId?: string
      todos?: Array<{
        id: string
        content: string
        status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
      }>
    }>(MESSAGE_NAMES['plan.confirmExecution'], {
      path: card.path,
      originalContent: card.content,
      toolId: card.toolId,
      conversationId: chatStore.currentConversationId
    })

    if (!confirmResult?.success) {
      const message = String(confirmResult?.error || t('components.message.tool.planCard.executePlanFailed'))
      await showNotification(message, 'warning')
      await refreshPlanSourceStatuses(taskCards.value)
      return
    }

    const prompt = String(confirmResult?.prompt || '')
    const approvalId = typeof confirmResult?.approvalId === 'string'
      ? confirmResult.approvalId.trim()
      : ''
    if (!approvalId) {
      await showNotification(t('components.message.tool.planCard.executePlanFailed'), 'warning')
      return
    }
    const latestPlanContent = confirmResult?.planContent || card.content
    const todosFromPlan = Array.isArray(confirmResult?.todos) ? confirmResult.todos : []

    // 确认执行后，切换到用户选择的模式，确保后续请求按目标模式运行
    try {
      const targetModeId = String(selectedPlanExecutionModeId.value || 'code').trim() || 'code'
      await chatStore.setCurrentPromptModeId(targetModeId)
      saveState(PLAN_EXECUTION_MODE_STATE_KEY, targetModeId)
    } catch (modeError) {
      // 模式切换失败不阻塞执行
      console.error('[plan] Failed to switch prompt mode before execution:', modeError)
    }

    // 启动 Build 顶部卡片（Cursor-like）
    await chatStore.setActiveBuild({
      id: generateId(),
      conversationId: chatStore.currentConversationId || '',
      title: getDocumentTitle(latestPlanContent, card.path, 'plan'),
      planContent: latestPlanContent,
      planPath: card.path,
      channelId: selectedChannelId.value || undefined,
      modelId: selectedModelId.value || undefined,
      startedAt: Date.now(),
      status: 'running'
    })

    // 不创建新的可见 user 消息：把确认信息追加到对应工具的 functionResponse 字段里再继续对话
    const ok = await chatStore.sendMessage('', undefined, {
      configIdOverride: selectedChannelId.value || undefined,
      modelOverride: selectedModelId.value || undefined,
      hidden: {
          functionResponse: {
            approvalId,
            id: card.toolId,
            name: card.toolName,
            response: {
              continuationApproved: true,
              continuationIntent: 'implement_now',
              sourceArtifactType: 'plan',
              sourcePath: card.path,
              sourceContent: latestPlanContent,
              continuationPrompt: prompt,
              planPath: card.path,
              planContent: latestPlanContent,
              planExecutionPrompt: prompt,
              todos: todosFromPlan
            }
          }
        }
      })

    // 隐藏发送被拒绝（如主会话流仍活跃）时提示用户，确认未被投递
    if (!ok) {
      await showNotification(t('components.message.tool.planCard.executePlanFailed'), 'warning')
      // 发送被拒绝说明 Build 从未真正启动：回收 activeBuild（setActiveBuild(null) 清除卡片），
      // 避免残留 running 状态的 Build 卡片被 useBuildPanel 的 isWaitingForResponse 定稿 watcher
      // 误标为 done（Build 未执行却显示已完成）
      await chatStore.setActiveBuild(null)
      return
    }
  } catch (error) {
    console.error(t('components.message.tool.planCard.executePlanFailed'), error)
  } finally {
    isExecutingPlan.value = false
  }
}

async function generatePlan(card: TaskCardItem) {
  if (card.kind !== 'design') return
  if (isGeneratingPlan.value || isCardActionCompleted(card) || !card.content.trim()) return

  isGeneratingPlan.value = true
  try {
    const confirmResult = await sendToExtension<{
      success: boolean
      prompt: string
      approvalId?: string
      designContent: string
      designPath: string
      error?: string
    }>(MESSAGE_NAMES['design.confirmPlanGeneration'], {
      path: card.path,
      originalContent: card.content,
      toolId: card.toolId,
      conversationId: chatStore.currentConversationId
    })

    if (!confirmResult?.success) {
      await showNotification(String(confirmResult?.error || t('components.message.tool.designCard.generatePlanFailed')), 'warning')
      return
    }

    const prompt = String(confirmResult?.prompt || '')
    const approvalId = typeof confirmResult?.approvalId === 'string'
      ? confirmResult.approvalId.trim()
      : ''
    if (!approvalId) {
      await showNotification(t('components.message.tool.designCard.generatePlanFailed'), 'warning')
      return
    }
    const latestDesignContent = confirmResult?.designContent || card.content
    const latestDesignPath = String(confirmResult?.designPath || card.path || '')

    // 生成计划前，切换到用户选择的目标模式，默认优先 plan
    try {
      const targetModeId = String(selectedPlanGenerationModeId.value || 'plan').trim() || 'plan'
      await chatStore.setCurrentPromptModeId(targetModeId)
      saveState(PLAN_GENERATION_MODE_STATE_KEY, targetModeId)
    } catch (modeError) {
      // 模式切换失败不阻塞继续对话
      console.error('[design] Failed to switch prompt mode before plan generation:', modeError)
    }

    // 不创建新的可见 user 消息：把确认信息追加到对应工具的 functionResponse 字段里再继续对话
    const ok = await chatStore.sendMessage('', undefined, {
      configIdOverride: selectedChannelId.value || undefined,
      modelOverride: selectedModelId.value || undefined,
      hidden: {
          functionResponse: {
            approvalId,
            id: card.toolId,
            name: card.toolName,
            response: {
              continuationApproved: true,
              continuationIntent: 'generate_plan_now',
              sourceArtifactType: 'design',
              sourcePath: latestDesignPath,
              sourceContent: latestDesignContent,
              continuationPrompt: prompt,
              planGenerationPrompt: prompt,
              designPath: latestDesignPath,
              designContent: latestDesignContent
            }
          }
        }
      })

    // 隐藏发送被拒绝（如主会话流仍活跃）时提示用户，确认未被投递
    if (!ok) {
      await showNotification(t('components.message.tool.designCard.generatePlanFailed'), 'warning')
      return
    }
  } catch (error) {
    console.error(t('components.message.tool.designCard.generatePlanFailed'), error)
  } finally {
    isGeneratingPlan.value = false
  }
}

async function generatePlanFromReview(card: TaskCardItem) {
  if (card.kind !== 'review') return
  if (isGeneratingPlan.value || isCardActionCompleted(card) || !card.content.trim()) return

  isGeneratingPlan.value = true
  try {
    const confirmResult = await sendToExtension<{
      success: boolean
      prompt: string
      approvalId?: string
      reviewContent: string
      reviewPath: string
      error?: string
    }>(MESSAGE_NAMES['review.confirmPlanGeneration'], {
      path: card.path,
      originalContent: card.content,
      toolId: card.toolId,
      conversationId: chatStore.currentConversationId
    })

    if (!confirmResult?.success) {
      await showNotification(String(confirmResult?.error || t('components.message.tool.reviewCard.generatePlanFailed')), 'warning')
      return
    }

    const prompt = String(confirmResult?.prompt || '')
    const approvalId = typeof confirmResult?.approvalId === 'string'
      ? confirmResult.approvalId.trim()
      : ''
    if (!approvalId) {
      await showNotification(t('components.message.tool.reviewCard.generatePlanFailed'), 'warning')
      return
    }
    const latestReviewContent = confirmResult?.reviewContent || card.content
    const latestReviewPath = String(confirmResult?.reviewPath || card.path || '')

    try {
      const targetModeId = String(selectedPlanGenerationModeId.value || 'plan').trim() || 'plan'
      await chatStore.setCurrentPromptModeId(targetModeId)
      saveState(PLAN_GENERATION_MODE_STATE_KEY, targetModeId)
    } catch (modeError) {
      console.error('[review] Failed to switch prompt mode before plan generation:', modeError)
    }

    const ok = await chatStore.sendMessage('', undefined, {
      configIdOverride: selectedChannelId.value || undefined,
      modelOverride: selectedModelId.value || undefined,
      hidden: {
          functionResponse: {
            approvalId,
            id: card.toolId,
            name: card.toolName,
            response: {
              continuationApproved: true,
              continuationIntent: 'generate_plan_now',
              sourceArtifactType: 'review',
              sourcePath: latestReviewPath,
              sourceContent: latestReviewContent,
              continuationPrompt: prompt,
              planGenerationPrompt: prompt,
              reviewPath: latestReviewPath,
              reviewContent: latestReviewContent
            }
          }
        }
      })

    // 隐藏发送被拒绝（如主会话流仍活跃）时提示用户，确认未被投递
    if (!ok) {
      await showNotification(t('components.message.tool.reviewCard.generatePlanFailed'), 'warning')
      return
    }
  } catch (error) {
    console.error(t('components.message.tool.reviewCard.generatePlanFailed'), error)
  } finally {
    isGeneratingPlan.value = false
  }
}

function handleCardAction(card: TaskCardItem) {
  if (card.kind === 'plan') {
    void executePlan(card)
    return
  }

  void generatePlan(card)
}

async function autoOpenPendingCardTabs(cards: TaskCardItem[]) {
  for (const card of cards) {
    if (!card?.path) continue
    if (card.kind === 'review' || card.kind === 'progress') continue
    if (isCardActionCompleted(card)) continue
    if (card.status === 'error') continue
    if (autoOpenedCardKeys.value.has(card.key)) continue

    autoOpenedCardKeys.value.add(card.key)
    try {
      await sendToExtension(MESSAGE_NAMES.openWorkspaceFileAt, {
        path: card.path,
        highlight: false
      })
    } catch (error) {
      console.error(getOpenFileFailedMessage(card.kind), error)
    }
  }
}

onMounted(() => {
  loadChannels()
  void loadPromptModes()
  void refreshPlanSourceStatuses(taskCards.value)
  void autoOpenPendingCardTabs(taskCards.value)

  // 设置面板中渠道/模型变更后刷新（新增模型无需重启扩展即可在下拉框看到）
  unsubscribeConfigChanged = onExtensionCommand('channels.configChanged', () => {
    loadChannels()
  })
})

onBeforeUnmount(() => {
  if (unsubscribeConfigChanged) unsubscribeConfigChanged()
})

const taskCards = computed<TaskCardItem[]>(() =>
  buildTaskCards(
    props.tools,
    (toolCallId) => chatStore.getToolResponseById(toolCallId),
    getDocumentTitle
  )
)

watch(
  () => taskCards.value,
  (cards) => {
    void refreshPlanSourceStatuses(cards)
    void autoOpenPendingCardTabs(cards)
  }
)

const hasAny = computed(() => taskCards.value.length > 0)
</script>

<template>
  <div v-if="hasAny" class="message-taskcards">
    <template v-for="c in taskCards" :key="c.key">
      <ReviewTaskCard
        v-if="c.kind === 'review' && c.reviewCardData"
        :card="c.reviewCardData"
        :plan-generation-enabled="!c.isActionCompleted && !!c.path && !!c.content && c.reviewCardData?.status === 'completed'"
        :plan-generation-completed="c.isActionCompleted"
        :is-generating-plan="isGeneratingPlan"
        :content="c.content"
        :status="c.status"
        @generate-plan="generatePlanFromReview(c)"
      />
      <ProgressTaskCard
        v-else-if="c.kind === 'progress' && c.progressCardData"
        :card="c.progressCardData"
        :error="c.error"
        :warnings="c.warnings"
        :content="c.content"
        :status="c.status"
      />
      <div v-else class="task-panel">
      <div class="task-header">
        <div class="task-info">
          <span
            :class="[
              'codicon',
              c.kind === 'plan' ? 'codicon-list-unordered' : 'codicon-lightbulb',
              'task-icon',
              c.kind
            ]"
          ></span>
          <span class="task-title">{{ c.title }}</span>
          <span v-if="c.status === 'success'" class="task-status success">
            <span class="codicon codicon-check"></span>
          </span>
          <span v-else-if="c.status === 'running'" class="task-status running">
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
          </span>
          <span v-else-if="c.status === 'error'" class="task-status error">
            <span class="codicon codicon-error"></span>
          </span>
        </div>
        <div class="task-actions">
          <button
            class="action-btn"
            :title="getOpenFileLabel(c.kind)"
            :disabled="!c.path"
            @click="openDocFile(c)"
          >
            <span class="codicon codicon-go-to-file"></span>
          </button>
          <button
            class="action-btn"
            :title="isCardExpanded(c.key) ? t('common.collapse') : t('common.expand')"
            @click="toggleCardExpand(c.key)"
          >
            <span :class="['codicon', isCardExpanded(c.key) ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
          </button>
        </div>
      </div>

      <div class="task-path">{{ c.path }}</div>

      <div
        v-if="c.kind === 'plan' && getPlanSourceLabel(c)"
        :class="['task-source', `status-${getPlanSourceState(c)?.sourceStatus || 'untracked'}`]"
        :title="getPlanBlockedReason(c) || getPlanSourceLabel(c)"
      >
        {{ getPlanSourceLabel(c) }}
      </div>

      <div class="task-content">
        <CustomScrollbar :max-height="isCardExpanded(c.key) ? 500 : 200">
          <div class="task-preview">
            <MarkdownRenderer :content="getCardPreviewContent(c)" render-profile="artifactSafe" />
          </div>
        </CustomScrollbar>
      </div>

      <div class="task-footer">
        <div class="task-selector">
          <span class="task-label">{{ getActionLabel(c.kind) }}</span>
          <ModeSelector
            :model-value="getModeIdForKind(c.kind)"
            :options="promptModeOptions"
            :drop-up="true"
            :disabled="isLoadingModes || isAnyTaskActionRunning"
            class="mode-select"
            @update:model-value="(value) => handleModeChange(c.kind, value)"
            @open-settings="openModeSettings"
          />
          <ChannelSelector
            v-model="selectedChannelId"
            :options="channelOptions"
            :disabled="isLoadingChannels || isAnyTaskActionRunning"
            class="channel-select"
          />
          <ModelSelector
            v-model="selectedModelId"
            :models="modelOptions"
            :disabled="isLoadingChannels || isLoadingModels || isAnyTaskActionRunning || !selectedChannelId"
            class="model-select"
          />
        </div>
        <button
          class="task-btn"
          :class="{ done: isCardActionCompleted(c) }"
          :disabled="isActionDisabled(c)"
          :title="getCardActionTitle(c)"
          @click="handleCardAction(c)"
        >
          <span :class="['codicon', getActionIconClass(c)]"></span>
          <span class="btn-text">{{ getActionText(c) }}</span>
        </button>
      </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.message-taskcards {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
  margin: 8px 0 10px;
}

.task-panel {
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
}

.task-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border);
}

.task-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  flex: 1;
  min-width: 0;
}

.task-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.task-icon.plan {
  color: var(--vscode-charts-blue, #3794ff);
}

.task-icon.design {
  color: var(--vscode-charts-yellow, #d7ba7d);
}

.task-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-status {
  font-size: 12px;
  margin-left: var(--spacing-xs, 4px);
}

.task-status.success { color: var(--vscode-testing-iconPassed); }
.task-status.running { color: var(--vscode-charts-blue); }
.task-status.error { color: var(--vscode-testing-iconFailed); }

.task-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 2px);
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: all var(--transition-fast, 0.1s);
}

.action-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn:disabled:hover {
  background: transparent;
  color: var(--vscode-descriptionForeground);
}

.task-path {
  padding: 2px var(--spacing-sm, 8px);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-source {
  padding: 4px var(--spacing-sm, 8px);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.task-source.status-up_to_date {
  color: var(--vscode-testing-iconPassed, #73c991);
}

.task-source.status-untracked {
  color: var(--vscode-descriptionForeground);
}

.task-source.status-mismatched,
.task-source.status-missing_source {
  color: var(--vscode-testing-iconFailed, #f48771);
}

.task-source.status-mismatched {
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-inputValidation-errorBackground, #5a1d1d) 18%);
}

.task-source.status-missing_source {
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-inputValidation-warningBackground, #4d2d00) 18%);
}

.task-content {
  background: var(--vscode-editor-background);
}

.task-preview {
  padding: var(--spacing-sm, 8px);
}

.task-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
  border-top: 1px solid var(--vscode-panel-border);
}

.task-selector {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  flex: 1;
  min-width: 0;
}

.task-label {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

.mode-select {
  flex: 0 0 auto;
  min-width: 100px;
}

.channel-select {
  flex: 1;
  min-width: 120px;
  max-width: 180px;
}

.model-select {
  flex: 1;
  min-width: 120px;
  max-width: 220px;
}

.task-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: 4px 10px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: var(--radius-sm, 2px);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.1s;
  white-space: nowrap;
}

.task-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.task-btn.done {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  opacity: 0.85;
}

.task-btn.done:hover:not(:disabled) {
  background: var(--vscode-button-secondaryBackground);
}

.task-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.task-btn.done:disabled {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  opacity: 0.7;
}

.btn-text {
  font-size: 11px;
}

.task-footer :deep(.model-trigger) {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 4px 8px;
}

.task-footer :deep(.model-trigger:hover:not(:disabled)) {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.task-footer :deep(.model-selector.open .model-trigger) {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}
</style>
