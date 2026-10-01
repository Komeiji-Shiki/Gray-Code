<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { recordValue, toolStatusLabel } from '../../../utils/toolPresentation'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import PlatformText from './PlatformText.vue'
import { label, number, object, pick, records, resultBody, strings, text, type PlatformToolProps } from './platformResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<PlatformToolProps>()
const { t } = useI18n()
const args = computed(() => props.args ?? {})
const data = computed(() => object(resultBody(props.result)))
const waiting = computed(() => props.toolName === 'team_wait')
const tasks = computed(() => Array.isArray(data.value.tasks) ? records(data.value.tasks) : recordValue(data.value.task) ? [data.value.task] : [])
const events = computed(() => records(data.value.events))
const ready = computed(() => strings(data.value.readyTaskIds))
const visible = ref(30)
watch(() => props.result, () => { visible.value = 30 })
function dependencyTitles(task: Record<string, unknown>): string[] {
  return strings(task.dependencies).flatMap(id => {
    const match = tasks.value.find(task => task.id === id)
    return match && text(match.title) ? [text(match.title)] : []
  })
}
const status = (value: unknown) => toolStatusLabel(value) ?? text(value)
</script>

<template>
  <div class="platform-panel team-result"><ToolResultPanel v-bind="props">
    <div v-if="!waiting" class="platform-header"><strong>{{ label('team.actions', args.action) }}</strong></div>
    <template #result>
      <div v-if="ready.length" class="platform-statbar ready-tasks"><span class="codicon codicon-circle-large-outline" aria-hidden="true" />{{ t('components.tools.platform.team.ready', { count: ready.length }) }}</div>
      <p v-if="data.noProgress === true" class="platform-notice warning no-progress">{{ t('components.tools.platform.team.noProgress') }}</p>
      <template v-if="waiting">
        <div v-if="text(data.reason)" class="platform-header wait-reason"><strong>{{ label('team.reasons', data.reason) }}</strong></div>
        <ol class="platform-list team-events">
          <li v-for="(event, index) in events.slice(0, visible)" :key="index" class="platform-card team-event">
            <div class="platform-card-title"><span class="codicon codicon-circle-small-filled" aria-hidden="true" /><strong>{{ label('team.events', text(event.type).replaceAll('.', '_')) }}</strong><span v-if="event.status" class="platform-status" :class="text(event.status)">{{ status(event.status) }}</span></div>
            <ToolReceiptDetails :value="pick(event, ['sequence', 'memberId', 'taskId', 'taskRevision', 'messageId', 'conversationId'])" />
          </li>
        </ol>
        <button v-if="events.length > visible" type="button" class="platform-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: events.length - visible }) }}</button>
        <p v-if="!events.length" class="platform-empty">{{ t(Array.isArray(data.events) ? 'components.tools.platform.team.emptyEvents' : 'components.tools.platform.noData') }}</p>
        <p v-if="data.hasMore === true && number(data.sequence) !== undefined" class="platform-notice continuation">{{ t('components.tools.platform.team.moreEvents', { sequence: data.sequence }) }}</p>
      </template>
      <template v-else>
        <ol class="platform-list team-tasks">
          <li v-for="(task, index) in tasks.slice(0, visible)" :key="index" class="platform-card team-task">
            <div class="platform-card-title"><strong>{{ text(task.title) || t('components.tools.platform.team.task') }}</strong><span v-if="task.status" class="platform-status" :class="text(task.status)">{{ status(task.status) }}</span></div>
            <div class="platform-statbar">
              <span v-if="task.owner">{{ t('components.tools.platform.team.assigned') }}</span>
              <span v-else-if="task.status === 'pending'">{{ t('components.tools.platform.team.unclaimed') }}</span>
              <span v-if="number(task.revision) !== undefined">{{ t('components.tools.platform.version', { version: task.revision }) }}</span>
              <span v-if="strings(task.dependencies).length">{{ t('components.tools.platform.team.dependencies', { count: strings(task.dependencies).length }) }}</span>
            </div>
            <PlatformText v-if="typeof task.description === 'string' && task.description.length" :text="task.description" />
            <p v-if="dependencyTitles(task).length" class="platform-breadcrumb task-dependency-titles">{{ dependencyTitles(task).join(' · ') }}</p>
            <p v-if="strings(task.blockedBy).length" class="platform-notice warning task-blocked">{{ t('components.tools.platform.team.blockedBy', { count: strings(task.blockedBy).length }) }}</p>
            <template v-if="typeof task.result === 'string' && task.result.length"><h4 class="platform-section-title">{{ t('components.tools.result') }}</h4><PlatformText :text="task.result" /></template>
            <ToolReceiptDetails :value="pick(task, ['id', 'owner', 'ownerRunId', 'creator', 'dependencies', 'blockedBy', 'createdSequence', 'updatedSequence'])" />
          </li>
        </ol>
        <button v-if="tasks.length > visible" type="button" class="platform-more" @click="visible += 30">{{ t('components.tools.structured.showMore', { count: tasks.length - visible }) }}</button>
        <p v-if="!tasks.length" class="platform-empty">{{ t(args.action === 'claim_ready' && data.task === null ? 'components.tools.platform.team.noReady' : Array.isArray(data.tasks) ? 'components.tools.platform.team.empty' : 'components.tools.platform.noData') }}</p>
        <p v-if="data.hasMore === true && number(data.nextAfterCreatedSequence) !== undefined" class="platform-notice continuation">{{ t('components.tools.platform.team.nextTasks', { sequence: data.nextAfterCreatedSequence }) }}</p>
      </template>
      <ToolReceiptDetails :value="pick(data, ['memberId', 'sequence', 'latestSequence', 'total', 'nextAfterCreatedSequence', 'readyTaskIds'])" />
    </template>
  </ToolResultPanel></div>
</template>

<style scoped src="./platform.css"></style>
<style scoped>
.team-events>.team-event{border-left:1px solid var(--gc-border-subtle);padding-left:12px;margin-left:4px}.team-events .codicon-circle-small-filled{margin-left:-19px;color:var(--gc-link);background:var(--gc-surface-base)}.task-dependency-titles{padding-left:8px;border-left:2px solid var(--gc-border-subtle)}.ready-tasks{color:var(--gc-link)}
</style>
