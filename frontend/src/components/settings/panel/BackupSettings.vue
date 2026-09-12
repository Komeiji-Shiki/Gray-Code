<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { sendToExtension, onExtensionCommand } from '@/utils/vscode'
import type { BackupProgress, PendingBackupRestore } from '@graycode/contracts'

const password = ref('')
const busy = ref(false)
const progress = ref<BackupProgress>()
const pending = ref<PendingBackupRestore>()
const previousPath = ref('')
const error = ref('')
const percentage = computed(() => progress.value?.totalBytes
  ? Math.min(100, Math.round((progress.value.processedBytes ?? 0) / progress.value.totalBytes * 100)) : undefined)
const removeListener = onExtensionCommand<BackupProgress>('backup.progress', value => { progress.value = value })
onUnmounted(removeListener)
async function refresh() {
  const value = await sendToExtension<any>('backup.status', {})
  busy.value = value.busy; progress.value = value.progress; pending.value = value.pending
  previousPath.value = value.lastRestore?.previousPath ?? ''
}
onMounted(() => { void refresh().catch(reason => { error.value = String(reason.message ?? reason) }) })
async function perform(method: string) {
  busy.value = true; error.value = ''
  try {
    const result = await sendToExtension<any>(method, { password: password.value }, { timeoutMs: 0 })
    if (!result?.cancelled) password.value = ''
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false; await refresh().catch(reason => { error.value = String(reason.message ?? reason) }) }
}
async function cancel() {
  try { await sendToExtension('backup.cancel', {}) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function revealPrevious() {
  try { await sendToExtension('storagePath.openInExplorer', { path: previousPath.value }) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
</script>

<template>
  <section class="backup-settings form-group" data-search-anchor="backup">
    <label class="group-label"><i class="codicon codicon-database"></i>程序数据备份</label>
    <p class="field-description">备份对话、附件、分支与检查点、任务记录、设置、角色、记忆和本地技能。项目源码保留在项目目录，不随备份复制。</p>
    <div class="backup-controls">
      <label for="backup-password">备份密码 <span>可选</span></label>
      <input id="backup-password" v-model="password" type="password" autocomplete="new-password" :disabled="busy"
        placeholder="设置密码可加密备份，并携带密钥跨设备恢复" />
      <p class="field-hint">留空适合本机恢复，API 密钥仍受本机系统保护。恢复加密备份时，请输入导出时使用的密码。</p>
      <div class="backup-actions">
        <button class="action-btn primary" :disabled="busy" @click="perform('backup.export')"><i class="codicon codicon-cloud-download"></i>创建备份</button>
        <button class="action-btn" :disabled="busy || !!pending" @click="perform('backup.restore')"><i class="codicon codicon-history"></i>选择备份恢复</button>
        <button v-if="busy" class="action-btn" @click="cancel">取消操作</button>
      </div>
    </div>
    <div v-if="progress && !(pending && progress.operation === 'restore' && progress.phase === 'ready')" class="backup-progress" role="status" aria-live="polite">
      <div><i v-if="busy" class="codicon codicon-loading codicon-modifier-spin"></i>{{ progress.message }}<span v-if="busy && percentage !== undefined">{{ percentage }}%</span></div>
      <progress v-if="busy" :value="percentage" max="100" aria-label="备份进度"></progress>
      <code v-if="progress.filePath" :title="progress.filePath">{{ progress.filePath }}</code>
    </div>
    <div v-if="pending" class="backup-pending">
      <strong>备份已校验，等待确认恢复</strong>
      <p>{{ new Date(pending.backupCreatedAt).toLocaleString() }} · {{ pending.conversations }} 个对话 · {{ pending.messages }} 条消息</p>
      <p>恢复前的数据会保留为独立目录，可以随时找回。</p>
      <div class="backup-actions">
        <button class="action-btn primary" :disabled="busy" @click="perform('backup.restart')">重启并恢复</button>
        <button class="action-btn" :disabled="busy" @click="perform('backup.cancelRestore')">取消恢复</button>
      </div>
    </div>
    <p v-if="previousPath" class="backup-previous">恢复前的数据：<code>{{ previousPath }}</code>
      <button class="action-btn" @click="revealPrevious">打开目录</button>
    </p>
    <p v-if="error" class="error-hint" role="alert">{{ error }}</p>
    <details class="backup-scope">
      <summary>备份范围与恢复说明</summary>
      <p>运行依赖、分词词表和浏览器缓存可重新下载；网站登录状态、共享 .agents / .limcode 技能、项目技能、未保存的草稿和运行中的进程不包含在此备份中。</p>
      <p>可以在任务运行时备份。恢复会停止当前任务和连接，旧任务的文件事务不会自动重放，项目源码不会被回滚。已保存的渠道、Bot 和远程访问配置会随数据恢复。</p>
    </details>
  </section>
</template>

<style scoped>
.backup-settings { min-width: 0; }
.group-label { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 14px; font-weight: 600; }
.field-description, .field-hint { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.7; }
.field-description { margin: 0 0 15px; }
.field-hint { margin: 0 0 3px; }
.error-hint { color: var(--vscode-errorForeground); overflow-wrap: anywhere; font-size: 12px; }
.backup-controls { display: grid; gap: 9px; }
.backup-controls label { font-size: 12px; font-weight: 600; }
.backup-controls label span { margin-left: 6px; color: var(--vscode-descriptionForeground); font-weight: 400; }
.backup-controls input { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
.backup-controls input:focus { outline: 1px solid var(--vscode-focusBorder); }
.backup-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.action-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 0; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-size: 12px; cursor: pointer; }
.action-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.action-btn:disabled { opacity: .5; cursor: default; }
.action-btn:hover:enabled { filter: brightness(1.12); }
.backup-progress, .backup-pending { margin-top: 14px; padding: 12px; background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border); }
.backup-progress > div { display: flex; align-items: center; gap: 8px; }
.backup-progress span { margin-left: auto; }
.backup-progress progress { display: block; width: 100%; height: 3px; margin: 10px 0; accent-color: var(--vscode-focusBorder); }
.backup-progress code { display: block; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
.backup-pending p, .backup-scope p { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.7; }
.backup-previous { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.backup-previous code { overflow-wrap: anywhere; }
.backup-scope { margin-top: 16px; font-size: 12px; }
.backup-scope summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
</style>
