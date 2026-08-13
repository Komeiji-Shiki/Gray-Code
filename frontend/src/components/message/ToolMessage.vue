<script setup lang="ts">
/**
 * ToolMessage - 工具调用消息组件（重新设计）
 *
 * 功能：
 * 1. 显示工具名称在标题栏
 * 2. 显示描述（参数摘要）
 * 3. 可展开/收起详细内容
 * 4. 支持自定义内容面板组件
 * 5. 通过工具 ID 从 store 获取响应结果
 *
 * F-07 拆分后职责：保留确认流、diff 孤儿检测、工具响应增强、展开状态等
 * 状态与副作用；单张工具卡的展示下放到 toolMessage/ToolItem.vue，
 * diff 操作栏下放到 toolMessage/DiffActionList.vue，工具内容渲染逻辑
 * 抽到 toolMessage/renderToolContent.ts。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, watchEffect, watch, nextTick, defineComponent, type PropType, type ComponentPublicInstance } from 'vue'
import type { ToolUsage } from '../../types'
import { getToolConfig } from '../../utils/toolRegistry'
import { ensureMcpToolRegistered } from '../../utils/tools'
import { useChatStore } from '../../stores'
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore'
import { sendToExtension } from '../../utils/vscode'
import { useI18n } from '../../i18n'
import { generateId, decodeUnicodeEscapes } from '../../utils/format'
import { shouldShowToolArgumentPreview } from './toolPreviewPolicy'
import { computeTaskCardStatus } from '../../utils/tools/subagents/backgroundStatus'
import {
  diffGuardWarnings,
  ensureDiffReviewControllerInitialized,
  getDiffActionError,
  getDiffAutoSaveProgress,
  getDiffAutoSaveTimeLeft,
  getPendingDiffSessions,
  hasPendingDiffSession,
  isDiffSessionProcessing,
  persistedDiffGuardWarnings,
  seenDiffToolIds
} from './diffReviewController'
import { renderToolContent } from './toolMessage/renderToolContent'
import type { PendingDiffView } from './toolMessage/types'
import ToolItem from './toolMessage/ToolItem.vue'

const { t } = useI18n()

const props = defineProps<{
  tools: ToolUsage[]
  messageBackendIndex?: number
}>()

const chatStore = useChatStore()
const backgroundTaskStore = useBackgroundTaskStore()

const DIFF_SUPPORTED_TOOLS = ['apply_diff', 'write_file', 'search_in_files', 'insert_code', 'delete_code']
const pendingDiffOrphanedAt = ref<Map<string, number>>(new Map())
const DIFF_ORPHAN_GRACE_MS = 800
const orphanCheckTick = ref(0)

const pendingDiffViewsByToolId = computed<Map<string, PendingDiffView[]>>(() => {
  const views = new Map<string, PendingDiffView[]>()
  for (const tool of enhancedTools.value) {
    views.set(tool.id, getPendingDiffSessions(tool.id).map((session) => ({
      ...session,
      progress: getDiffAutoSaveProgress(session),
      timeLeft: getDiffAutoSaveTimeLeft(session),
      isPreparing: !session.writeReady,
      isProcessing: isDiffSessionProcessing(session.id),
      error: getDiffActionError(session.id)
    })))
  }
  return views
})

function extractPendingDiffIdsFromResultData(data: any): string[] {
  const pendingDiffIds = new Set<string>()
  if (typeof data?.pendingDiffId === 'string' && data.pendingDiffId) {
    pendingDiffIds.add(data.pendingDiffId)
  }
  for (const key of ['results', 'replacements']) {
    if (!Array.isArray(data?.[key])) continue
    for (const item of data[key]) {
      if (typeof item?.pendingDiffId === 'string' && item.pendingDiffId) {
        pendingDiffIds.add(item.pendingDiffId)
      }
    }
  }
  return Array.from(pendingDiffIds)
}

function isDiffToolPending(tool: ToolUsage): boolean {
  if (!DIFF_SUPPORTED_TOOLS.includes(tool.name)) return false
  if (tool.name === 'search_in_files' && (tool.args as Record<string, unknown>)?.mode !== 'replace') {
    return false
  }
  if (getPendingDiffSessions(tool.id).length > 0) return true

  const resultData = tool.result?.data as any
  return !!resultData && extractPendingDiffIdsFromResultData(resultData).some(hasPendingDiffSession)
}

// 整个聊天页面共享一个 Diff 状态订阅与倒计时；重复组件只复用初始化 Promise。
void ensureDiffReviewControllerInitialized()

// ---------------------------

// 确保 MCP 工具已注册
watchEffect(() => {
  for (const tool of props.tools) {
    ensureMcpToolRegistered(tool.name)
  }
})

const processingToolIds = ref<Set<string>>(new Set())

// 增强后的工具列表，包含从 store 获取的响应
const enhancedTools = computed<ToolUsage[]>(() => {
  // 读取孤儿重估触发器（#59 修复），确保宽限期届满时 computed 重新求值
  void orphanCheckTick.value

  return props.tools.map((tool) => {
    const isDiffTool = DIFF_SUPPORTED_TOOLS.includes(tool.name)
    let isDiffApplicable = true
    if (tool.name === 'search_in_files') {
      const args = tool.args as Record<string, unknown>
      const mode = args?.mode as string
      isDiffApplicable = mode === 'replace'
    }

    const activePendingDiff = isDiffTool && isDiffApplicable && isDiffToolPending(tool)

    // 获取响应结果
    let response: Record<string, unknown> | null | undefined = tool.result
    if (!response && tool.id) {
      response = chatStore.getToolResponseById(tool.id) as Record<string, unknown> | null
    }

    // 如果工具已经有结果或响应
    if (response) {
      // 优先从响应中获取错误
      const error = tool.error || (response as any).error
      let success = (response as any).success !== false && !error

      const data = (response as any).data

      if (activePendingDiff) {
        const isAnyDiffProcessing = getPendingDiffSessions(tool.id).some((pendingDiff) => isDiffSessionProcessing(pendingDiff.id))

        return {
          ...tool,
          result: response || undefined,
          error: undefined,
          status: isAnyDiffProcessing ? ('executing' as const) : ('awaiting_apply' as const),
          awaitingConfirmation: false
        }
      }

      // 前台 SubAgent 转后台后的合成响应不是失败：旧父回合被替换，但子代理仍在后台任务栏运行。
      if (tool.name === 'subagents' && (data as any)?.detached === true) {
        return {
          ...tool,
          result: response || undefined,
          error: undefined,
          status: 'background',
          awaitingConfirmation: false
        }
      }

      // 后台派发子代理（#58 修复）：按 backgroundTaskStore 中的真实任务状态推导头部图标
      if (tool.name === 'subagents' && (data as any)?.background === true) {
        const taskId = (data as any)?.taskId as string | undefined
        const bgStatus = computeTaskCardStatus(taskId, backgroundTaskStore.tasks, response as Record<string, unknown>)
        let bgMappedStatus: ToolUsage['status']
        switch (bgStatus) {
          case 'running': bgMappedStatus = 'executing'; break
          case 'completed': bgMappedStatus = 'success'; break
          case 'failed': case 'cancelled': bgMappedStatus = 'error'; break
          default: bgMappedStatus = 'executing'; break
        }
        const bgTask = taskId ? backgroundTaskStore.tasks[taskId] : undefined
        const bgError = bgStatus === 'failed' || bgStatus === 'cancelled'
          ? (bgTask?.error || tool.error || t('components.tools.cancelled'))
          : undefined
        return {
          ...tool,
          result: response || undefined,
          error: bgError,
          status: bgMappedStatus,
          awaitingConfirmation: false
        }
      }

      // 根据工具响应确定最终状态
      let status: ToolUsage['status'] = success ? 'success' : 'error'

      // 兼容：少数工具可能在 response.data.status 里返回 pending（一般用于“等待应用/审阅”）
      if (data?.status === 'pending') {
        status = 'awaiting_apply'
      }

      // 检查是否为部分成功 (针对 apply_diff 等工具)
      if (success && data && data.status !== 'pending' && (data.partial === true || data.status === 'partial' || (data.appliedCount > 0 && data.failedCount > 0))) {
        status = 'warning'
      }

      return {
        ...tool,
        result: response || undefined,
        error,
        status,
        // 向后兼容字段：尽量不用它来驱动 UI
        awaitingConfirmation: false
      }
    }

    // 如果正在处理确认/执行中的过渡态
    if (processingToolIds.value.has(tool.id)) {
      return { ...tool, status: 'executing' as const, awaitingConfirmation: false }
    }

    // 等待用户批准
    const awaitingConfirm = tool.status === 'awaiting_approval'

    // 没有找到响应，使用当前状态
    const effectiveStatus: ToolUsage['status'] = tool.status || 'queued'

    // 重要：diff 工具在后端被 cancel/reject 后，可能不会立刻返回 functionResponse（例如流被中断）。
    // 此时如果我们已经“见过”这个 diff 工具进入 pendingDiffs 列表，但现在列表里没有它，
    // 则说明 diff 已结束（多半是被取消），需要将 UI 状态从 running/pending 纠正为 error。
    if (
      isDiffTool &&
      isDiffApplicable &&
      seenDiffToolIds.value.has(tool.id) &&
      getPendingDiffSessions(tool.id).length === 0 &&
      (effectiveStatus === 'executing' || effectiveStatus === 'awaiting_apply')
    ) {
      // 孤儿宽限期判定：进入时间的记录与届满重估定时器由下方的
      // watch(syncPendingDiffOrphanState) 维护，computed 只做纯读（保持纯函数）。
      const existed = pendingDiffOrphanedAt.value.get(tool.id)
      const since = existed ?? Date.now()

      // 宽限期内保持原状态，避免 UI 闪烁（先 error 再 success）。
      if (Date.now() - since < DIFF_ORPHAN_GRACE_MS) {
        return { ...tool, status: effectiveStatus, awaitingConfirmation: false }
      }

      return {
        ...tool,
        status: 'error' as const,
        error: tool.error || t('components.tools.cancelled'),
        awaitingConfirmation: false
      }
    }

    // diff 工具：如果 diff 处于 pending（等待应用/审阅），将状态映射为 awaiting_apply
    if (activePendingDiff) {
      const isAnyDiffProcessing = getPendingDiffSessions(tool.id).some((pendingDiff) => isDiffSessionProcessing(pendingDiff.id))
      if (isAnyDiffProcessing) {
        return { ...tool, status: 'executing' as const, awaitingConfirmation: false }
      }

      return { ...tool, status: 'awaiting_apply' as const, awaitingConfirmation: false }
    }

    return { ...tool, status: effectiveStatus, awaitingConfirmation: awaitingConfirm }
  })
})

/**
 * 孤儿检测副作用（#59 修复，从 enhancedTools computed 中移出）：
 * 依据原始工具状态维护 pendingDiffOrphanedAt 记录，并在宽限期届满时安排重估定时器。
 * 幂等：已记录的 id 不重复记录；非孤儿候选（含已收到响应、状态离开 executing/awaiting_apply）
 * 时清理记录，与旧 computed 内联逻辑语义一致。
 */
