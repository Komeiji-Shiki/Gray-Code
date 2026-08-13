<script setup lang="ts">
/**
 * ResponseViewerDialog - 响应详情弹窗。
 *
 * 拆分后：格式化 / 标签映射 / 信息条目构建 → responseViewerDialog/viewerFormat.ts；
 * 通用视图 → ResponseViewerCommonMode.vue；高级视图 → ResponseViewerAdvancedMode.vue。
 * 本组件只保留弹窗编排（可见性、模式持久化、折叠状态与复制动作）。
 */
import { computed, ref, watch } from 'vue'
import { JsonViewerDialog, Modal } from '../common'
import { useI18n } from '../../i18n'
import { copyToClipboard } from '../../utils/format'
import { showNotification } from '../../utils/vscode'
import type { ResponseViewerData, ResponseViewerMode } from './responseViewer/buildResponseViewerData'
import ResponseViewerCommonMode from './responseViewerDialog/ResponseViewerCommonMode.vue'
import ResponseViewerAdvancedMode from './responseViewerDialog/ResponseViewerAdvancedMode.vue'

interface Props {
  modelValue?: boolean
  title?: string
  value: ResponseViewerData
  width?: string
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  title: '',
  width: '960px'
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()
const MODE_STORAGE_KEY = 'graycode.responseViewer.mode'

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const mode = ref<ResponseViewerMode>('common')
const showRawJsonDialog = ref(false)
const expandedBlocks = ref<Record<string, boolean>>({})

watch(
  () => props.modelValue,
  isOpen => {
    if (isOpen) {
      mode.value = readStoredMode()
      showRawJsonDialog.value = false
      expandedBlocks.value = {}
      return
    }

    showRawJsonDialog.value = false
  }
)

watch(mode, nextMode => {
  persistMode(nextMode)
})

function readStoredMode(): ResponseViewerMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'advanced' ? 'advanced' : 'common'
  } catch {
    return 'common'
  }
}

function persistMode(nextMode: ResponseViewerMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, nextMode)
  } catch {
    // 忽略存储失败
  }
}

function handleSelectMode(nextMode: ResponseViewerMode): void {
  mode.value = nextMode
}

function toggleExpanded(key: string): void {
  expandedBlocks.value = {
    ...expandedBlocks.value,
    [key]: !expandedBlocks.value[key]
  }
}

async function handleCopyBody(text: string): Promise<void> {
  const success = await copyToClipboard(text)

  await showNotification(
    success
      ? t('components.message.responseViewer.copySuccess')
      : t('components.message.responseViewer.copyFailed'),
    success ? 'info' : 'error'
  )
}
</script>

<template>
  <Modal
    v-model="visible"
    :title="title || t('components.message.actions.viewResponse')"
    :width="width"
  >
    <div class="response-viewer">
      <div class="mode-switch">
        <button
          type="button"
          class="mode-btn"
          :class="{ active: mode === 'common' }"
          @click="handleSelectMode('common')"
        >
          {{ t('components.message.responseViewer.commonMode') }}
        </button>
        <button
          type="button"
          class="mode-btn"
          :class="{ active: mode === 'advanced' }"
          @click="handleSelectMode('advanced')"
        >
          {{ t('components.message.responseViewer.advancedMode') }}
        </button>
      </div>

      <ResponseViewerCommonMode
        v-if="mode === 'common'"
        :value="value"
        @copy-body="handleCopyBody"
      />
      <ResponseViewerAdvancedMode
        v-else
        :value="value"
        :expanded-blocks="expandedBlocks"
        @copy-body="handleCopyBody"
        @toggle-expanded="toggleExpanded"
        @open-raw-json="showRawJsonDialog = true"
      />
    </div>

    <template #footer>
      <button class="dialog-btn cancel" type="button" @click="visible = false">
        {{ t('common.close') }}
      </button>
    </template>
  </Modal>

  <JsonViewerDialog
    v-model="showRawJsonDialog"
    :value="props.value.rawJson"
    :title="t('components.message.responseViewer.rawJson')"
    width="860px"
  />
</template>

<style scoped>
.response-viewer {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 6px 8px 12px;
  box-sizing: border-box;
}

.mode-switch {
  display: inline-flex;
  gap: 8px;
  padding: 4px;
  border-radius: 8px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.12));
  align-self: flex-start;
  margin-left: 2px;
}

.mode-btn {
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.mode-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

.mode-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  transition: background-color 0.15s, opacity 0.15s;
}

.dialog-btn.cancel {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.dialog-btn.cancel:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
</style>
