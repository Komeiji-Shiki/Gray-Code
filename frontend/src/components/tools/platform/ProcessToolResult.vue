<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import ToolResultPanel from '../common/ToolResultPanel.vue'
import ToolReceiptDetails from '../common/ToolReceiptDetails.vue'
import ToolNextActions from '../common/ToolNextActions.vue'
import PlatformText from './PlatformText.vue'
import ProcessOutput from './ProcessOutput.vue'
import { label, number, object, pick, resultBody, strings, successfulResult, text, type PlatformToolProps } from './platformResult'

defineOptions({ inheritAttrs: false })
const props = defineProps<PlatformToolProps>()
const { t } = useI18n()
const args = computed(() => props.args ?? {})
const data = computed(() => object(resultBody(props.result)))
const failedExit = computed(() => data.value.running === false && number(data.value.exitCode) !== undefined && data.value.exitCode !== 0)
const state = computed(() => data.value.running === true ? 'running' : data.value.running === false ? 'exited' : 'unknown')
</script>

<template>
  <div class="platform-panel process-result"><ToolResultPanel v-bind="props">
    <div class="platform-header">
      <template v-if="toolName === 'run_command'">
        <span class="codicon codicon-terminal" aria-hidden="true" /><strong class="platform-path">{{ text(args.command) }}</strong>
        <code v-for="(argument, index) in strings(args.args)" :key="index" class="process-argument">{{ JSON.stringify(argument) }}</code>
      </template>
      <strong v-else>{{ label('process.actions', args.action) }}</strong>
    </div>
    <template #result="{ metadata }">
      <div class="platform-statbar">
        <span class="platform-status process-state" :class="failedExit ? 'failed' : state" role="status"><span v-if="state === 'running'" class="codicon codicon-loading" aria-hidden="true" />{{ t(`components.tools.platform.process.${state}`) }}</span>
        <span v-if="number(data.exitCode) !== undefined" class="process-exit-code">{{ t('components.tools.structured.fields.exitCode') }}: {{ data.exitCode }}</span>
      </div>
      <ProcessOutput :data="data" />
      <ToolNextActions :value="data.nextActions" />
      <template v-if="args.action === 'input' && typeof args.text === 'string' && successfulResult(props)">
        <h4 class="platform-section-title">{{ t('components.tools.platform.process.input') }}</h4><PlatformText :text="args.text" code />
      </template>
      <ToolReceiptDetails :value="{ ...pick(data, ['id', 'outputOffset', 'nextCursor', 'hasMore', 'outputLost']), ...(!data.id && args.id ? { id: args.id } : {}) }" :metadata="metadata" />
    </template>
  </ToolResultPanel></div>
</template>

<style scoped src="./platform.css"></style>
<style scoped>
.process-argument{background:var(--gc-surface-base);border-bottom:1px solid var(--gc-border-subtle);font:11px/1.6 var(--gc-font-code);padding:1px 4px;white-space:pre-wrap;overflow-wrap:anywhere}.process-exit-code{font-family:var(--gc-font-code)}
</style>