function syncPendingDiffOrphanState(): void {
  const next = new Map(pendingDiffOrphanedAt.value)
  let changed = false

  for (const tool of props.tools) {
    const isDiffTool = DIFF_SUPPORTED_TOOLS.includes(tool.name)
    let isDiffApplicable = true
    if (tool.name === 'search_in_files') {
      const args = tool.args as Record<string, unknown>
      isDiffApplicable = args?.mode === 'replace'
    }

    // 与 computed 一致：已有响应时孤儿分支不会执行，无需维护记录
    const response = tool.result || (tool.id ? chatStore.getToolResponseById(tool.id) : undefined)
    if (response) continue

    const effectiveStatus = tool.status || 'queued'
    const isOrphanCandidate =
      isDiffTool &&
      isDiffApplicable &&
      seenDiffToolIds.value.has(tool.id) &&
      getPendingDiffSessions(tool.id).length === 0 &&
      (effectiveStatus === 'executing' || effectiveStatus === 'awaiting_apply')

    if (isOrphanCandidate) {
      if (!next.has(tool.id)) {
        next.set(tool.id, Date.now())
        changed = true
        // 安排宽限期届满后的重估（#59 修复）
        const capturedToolId = tool.id
        setTimeout(() => {
          if (pendingDiffOrphanedAt.value.has(capturedToolId)) {
            orphanCheckTick.value++
          }
        }, DIFF_ORPHAN_GRACE_MS)
      }
    } else if (next.has(tool.id)) {
      // 非 executing/awaiting_apply 场景，清理 orphan 记录
      next.delete(tool.id)
      changed = true
    }
  }

  if (changed) {
    pendingDiffOrphanedAt.value = next
  }
}

