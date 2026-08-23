<script setup lang="ts">
import { computed, getCurrentInstance } from 'vue'
import { t } from '@/i18n'

const props = withDefaults(defineProps<{
  modelValue: boolean
  label?: string
  hint?: string
  ariaLabel?: string
  disabled?: boolean
  compact?: boolean
}>(), {
  label: '',
  hint: '',
  ariaLabel: '',
  disabled: false,
  compact: false
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const instanceId = getCurrentInstance()?.uid ?? 0
const hintId = `gc-switch-hint-${instanceId}`
const accessibleLabel = computed(() => props.ariaLabel || props.label || t('common.enable'))

function handleChange(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="custom-switch-field" :class="{ compact }">
    <label class="custom-switch" :class="{ disabled }">
      <input
        type="checkbox"
        role="switch"
        :checked="modelValue"
        :disabled="disabled"
        :aria-checked="modelValue"
        :aria-label="accessibleLabel"
        :aria-describedby="hint ? hintId : undefined"
        @change="handleChange"
      />
      <span class="custom-switch-track" aria-hidden="true">
        <span class="custom-switch-thumb"></span>
      </span>
      <span v-if="label" class="custom-switch-label">{{ label }}</span>
    </label>
    <span v-if="hint" :id="hintId" class="custom-switch-hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.custom-switch-field {
  display: inline-flex;
  flex-direction: column;
  gap: var(--gc-space-1);
}

.custom-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--gc-space-2);
  color: var(--gc-text-primary);
  cursor: pointer;
  user-select: none;
}

.custom-switch.disabled {
  color: var(--gc-text-disabled);
  cursor: not-allowed;
}

.custom-switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.custom-switch-track {
  position: relative;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-pill);
  background: var(--vscode-input-background, var(--gc-surface-muted));
  transition:
    background-color var(--gc-duration-normal) var(--gc-ease-standard),
    border-color var(--gc-duration-normal) var(--gc-ease-standard);
}

.custom-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--gc-text-primary);
  transition: transform var(--gc-duration-normal) var(--gc-ease-emphasized);
}

.custom-switch input:checked + .custom-switch-track {
  border-color: var(--gc-accent);
  background: var(--gc-accent);
}

.custom-switch input:checked + .custom-switch-track .custom-switch-thumb {
  transform: translateX(16px);
  background: var(--gc-text-on-accent);
}

.custom-switch input:focus-visible + .custom-switch-track {
  outline: 1px solid var(--gc-focus-border);
  outline-offset: 2px;
}

.custom-switch input:disabled + .custom-switch-track {
  opacity: var(--gc-opacity-disabled);
}

.custom-switch-label {
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-normal);
}

.custom-switch-hint {
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-caption);
  line-height: var(--gc-line-height-normal);
}

.custom-switch-field.compact .custom-switch-track {
  width: 30px;
  height: 18px;
}

.custom-switch-field.compact .custom-switch-thumb {
  width: 12px;
  height: 12px;
}

.custom-switch-field.compact input:checked + .custom-switch-track .custom-switch-thumb {
  transform: translateX(12px);
}

@media (prefers-reduced-motion: reduce) {
  .custom-switch-track,
  .custom-switch-thumb {
    transition: none;
  }
}

@media (forced-colors: active) {
  .custom-switch-track {
    border-color: CanvasText;
  }

  .custom-switch input:checked + .custom-switch-track {
    background: Highlight;
  }
}
</style>
