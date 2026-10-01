<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@/composables'
import { TaskCard, MarkdownRenderer, CustomScrollbar } from '../../common'
import { extractPreviewText, formatSubAgentRuntimeBadge } from '../../../utils/taskCards'
import { useBackgroundTaskStore } from '../../../stores/backgroundTaskStore'
import { computeTaskCardStatus } from '../../../utils/tools/subagents/backgroundStatus'
import ToolResultValue from '../common/ToolResultValue.vue'

const { t } = useI18n()
const backgroundStore = useBackgroundTaskStore()

const props = defineProps<{
  toolId?: string
  args: Record<string, unknown>
  result?: Record<string, unknown>
}>()

const agentName = computed(() => (props.args.agentName as string) || ((props.result as any)?.data?.agentName as string) || 'Sub-Agent')
const prompt = computed(() => (props.args.prompt as string) || '')
const context = computed(() => (props.args.context as string) || '')
const invocationOptions = computed(() => Object.fromEntries(Object.entries(props.args).filter(([key]) => key !== 'prompt' && key !== 'context')))

const resultData = computed(() => ((props.result as any)?.data || {}) as any)

// 修改原因：background=true 时工具立即返回的只是「已派发」的 stub，里面没有任何执行结果；
//          卡片过去直接按 result.success 判定，导致子代理刚入队就显示为绿色成功，跑完后也永远看不到产出。
// 修改方式：后台派发的卡片改为跟随 backgroundTaskStore 中该 taskId 的真实任务状态与结果。
// 修改目的：卡片状态反映子代理真实进展，而不是「派发动作成功」。
const isBackground = computed(() => resultData.value.background === true)
const backgroundTask = computed(() => {
  const taskId = resultData.value.taskId as string | undefined
  return taskId ? backgroundStore.tasks[taskId] : undefined
})

const responseText = computed(() => {
  const direct = (resultData.value.response || resultData.value.partialResponse || '') as string
  if (direct) return direct
  return isBackground.value ? (backgroundTask.value?.response || '') : ''
})

const errorMessage = computed(() => {
  const direct = (props.result as any)?.error as string | undefined
  if (direct) return direct
  return isBackground.value ? backgroundTask.value?.error : undefined
})

const cardStatus = computed<'pending' | 'running' | 'success' | 'error'>(() => {
  const r = props.result as any
  if (!r) return 'running'

  if (isBackground.value) {
    const taskId = resultData.value.taskId as string | undefined
    const status = computeTaskCardStatus(taskId, backgroundStore.tasks, r as Record<string, unknown>)
    switch (status) {
      case 'running': return 'running'
      case 'completed': return 'success'
      case 'failed': case 'cancelled': return 'error'
    }
  }

  return r.success === true ? 'success' : 'error'
})

const runtimeBadge = computed(() => {
  const channelName = resultData.value.channelName as string | undefined
  const modelId = resultData.value.modelId as string | undefined
  if (!channelName) return ''
  return formatSubAgentRuntimeBadge({ channelName, modelId })
})

const chips = computed(() => {
  const list: string[] = []
  const steps = resultData.value.steps ?? (isBackground.value ? backgroundTask.value?.steps : undefined)
  if (typeof steps === 'number' && steps > 0) list.push(t('components.tools.subagents.steps', { count: steps }))
  // 子代理工具使用标记：同步调用取 result.data.toolsUsed，后台取任务回执
  const toolsUsed = resultData.value.toolsUsed ?? (isBackground.value ? (backgroundTask.value as any)?.toolsUsed : undefined)
  if (Array.isArray(toolsUsed)) {
    if (toolsUsed.length > 0) {
      list.push(t('components.tools.subagents.toolsUsed', { tools: toolsUsed.join(', ') }))
    } else {
      // 空数组 = 子代理未调用任何工具（中性陈述，不作任何定性判断）
      list.push(t('components.tools.subagents.noTools'))
    }
  }
  // 后台派发的子代理在卡片上标明「后台」，避免与同步执行的调用混淆
  if (isBackground.value) list.push(t('components.tools.subagents.background'))
  return list
})

const preview = computed(() => extractPreviewText(responseText.value, { maxLines: 10, maxChars: 1200 }))
</script>

<template>
  <div class="subagent-call-content">
    <section class="call-parameters" :aria-label="t('components.tools.parameters')">
      <div class="label">{{ t('components.tools.parameters') }}</div>
      <ToolResultValue :value="invocationOptions" />
      <div v-if="prompt" class="block">
        <div class="label">{{ t('components.tools.subagents.task') }}</div>
        <CustomScrollbar :max-height="260"><pre class="pre">{{ prompt }}</pre></CustomScrollbar>
      </div>
      <div v-if="context" class="block">
        <div class="label">{{ t('components.tools.subagents.context') }}</div>
        <CustomScrollbar :max-height="260"><pre class="pre">{{ context }}</pre></CustomScrollbar>
      </div>
    </section>
  <TaskCard
    v-if="result || errorMessage || responseText"
    :openable="false"
    :title="`Sub-Agent · ${agentName}`"
    icon="codicon-hubot"
    :status="cardStatus"
    :subtitle="undefined"
    :preview="preview"
    :preview-is-markdown="true"
    :meta-chips="chips"
    :footer-right="runtimeBadge"
  >
    <template #expanded>
      <div class="expanded">
        <div v-if="errorMessage" class="error">{{ errorMessage }}</div>
        <div v-if="responseText" class="response-block">
          <CustomScrollbar :max-height="500">
            <MarkdownRenderer :content="responseText" />
          </CustomScrollbar>
        </div>
      </div>
    </template>
  </TaskCard>
  </div>
</template>

<style scoped>
.subagent-call-content,.call-parameters{display:flex;flex-direction:column;gap:12px;min-width:0}
.call-parameters{padding-bottom:12px}
.expanded {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gc-text-muted);
}

.pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--gc-surface-panel);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-md);
  font-size: 12px;
  color: var(--gc-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--gc-font-code), monospace;
}

.response-block {
  background: var(--gc-surface-panel);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-md);
  overflow: hidden;
}

.response-block :deep(.markdown-content) {
  padding: 8px 10px;
}

.error {
  padding: 8px 10px;
  background: var(--gc-danger-bg);
  border: 1px solid var(--gc-danger-border);
  border-radius: var(--gc-radius-md);
  color: var(--gc-danger);
  font-size: 12px;
  word-break: break-word;
}
</style>
