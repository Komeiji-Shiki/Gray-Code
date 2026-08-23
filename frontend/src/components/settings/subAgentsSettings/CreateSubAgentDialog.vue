<script setup lang="ts">
/**
 * CreateSubAgentDialog - 新建子代理对话框。
 * 业务状态仍由父组件持有，弹窗行为统一交给 Modal。
 */
import { useI18n } from '@/i18n'
import { CustomSelect, Modal, type SelectOption } from '../../common'
import type { SubAgentPreset } from './types'

defineProps<{
  newAgentName: string
  newAgentChannelId: string
  selectedPresetId: string
  presets: SubAgentPreset[]
  channelOptions: SelectOption[]
  createError: string
  isCreating: boolean
  presetName: (preset: SubAgentPreset) => string
  presetDescription: (preset: SubAgentPreset) => string
  onSelectPreset: (presetId: string) => void
  onClose: () => void
  onCreate: () => void
}>()

const emit = defineEmits<{
  (e: 'update:newAgentName', value: string): void
  (e: 'update:newAgentChannelId', value: string): void
}>()

const { t } = useI18n()

function onNameInput(event: Event) {
  emit('update:newAgentName', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <Modal
    :model-value="true"
    :title="t('components.settings.subagents.createDialog.title')"
    width="500px"
    initial-focus-selector=".agent-name-input"
    body-padding="compact"
    @close="onClose"
  >
    <div class="dialog-content">
      <fieldset class="form-group template-group">
        <legend>{{ t('components.settings.subagents.createDialog.templateLabel') }}</legend>
        <div
          class="preset-list"
          role="radiogroup"
          :aria-label="t('components.settings.subagents.createDialog.templateLabel')"
        >
          <button
            type="button"
            class="preset-card gc-choice-card"
            :class="{ 'is-selected': selectedPresetId === '' }"
            role="radio"
            :aria-checked="selectedPresetId === ''"
            @click="onSelectPreset('')"
          >
            <i class="codicon codicon-file" aria-hidden="true"></i>
            <span class="preset-info">
              <span class="preset-name">{{ t('components.settings.subagents.presets.blank.name') }}</span>
              <span class="preset-desc">{{ t('components.settings.subagents.presets.blank.description') }}</span>
            </span>
          </button>
          <button
            v-for="preset in presets"
            :key="preset.presetId"
            type="button"
            class="preset-card gc-choice-card"
            :class="{ 'is-selected': selectedPresetId === preset.presetId }"
            role="radio"
            :aria-checked="selectedPresetId === preset.presetId"
            @click="onSelectPreset(preset.presetId)"
          >
            <i :class="['codicon', preset.icon]" aria-hidden="true"></i>
            <span class="preset-info">
              <span class="preset-name">{{ presetName(preset) }}</span>
              <span class="preset-desc">{{ presetDescription(preset) }}</span>
            </span>
          </button>
        </div>
      </fieldset>

      <div class="form-group">
        <label for="subagent-create-name">{{ t('components.settings.subagents.createDialog.nameLabel') }}</label>
        <input
          id="subagent-create-name"
          :value="newAgentName"
          type="text"
          class="agent-name-input gc-field"
          :placeholder="t('components.settings.subagents.createDialog.namePlaceholder')"
          :aria-invalid="!!createError"
          :aria-describedby="createError ? 'subagent-create-error' : undefined"
          @input="onNameInput"
          @keyup.enter="onCreate"
        />
      </div>

      <div class="form-group">
        <label>{{ t('components.settings.subagents.channel') }}</label>
        <CustomSelect
          :model-value="newAgentChannelId"
          :options="channelOptions"
          :placeholder="t('components.settings.subagents.selectChannel')"
          :aria-label="t('components.settings.subagents.channel')"
          @update:model-value="emit('update:newAgentChannelId', $event)"
        />
      </div>

      <div
        v-if="createError"
        id="subagent-create-error"
        class="error-message gc-feedback gc-feedback--error"
        role="alert"
      >
        <i class="codicon codicon-error" aria-hidden="true"></i>
        <span>{{ createError }}</span>
      </div>
    </div>

    <template #footer>
      <button type="button" class="gc-button" @click="onClose">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="gc-button gc-button--primary"
        :disabled="isCreating"
        @click="onCreate"
      >
        <i v-if="isCreating" class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
        {{ t('common.create') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-4);
}

.form-group {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
}

.template-group {
  margin: 0;
  padding: 0;
  border: 0;
}

.form-group label,
.form-group legend {
  padding: 0;
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-body);
  font-weight: var(--gc-font-weight-medium);
}

.preset-list {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
  max-height: 260px;
  overflow-y: auto;
}

.preset-card > .codicon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--vscode-symbolIcon-classForeground, var(--gc-info));
  font-size: var(--gc-icon-size-md);
}

.preset-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.preset-name {
  color: inherit;
  font-size: var(--gc-font-size-body);
  font-weight: var(--gc-font-weight-semibold);
}

.preset-desc {
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
  line-height: var(--gc-line-height-normal);
}

.preset-card[aria-checked="true"] .preset-desc {
  color: inherit;
  opacity: var(--gc-opacity-muted);
}

.error-message {
  margin: 0;
}
</style>