// 工具状态 / diff 会话视图变化时同步孤儿记录；pendingDiffViewsByToolId 覆盖
// 会话级（pending diff 增删、处理状态）变化，props.tools 覆盖原始状态变化。
watch([() => props.tools, pendingDiffViewsByToolId], syncPendingDiffOrphanState, { immediate: true })

// 正在处理确认的工具 ID 集合

function addProcessingToolId(toolId: string) {
  if (!toolId || processingToolIds.value.has(toolId)) return
  const next = new Set(processingToolIds.value)
  next.add(toolId)
  processingToolIds.value = next
}

function removeProcessingToolId(toolId: string) {
  if (!toolId || !processingToolIds.value.has(toolId)) return
  const next = new Set(processingToolIds.value)
  next.delete(toolId)
  processingToolIds.value = next
}

// 当后端把工具从 awaiting_approval 推进到 executing/success/error 后，清理本地“处理中”标记
watchEffect(() => {
  if (processingToolIds.value.size === 0) return

  const current = new Set(processingToolIds.value)
  let changed = false

  for (const id of current) {
    // 这里读取“原始工具状态”（props.tools），避免被 enhancedTools 的乐观 executing 状态误清理
    const rawTool = props.tools.find(x => x.id === id)
    const hasResponse = Boolean(rawTool?.result || rawTool?.error || chatStore.getToolResponseById(id))
    const stillAwaitingApproval = rawTool?.status === 'awaiting_approval'

    if (!rawTool || !stillAwaitingApproval || hasResponse) {
      current.delete(id)
      changed = true
    }
  }

  if (changed) {
    processingToolIds.value = current
  }
})

