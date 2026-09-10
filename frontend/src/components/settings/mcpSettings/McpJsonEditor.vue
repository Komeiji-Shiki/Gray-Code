<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useDesktopSettingsDraft } from '@/platform/settingsDraft'
const emit = defineEmits<{ close: []; applied: [] }>()
const source = ref('')
const loaded = ref(false)
const error = ref('')
const saving = ref(false)
let accepted = ''
let cancelled = false
onMounted(async () => {
  try { source.value = accepted = JSON.stringify(await sendToExtension('mcp.getJson', {}), null, 2); loaded.value = true }
  catch (failure) { error.value = (failure as Error).message }
})
async function apply() {
  if (source.value === accepted) return
  saving.value = true; error.value = ''
  try {
    await sendToExtension('mcp.replaceJson', { config: JSON.parse(source.value) })
    accepted = source.value; emit('applied')
  } catch (failure) { error.value = (failure as Error).message; throw failure }
  finally { saving.value = false }
}
async function done() { try { await apply(); emit('close') } catch {} }
function cancel() { cancelled = true; emit('close') }
useDesktopSettingsDraft(apply, () => loaded.value && !cancelled && !saving.value)
</script>
<template>
  <div class="mcp-json-editor">
    <h3>MCP 配置 JSON</h3>
    <p>可粘贴常见的 mcpServers 配置。修改先进入设置草稿，统一保存后生效。</p>
    <textarea v-model="source" aria-label="MCP 配置 JSON" spellcheck="false" :disabled="!loaded || saving"></textarea>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="actions"><button @click="cancel">取消本次修改</button><button :disabled="!loaded || saving" @click="done">写入草稿并返回</button></div>
  </div>
</template>
<style scoped>
.mcp-json-editor { display: flex; flex-direction: column; gap: 12px; }
h3,p { margin: 0; } p { color: var(--vscode-descriptionForeground); }
textarea { width: 100%; min-height: 420px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); padding: 12px; font: 13px/1.5 var(--vscode-editor-font-family); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
button { padding: 7px 12px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
.error { color: var(--vscode-errorForeground); }
</style>
