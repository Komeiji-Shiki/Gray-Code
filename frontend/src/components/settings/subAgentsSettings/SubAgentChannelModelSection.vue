<script setup lang="ts">
/**
 * SubAgentChannelModelSection - 子代理「渠道和模型」区块
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：当前代理、渠道/模型选项与回调均由父组件注入。
 */
import { useI18n } from '@/i18n'
import { CustomCheckbox, CustomSelect, type SelectOption } from '../../common'
import type { SubAgentConfig } from '@/types/settingsConfig'
import type { ChannelConfig } from './types'

defineProps<{
  agent: SubAgentConfig
  syncsWithCurrent: boolean
  selectedChannel: ChannelConfig | undefined
  channelOptions: SelectOption[]
  modelOptions: SelectOption[]
  onToggleSync: (value: boolean) => void
  onSelectChannel: (channelId: string) => void
  onSelectModel: (modelId: string) => void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="config-section" data-search-anchor="subagents-channel-model">
    <h5>{{ t('components.settings.subagents.channelModel') }}</h5>

    <div class="form-group">
      <CustomCheckbox
        :modelValue="syncsWithCurrent"
        :label="t('components.settings.subagents.syncWithCurrentModel')"
        :hint="syncsWithCurrent ? '' : t('components.settings.subagents.syncWithCurrentModelHint')"
        @update:modelValue="onToggleSync"
      />
    </div>
    <p v-if="syncsWithCurrent" class="field-hint">{{ t('components.settings.subagents.syncWithCurrentModelActiveHint') }}</p>

    <div class="form-row">
      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.channel') }}</label>
        <CustomSelect
          :modelValue="agent.channel.channelId"
          :options="channelOptions"
          :placeholder="t('components.settings.subagents.selectChannel')"
          :disabled="syncsWithCurrent"
          @update:modelValue="onSelectChannel"
        />
      </div>

      <div class="form-group flex-1">
        <label>{{ t('components.settings.subagents.model') }}</label>
        <CustomSelect
          :modelValue="agent.channel.modelId || ''"
          :options="modelOptions"
          :placeholder="t('components.settings.subagents.selectModel')"
          :disabled="syncsWithCurrent || !selectedChannel"
          @update:modelValue="onSelectModel"
        />
      </div>
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

.field-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}
</style>
