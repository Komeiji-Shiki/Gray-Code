<script setup lang="ts">
import { computed, getCurrentInstance } from 'vue'
import { t } from '@/i18n'

const props = withDefaults(defineProps<{
  modelValue: boolean
  label?: string
  hint?: string
  ariaLabel?: string
  disabled?: boolean
}>(), {
  label: '',
  hint: '',
  ariaLabel: '',
  disabled: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const instanceId = getCurrentInstance()?.uid ?? 0
const hintId = `gc-checkbox-hint-${instanceId}`
const accessibleLabel = computed(() => props.ariaLabel || props.label || t('common.enable'))

function toggle(event: Event) {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.checked)
}
</script>

<template>
  <div class="checkbox-wrapper">
    <label :class="['custom-checkbox', { disabled }]">
      <input
        type="checkbox"
        :checked="modelValue"
        :disabled="disabled"
        :aria-label="accessibleLabel"
        :aria-describedby="hint ? hintId : undefined"
        @change="toggle"
      />
      <span class="checkmark" aria-hidden="true"></span>
      <span v-if="label" class="checkbox-text">{{ label }}</span>
    </label>
    <span v-if="hint" :id="hintId" class="checkbox-hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.checkbox-wrapper {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-1);
}

.custom-checkbox {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: var(--gc-font-size-control);
  font-weight: var(--gc-font-weight-regular);
  position: relative;
  padding-left: 26px;
  user-select: none;
}

.custom-checkbox.disabled {
  opacity: var(--gc-opacity-disabled);
  cursor: not-allowed;
}

.custom-checkbox input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 0;
  width: 0;
}

.custom-checkbox .checkmark {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 16px;
  width: 16px;
  background: var(--vscode-input-background, var(--gc-surface-base));
  border: 1.5px solid var(--gc-border-strong);
  border-radius: var(--gc-radius-sm);
  transition:
    opacity var(--gc-duration-fast) var(--gc-ease-standard),
    border-color var(--gc-duration-fast) var(--gc-ease-standard),
    background-color var(--gc-duration-fast) var(--gc-ease-standard);
  opacity: 0.6;
}

.custom-checkbox:hover:not(.disabled) .checkmark {
  opacity: 1;
}

.custom-checkbox:focus-within .checkmark {
  border-color: var(--gc-focus-border);
  opacity: 1;
}

.custom-checkbox input:checked ~ .checkmark {
  background: var(--gc-accent);
  border-color: var(--gc-accent);
}

.custom-checkbox .checkmark::after {
  content: '';
  position: absolute;
  display: none;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 8px;
  border: solid var(--gc-text-on-accent);
  border-width: 0 2px 2px 0;
  transform: translate(-50%, -60%) rotate(45deg);
}

.custom-checkbox input:checked ~ .checkmark::after {
  display: block;
}

.checkbox-text {
  margin-left: 4px;
}

.checkbox-hint {
  font-size: var(--gc-font-size-caption);
  color: var(--gc-text-muted);
  margin-left: 26px;
}
</style>