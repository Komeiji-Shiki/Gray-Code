<script setup lang="ts">
/**
 * ChannelConfigSelector - 渠道选择器（重命名 / 新增 / 删除入口）
 *
 * 从 ChannelSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：编辑状态 / 选项 / 当前选中值均由父组件通过 props 注入，
 *   自身不持有业务状态；
 * - 仅保留模板 ref 与键盘交互（Enter 保存 / Esc 取消通过 emits 回传父组件）。
 */
import { ref } from 'vue'
import { CustomSelect, type SelectOption } from '../../common'
import { t } from '@/i18n'

defineProps<{
  isEditing: boolean
  editingName: string
  currentConfigId: string
  configOptions: SelectOption[]
}>()

const emit = defineEmits<{
  (e: 'update:editingName', value: string): void
  (e: 'update:currentConfigId', value: string): void
  (e: 'rename'): void
  (e: 'save'): void
  (e: 'cancel'): void
  (e: 'add'): void
  (e: 'delete'): void
}>()

const editInput = ref<HTMLInputElement>()

/** 进入重命名编辑后由父组件调用，聚焦并选中现有名称 */
function focusEdit() {
  editInput.value?.focus()
  editInput.value?.select()
}

function handleEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    emit('save')
  } else if (e.key === 'Escape') {
    emit('cancel')
  }
}

defineExpose({ focusEdit })
</script>

<template>
  <div class="config-selector">
    <!-- 编辑模式：输入框 + 确认/取消按钮 -->
    <template v-if="isEditing">
      <input
        ref="editInput"
        :value="editingName"
        type="text"
        class="config-input"
        :placeholder="t('components.settings.channelSettings.selector.inputPlaceholder')"
        @input="emit('update:editingName', ($event.target as HTMLInputElement).value)"
        @keydown="handleEditKeydown"
      />
      <button class="icon-btn confirm" :title="t('components.settings.channelSettings.selector.confirm')" @click="emit('save')">
        <i class="codicon codicon-check"></i>
      </button>
      <button class="icon-btn cancel" :title="t('components.settings.channelSettings.selector.cancel')" @click="emit('cancel')">
        <i class="codicon codicon-close"></i>
      </button>
    </template>

    <!-- 正常模式：自定义下拉框 -->
    <div v-else class="config-select-wrapper">
      <CustomSelect
        :model-value="currentConfigId"
        :options="configOptions"
        :placeholder="t('components.settings.channelSettings.selector.placeholder')"
        @update:model-value="emit('update:currentConfigId', $event)"
      />
    </div>

    <button v-if="!isEditing" class="icon-btn" :title="t('components.settings.channelSettings.selector.rename')" @click="emit('rename')">
      <i class="codicon codicon-edit"></i>
    </button>

    <button v-if="!isEditing" class="icon-btn" :title="t('components.settings.channelSettings.selector.add')" @click="emit('add')">
      <i class="codicon codicon-add"></i>
    </button>

    <button
      v-if="!isEditing"
      class="icon-btn danger"
      :title="t('components.settings.channelSettings.selector.delete')"
      :disabled="!currentConfigId"
      @click="emit('delete')"
    >
      <i class="codicon codicon-trash"></i>
    </button>
  </div>
</template>

<style scoped>
/* 配置选择器 */
.config-selector {
  display: flex;
  gap: 8px;
  align-items: center;
}

.config-select-wrapper {
  flex: 1;
  min-width: 0;
}

.config-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 13px;
}

.config-input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-foreground);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--vscode-errorForeground);
}

.icon-btn.confirm:hover {
  color: var(--vscode-charts-green, #89d185);
}

.icon-btn.cancel:hover {
  color: var(--vscode-errorForeground, #f48771);
}
</style>
