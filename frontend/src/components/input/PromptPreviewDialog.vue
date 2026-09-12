<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Modal } from '../common'
import { sendToExtension } from '../../utils/vscode'
import { copyToClipboard } from '../../utils/format'
import { requestGroups, requestReadableText, type PromptPreviewResult } from '../../../../shared/promptPreview'

const props = defineProps<{ modelValue: boolean; request: Record<string, unknown>; running?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const preview = ref<PromptPreviewResult>()
const loading = ref(false)
const error = ref('')
const stale = ref(false)
const copied = ref(false)
const query = ref('')
const view = ref<'messages' | 'json'>('messages')
let requestEpoch = 0
const json = computed(() => preview.value ? JSON.stringify(preview.value.body, null, 2) : '')
const groups = computed(() => requestGroups(preview.value?.body).map(group => ({ ...group, text: requestReadableText(group.value) }))
  .filter(group => !query.value.trim() || `${group.title}\n${group.text}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))

async function refresh() {
  const epoch = ++requestEpoch
  const request = props.request
  loading.value = true; error.value = ''; stale.value = false; copied.value = false
  try {
    const result = await sendToExtension<PromptPreviewResult>('prompt.preview', request)
    if (epoch !== requestEpoch) return
    preview.value = result
    stale.value = request !== props.request
  } catch (cause) {
    if (epoch === requestEpoch) error.value = (cause as Error).message
  } finally { if (epoch === requestEpoch) loading.value = false }
}
async function copy() {
  copied.value = await copyToClipboard(json.value)
  if (!copied.value) error.value = '复制失败，可以切换到完整 JSON 后手动复制。'
}
watch(() => props.request, () => { if (preview.value || loading.value) stale.value = true })
watch(() => props.modelValue, open => {
  if (open) { preview.value = undefined; query.value = ''; void refresh() }
  else { requestEpoch++; loading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { requestEpoch++ })
</script>

<template>
  <Modal :model-value="modelValue" title="当前提示词预览" width="min(1120px, calc(100vw - 24px))" body-padding="compact"
    @update:model-value="emit('update:modelValue', $event)">
    <section class="prompt-preview">
      <div class="preview-toolbar">
        <div class="preview-views" aria-label="提示词查看方式">
          <button :aria-pressed="view === 'messages'" @click="view = 'messages'">按消息阅读</button>
          <button :aria-pressed="view === 'json'" @click="view = 'json'">完整 JSON</button>
        </div>
        <button :disabled="loading" @click="refresh">{{ loading ? '正在组装…' : '更新预览' }}</button>
        <button :disabled="!preview || loading" @click="copy">{{ copied ? '已复制 JSON' : '复制完整请求' }}</button>
      </div>
      <p v-if="preview" class="preview-meta">{{ preview.model }} · {{ preview.protocol }} · 约 {{ preview.estimatedTokens.toLocaleString() }} 输入 Token（本地估算） · {{ new Date(preview.createdAt).toLocaleTimeString() }}</p>
      <p v-if="stale" class="preview-notice">输入或模型选择已变化，点击“更新预览”查看当前内容。</p>
      <p v-if="running" class="preview-notice">当前任务仍在运行，发送时会使用那一刻的最新历史。</p>
      <p v-for="notice in preview?.notices ?? []" :key="notice" class="preview-notice">{{ notice }}</p>
      <p v-if="error" role="alert" class="preview-error">{{ error }}</p>
      <input v-if="view === 'messages' && preview" v-model="query" type="search" placeholder="查找提示词中的内容" aria-label="查找提示词内容" />
      <div class="preview-content" :aria-busy="loading">
        <p v-if="loading && !preview" class="preview-empty">正在读取当前草稿、历史与预设…</p>
        <template v-else-if="preview">
          <pre v-if="view === 'json'" class="preview-json">{{ json }}</pre>
          <template v-else>
            <details v-for="(group, index) in groups" :key="`${group.title}:${index}`" :open="!!query || !['tools', 'toolConfig', '模型参数与其他字段'].includes(group.title)" class="preview-group">
              <summary>{{ group.title }}<span>{{ group.text.length.toLocaleString() }} 字符</span></summary>
              <pre>{{ group.text }}</pre>
            </details>
            <p v-if="!groups.length" class="preview-empty">没有匹配的内容。</p>
            <details v-if="preview.character" class="preview-group"><summary>角色卡与世界书激活结果</summary><pre>{{ JSON.stringify(preview.character, null, 2) }}</pre></details>
          </template>
        </template>
      </div>
      <p class="preview-caption">预览包含当前草稿，不会发送消息。实际发送时会重新读取文件、历史和动态变量。</p>
    </section>
  </Modal>
</template>

<style scoped>
.prompt-preview { display: flex; flex-direction: column; gap: 10px; min-width: 0; height: min(76vh, 900px); }
.preview-toolbar, .preview-views { display: flex; flex-wrap: wrap; gap: 6px; }
.preview-views { margin-right: auto; }
button, input { font: inherit; font-size: 12px; color: var(--vscode-foreground); border: 1px solid var(--gc-border-control); border-radius: 0; background: var(--vscode-input-background); padding: 7px 10px; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button[aria-pressed=true] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
input { width: 100%; min-width: 0; box-sizing: border-box; }
.preview-meta, .preview-notice, .preview-error, .preview-caption { margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.preview-meta, .preview-caption, .preview-empty { color: var(--vscode-descriptionForeground); }
.preview-notice { padding: 7px 10px; background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-focusBorder); }
.preview-error { color: var(--vscode-errorForeground); }
.preview-content { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--gc-border-control); background: var(--vscode-editor-background); }
.preview-group { border-bottom: 1px solid var(--gc-border-control); }
.preview-group:last-child { border-bottom: 0; }
summary { padding: 10px 12px; cursor: pointer; color: var(--vscode-foreground); font-size: 12px; font-weight: 600; background: var(--vscode-sideBar-background); }
summary span { float: right; color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 10px; }
pre { margin: 0; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; font: 12px/1.7 var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground); }
.preview-empty { padding: 12px; font-size: 13px; }
@media (max-width: 520px) { .preview-views { flex-basis: 100%; } .preview-views button { flex: 1; } .prompt-preview { height: 78vh; gap: 8px; } summary span { float: none; display: block; margin: 4px 0 0 16px; } }
</style>
