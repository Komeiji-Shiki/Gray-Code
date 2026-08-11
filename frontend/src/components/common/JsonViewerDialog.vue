<script setup lang="ts">
/**
 * JsonViewerDialog - 通用 JSON 查看器
 *
 * 用于在 UI 中查看“原始返回/调试信息”等结构化数据。
 */

import { computed, ref, onUnmounted } from 'vue'
import Modal from './Modal.vue'
import { t } from '../../i18n'
import { copyToClipboard } from '../../utils/format'

interface Props {
  modelValue?: boolean
  title?: string
  value: unknown
  width?: string
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  title: '',
  width: '760px'
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

// 超大字符串截断阈值
const MAX_STRING = 12_000

/**
 * 整树去重（路径集合）：递归前标记、递归完成即退出当前节点。
 * 与 buildResponseViewerData 的 sanitizeForViewer 同款修复：DAG 中共享（非环）对象
 * 不会因整树 WeakSet 残留被误标 [Circular]；真正的环仍会被识别并替换为标记。
 */
function sanitizeForViewer(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === 'bigint') return value.toString()

  if (typeof value === 'string') {
    if (value.length > MAX_STRING) {
      return `${value.slice(0, MAX_STRING)}\n... (truncated, total=${value.length})`
    }
    return value
  }

  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const mapped = value.map(item => sanitizeForViewer(item, seen))
    seen.delete(value)
    return mapped
  }

  if (typeof value === 'object') {
    const target = value as Record<string, unknown>
    if (seen.has(target)) return '[Circular]'
    seen.add(target)
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(target)) {
      result[key] = sanitizeForViewer(item, seen)
    }
    seen.delete(target)
    return result
  }

  return String(value)
}

function safeStringify(value: unknown): string {
  // 防止超大对象/循环引用导致 UI 卡死
  try {
    return JSON.stringify(sanitizeForViewer(value), null, 2)
  } catch (e: any) {
    try {
      return String(value)
    } catch {
      return '[Unserializable]'
    }
  }
}

const jsonText = computed(() => safeStringify(props.value))

const copied = ref(false)
let copiedTimer: number | undefined

onUnmounted(() => {
  if (copiedTimer) {
    window.clearTimeout(copiedTimer)
    copiedTimer = undefined
  }
})

async function handleCopy() {
  const ok = await copyToClipboard(jsonText.value)
  if (!ok) return

  copied.value = true
  if (copiedTimer) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
    copiedTimer = undefined
  }, 1000)
}
</script>

<template>
  <Modal v-model="visible" :title="title || t('components.message.actions.viewResponse')" :width="width">
    <pre class="json-viewer">{{ jsonText }}</pre>

    <template #footer>
      <button class="dialog-btn cancel" type="button" @click="visible = false">
        {{ t('common.close') }}
      </button>
      <button class="dialog-btn confirm" type="button" @click="handleCopy">
        {{ copied ? t('components.common.tooltip.copied') : t('common.copy') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.json-viewer {
  margin: 0;
  padding: 12px;
  border-radius: 6px;
  border: 1px solid var(--vscode-panel-border);
  background: rgba(0, 0, 0, 0.15);
  color: var(--vscode-foreground);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  max-height: 70vh;
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

.dialog-btn.confirm {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.confirm:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
