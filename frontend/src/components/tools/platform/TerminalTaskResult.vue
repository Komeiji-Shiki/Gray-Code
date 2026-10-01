<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { toolStatusLabel } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import ToolNextActions from '../common/ToolNextActions.vue'
import ProcessOutput from './ProcessOutput.vue'
import { label, number, object, pick, records, resultBody, text, type PlatformToolProps } from './platformResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<PlatformToolProps>()
const { t } = useI18n()
const data = computed(() => object(resultBody(props.result)))
const listing = computed(() => props.args?.action === 'list')
const tasks = computed(() => listing.value ? records(data.value.tasks) : data.value.taskId ? [data.value] : [])
const visible = ref(40)
watch(() => props.result, () => { visible.value = 40 })
function taskStatus(task: Record<string, unknown>) {
  if (task.status === 'interrupted') return t('components.tools.platform.process.interrupted')
  return (toolStatusLabel(task.status) ?? text(task.status)) || t('components.tools.platform.process.unknown')
}
</script>

<template>
  <div class="platform-panel terminal-task-result"><ToolResultPanel v-bind="props">
    <div class="platform-header"><strong>{{ label('process.taskActions', args?.action) }}</strong></div>
    <template #result="{ metadata }">
      <div v-if="listing && number(data.total) !== undefined" class="platform-statbar">{{ t('components.tools.platform.process.taskCount', { count: data.total }) }}</div>
      <div class="terminal-tasks" :class="{ 'is-list': listing }" :tabindex="listing ? 0 : undefined">
        <article v-for="(task, index) in tasks.slice(0, visible)" :key="text(task.taskId) || index" class="platform-card terminal-task">
          <div class="platform-card-title">
            <span class="platform-status task-status" :class="task.status === 'error' ? 'failed' : text(task.status)" role="status">{{ taskStatus(task) }}</span>
            <span v-if="number(task.exitCode) !== undefined" class="task-exit-code">{{ t('components.tools.structured.fields.exitCode') }}: {{ task.exitCode }}</span>
          </div>
          <pre v-if="text(task.command)" class="task-command">{{ text(task.command) }}</pre>
          <p v-if="text(task.error)" class="platform-notice task-error" role="alert">{{ text(task.error) }}</p>
          <ProcessOutput v-if="!listing && args?.action === 'read'" :data="task" />
          <ToolNextActions :value="task.nextActions" />
          <ToolReceiptDetails :value="pick(task, ['taskId', 'background', 'startTime', 'updatedAt', 'outputOffset', 'nextCursor', 'hasMore', 'outputLost', 'cursorOriginKnown'])" />
        </article>
      </div>
      <p v-if="listing && !tasks.length" class="platform-empty">{{ t(Array.isArray(data.tasks) ? 'components.tools.platform.process.noTasks' : 'components.tools.platform.noData') }}</p>
      <button v-if="tasks.length > visible" type="button" class="platform-more" @click="visible += 40">{{ t('components.tools.structured.showMore', { count: tasks.length - visible }) }}</button>
      <p v-if="listing && number(data.nextOffset) !== undefined" class="platform-notice continuation">{{ t('components.tools.platform.nextOffset', { offset: data.nextOffset }) }}</p>
      <ToolNextActions v-if="listing || !tasks.length" :value="data.nextActions" />
      <ToolReceiptDetails v-if="Object.keys(metadata).length" :metadata="metadata" />
    </template>
  </ToolResultPanel></div>
</template>

<style scoped src="./platform.css"></style>
<style scoped>
.task-command{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--gc-font-code)}.task-exit-code{font-family:var(--gc-font-code);color:var(--gc-text-muted)}.task-error{color:var(--gc-danger);white-space:pre-wrap;overflow-wrap:anywhere}.task-status.interrupted,.task-status.cancelled{color:var(--gc-warning)}
.terminal-tasks.is-list{max-height:420px;overflow:auto;overscroll-behavior:contain}.terminal-tasks:focus-visible{outline:1px solid var(--gc-focus-border);outline-offset:2px}
</style>