// 确认工具执行（立即提交到后端）
async function confirmToolExecution(toolId: string, toolName: string) {
  await submitToolDecision(toolId, toolName, true)
}

// 拒绝工具执行（立即提交到后端）
async function rejectToolExecution(toolId: string, toolName: string) {
  await submitToolDecision(toolId, toolName, false)
}

async function submitToolDecision(toolId: string, toolName: string, confirmed: boolean) {
  if (!toolId || processingToolIds.value.has(toolId)) return
  const currentTool = props.tools.find(t => t.id === toolId)
  if (!currentTool || currentTool.status !== 'awaiting_approval') return

  // 标记为正在处理（注意：Set 变更需替换引用才能触发响应式更新）
  addProcessingToolId(toolId)

  const sent = await sendToolConfirmation([
    { id: toolId, name: toolName, confirmed }
  ])
  if (!sent) {
    removeProcessingToolId(toolId)
  }
}

// 发送工具确认响应到后端
async function sendToolConfirmation(
  toolResponses: Array<{ id: string; name: string; confirmed: boolean }>
): Promise<boolean> {
  try {
    const currentConversationId = chatStore.currentConversationId
    const currentConfig = chatStore.currentConfig
    // 本回合一次性渠道覆盖（Plan 等场景）优先，其次才是全局渠道
    const confirmationConfigId = chatStore.pendingConfigIdOverride || currentConfig?.id || ''

    if (!currentConversationId || !confirmationConfigId) {
      console.error('No conversation or config ID')
      return false
    }

    // 为本次工具确认流绑定 streamId，避免流式过滤器把后端返回的 chunk 当作“未知流”丢弃
    const streamId = generateId()
    chatStore.beginToolConfirmationRound({
      conversationId: currentConversationId,
      configId: confirmationConfigId,
      modelOverride: chatStore.pendingModelOverride || undefined,
      promptModeId: chatStore.currentPromptModeId,
      streamId
    })

    await sendToExtension(MESSAGE_NAMES.toolConfirmation, {
      conversationId: currentConversationId,
      configId: confirmationConfigId,
      modelOverride: chatStore.pendingModelOverride || undefined,
      toolResponses,
      streamId,
      promptModeId: chatStore.currentPromptModeId
    })
    return true
  } catch (error) {
    console.error('Failed to send tool confirmation:', error)

    // 请求未发出时回滚 stream 绑定，避免阻塞后续有效流
    chatStore.abortToolConfirmationRound()
    return false
  }
}

// 展开状态
const expandedTools = ref<Set<string>>(new Set())

// 切换展开/收起
function toggleExpand(toolId: string) {
  if (expandedTools.value.has(toolId)) {
    expandedTools.value.delete(toolId)
  } else {
    expandedTools.value.add(toolId)
  }
}

// 检查是否已展开
function isExpanded(toolId: string): boolean {
  return expandedTools.value.has(toolId)
}

// 检查工具是否可展开
function isExpandable(tool: ToolUsage): boolean {
  const config = getToolConfig(tool.name)
  // 默认可展开，除非显式设置为 false
  return config?.expandable !== false
}

