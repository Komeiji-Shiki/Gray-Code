<script setup lang="ts">
/**
 * SubAgentGlobalConfigSection - 子代理「全局配置」区块
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：全部状态与动作由父组件通过 props 注入；
 * - 数字输入与「通用 Worker」开关的回调均由父组件提供（函数型 props，与项目既有风格一致）。
 */
import { useI18n } from '@/i18n'
import { CustomCheckbox } from '../../common'

defineProps<{
  maxConcurrentAgents: number
  defaultMaxIterations: number
  queueTimeoutSeconds: number
  defaultMaxRuntimeSeconds: number
  globalNumberError: string
  generalWorkerEnabled: boolean
  onGlobalNumberChange: (event: Event, field: 'maxConcurrentAgents' | 'defaultMaxIterations' | 'defaultMaxRuntimeSeconds') => void
  onQueueTimeout: (event: Event) => void
  onGeneralWorkerToggle: (value: boolean) => void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="config-section global-config" data-search-anchor="subagents-global">
    <h5>{{ t('components.settings.subagents.globalConfig') }}</h5>
    <div class="form-row global-config-row">
      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.maxConcurrentAgents') }}</label>
        <input
          type="number"
          :value="maxConcurrentAgents"
          min="-1"
          @change="onGlobalNumberChange($event, 'maxConcurrentAgents')"
        />
        <span class="field-hint">{{ t('components.settings.subagents.maxConcurrentAgentsHint') }}</span>
      </div>
      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.defaultMaxIterations') }}</label>
        <input
          type="number"
          :value="defaultMaxIterations"
          min="1"
          max="1000"
          @change="onGlobalNumberChange($event, 'defaultMaxIterations')"
        />
        <span class="field-hint">{{ t('components.settings.subagents.defaultMaxIterationsHint') }}</span>
      </div>
      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.queueTimeoutSeconds') }}</label>
        <input
          type="number"
          :value="queueTimeoutSeconds"
          min="-1"
          @change="onQueueTimeout"
        />
        <span class="field-hint">{{ t('components.settings.subagents.queueTimeoutSecondsHint') }}</span>
      </div>
      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.defaultMaxRuntimeSeconds') }}</label>
        <input
          type="number"
          :value="defaultMaxRuntimeSeconds"
          min="-1"
          @change="onGlobalNumberChange($event, 'defaultMaxRuntimeSeconds')"
        />
        <span class="field-hint">{{ t('components.settings.subagents.defaultMaxRuntimeSecondsHint') }}</span>
      </div>
    </div>
    <p v-if="globalNumberError" class="field-hint global-number-error" style="color: var(--vscode-errorForeground)">{{ globalNumberError }}</p>
    <div class="form-group">
      <CustomCheckbox
        :modelValue="generalWorkerEnabled"
        :label="t('components.settings.subagents.generalWorker')"
        @update:modelValue="onGeneralWorkerToggle"
      />
      <span class="field-hint">{{ t('components.settings.subagents.generalWorkerHint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.config-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-section h5 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.form-group input,
.form-group textarea {
  padding: 6px 10px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  color: var(--vscode-input-foreground);
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.field-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
}

.global-config {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

/* 全局配置四参数 2×2 布局：一行四个过宽（label/hint 挤成多行），
   改为两行两列——「并发数/迭代次数」与「队列超时/运行时长」各占一行。
   双类选择器提升特异性（.form-row 在其后定义，单类会被它的 display:flex 覆盖） */
.global-config .global-config-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

/* 数字输入框隐藏上下箭头 */
input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield;
}

input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.global-config input[type="number"] {
  width: 100px;
}
</style>