function shouldShowToolContent(tool: ToolUsage): boolean {
  return isExpandable(tool) && isExpanded(tool.id)
}

// 获取 diff 警戒值警告（优先使用实时 pending 数据，其次使用工具结果中的兜底数据）
function getDiffGuardWarning(tool: ToolUsage): { warning: string; deletePercent: number } | null {
  const realtime = diffGuardWarnings.value.get(tool.id)
  if (realtime?.warning) {
    return realtime
  }
  const persisted = persistedDiffGuardWarnings.value.get(tool.id)
  if (persisted?.warning) {
    return persisted
  }

  const data = (tool.result as any)?.data
  if (data?.diffGuardWarning) {
    return {
      warning: String(data.diffGuardWarning),
      deletePercent: Number(data.diffGuardDeletePercent ?? 0)
    }
  }
  return null
}

// --- 流式预览 ---

// 判断是否应显示流式参数预览
function shouldShowStreamingPreview(tool: ToolUsage): boolean {
  // 修改原因：流式提前执行会把工具执行态推进到 executing，但参数输入快照可能仍以 partialArgs 形式存在。
  // 修改方式：委托 toolPreviewPolicy 按“仍处于非终态且存在 partialArgs”判断，而不是只接受 streaming。
  // 修改目的：工具开始执行后仍能保留参数预览，直到最终 args 快照替换 partialArgs。
  return shouldShowToolArgumentPreview(tool)
}

// 流式参数预览文本：对模型以 ASCII-safe 形式输出的 \uXXXX 转义做实时解码，
// 否则中文参数在预览阶段会显示为满屏 \u4e2d\u6587 转义序列。
// 解码只影响展示；实际 partialArgs 保持原样，最终仍由 JSON.parse 权威解析。
function getStreamingPreviewText(tool: ToolUsage): string {
  return decodeUnicodeEscapes(tool.partialArgs || '')
}

// 流式预览元素引用（用于自动滚动到底部）
const streamingPreviewRefs = new Map<string, HTMLElement>()

function setStreamingPreviewRef(toolId: string) {
  return (ref: Element | ComponentPublicInstance | null) => {
    if (ref && ref instanceof HTMLElement) {
      streamingPreviewRefs.set(toolId, ref)
    } else {
      streamingPreviewRefs.delete(toolId)
    }
  }
}

// 监听 partialArgs 变化，自动滚动流式预览到底部
watch(
  () => props.tools.map(t => t.partialArgs?.length ?? 0),
  () => {
    nextTick(() => {
      for (const tool of enhancedTools.value) {
        if (shouldShowStreamingPreview(tool)) {
          const el = streamingPreviewRefs.get(tool.id)
          if (el) {
            el.scrollTop = el.scrollHeight
          }
        }
      }
    })
  }
)

/**
 * 身份稳定的宿主组件（#56 修复）。
 *
 * 原先模板使用内联箭头函数 `<component :is="() => renderToolContent(tool)">`，
 * 每次渲染都换新 vnode type，导致已展开的面板被整棵卸载重建。
 * ToolContentHost 通过 defineComponent + props 保持 vnode type 恒定，
 * 重渲染仅走 props patch 而非 unmount/remount。
 */
const ToolContentHost = defineComponent({
  props: {
    tool: { type: Object as PropType<ToolUsage>, required: true }
  },
  setup(hostProps) {
    return () => renderToolContent(hostProps.tool, props.messageBackendIndex, t)
  }
})
</script>

<template>
  <div class="tool-message">
    <ToolItem
      v-for="tool in enhancedTools"
      :key="tool.id"
      :tool="tool"
      :is-expanded="isExpanded(tool.id)"
      :is-expandable="isExpandable(tool)"
      :show-content="shouldShowToolContent(tool)"
      :is-processing="processingToolIds.has(tool.id)"
      :show-streaming-preview="shouldShowStreamingPreview(tool)"
      :streaming-preview-text="getStreamingPreviewText(tool)"
      :pending-diffs="pendingDiffViewsByToolId.get(tool.id) || []"
      :diff-guard-warning="getDiffGuardWarning(tool)"
      :content-host="ToolContentHost"
      :register-streaming-preview-ref="setStreamingPreviewRef(tool.id)"
      @toggle="toggleExpand(tool.id)"
      @confirm="confirmToolExecution(tool.id, tool.name)"
      @reject="rejectToolExecution(tool.id, tool.name)"
    />
  </div>
</template>

<style scoped>
.tool-message {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}
</style>
