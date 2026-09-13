<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { sendToExtension } from '@/utils/vscode'

interface Installation {
  kind: 'installed' | 'portable'
  currentVersion: string
  rootDirectory?: string
  busy: boolean
  progress?: { phase: string; percent?: number }
  ready?: { version: string }
  recovery?: { version: string; targetVersion: string; createdAt: string; backupPath: string }
  transitionResult?: string
}
const installation = ref<Installation>()
const working = ref(false)
const message = ref('')
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const phaseNames: Record<string, string> = { checking: '正在检查更新', downloading: '正在下载并校验', backup: '正在备份当前数据' }
async function refresh() {
  installation.value = await sendToExtension<Installation>('desktop.updates.status', {})
}
async function observe() {
  if (disposed) return
  await refresh().catch(() => {})
  if (working.value || installation.value?.busy) timer = setTimeout(() => { void observe() }, 1000)
}
async function action(method: string) {
  if (working.value) return
  working.value = true; message.value = ''; failed.value = false
  void observe()
  try {
    const result = await sendToExtension<any>(method, {})
    if (result?.cancelled) return
    message.value = result?.message || (result?.downloaded ? `版本 ${result.version} 已准备，请保存编辑后重启安装。`
      : result?.alreadyUpToDate ? '当前没有更高版本。'
      : result?.restarting ? '正在退出后台服务，随后安装并重新打开。'
      : result?.status?.message || (result?.status?.update ? `发现版本 ${result.status.update.version}。` : ''))
  } catch (error) { failed.value = true; message.value = error instanceof Error ? error.message : String(error) }
  finally { working.value = false; await refresh().catch(() => {}) }
}
onMounted(() => { void refresh().then(() => { if (installation.value?.busy) void observe() }).catch(error => { failed.value = true; message.value = String(error) }) })
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer) })
</script>

<template>
  <div class="desktop-update" data-preference-transient data-desktop-update>
    <p v-if="installation">{{ installation.kind === 'installed' ? '安装版' : '便携版' }} · {{ installation.currentVersion }}</p>
    <p v-if="installation?.rootDirectory" class="path">{{ installation.rootDirectory }}</p>
    <p v-if="installation?.kind === 'portable'">下载 Windows 安装器后，可在这里安装更新和恢复上一版本。现有数据目录可以继续使用。</p>
    <div class="actions">
      <button type="button" class="gc-button" :disabled="working || installation?.busy" @click="action('checkUpdateNow')">检查更新</button>
      <template v-if="installation?.kind === 'installed'">
        <button type="button" class="gc-button" :disabled="working || installation.busy" @click="action('updateNow')">下载更新</button>
        <button type="button" class="gc-button" :disabled="working || installation.busy" @click="action('desktop.updates.local')">选择离线更新</button>
      </template>
      <button type="button" class="gc-button gc-button--ghost" @click="action('openUpdatePage')">打开发行页面</button>
    </div>
    <p v-if="installation?.progress" role="status">{{ phaseNames[installation.progress.phase] || installation.progress.phase }}{{ installation.progress.percent === undefined ? '…' : ` ${installation.progress.percent}%` }}</p>
    <div v-if="installation?.ready" class="ready">
      <p>版本 {{ installation.ready.version }} 已下载并校验。安装前会保留当前程序包和数据备份。</p>
      <button type="button" class="gc-button gc-button--primary" :disabled="working || installation.busy" @click="action('desktop.updates.apply')">重启并安装</button>
    </div>
    <div v-if="installation?.recovery" class="recovery">
      <p>回退点：{{ installation.recovery.version }} · {{ new Date(installation.recovery.createdAt).toLocaleString() }}</p>
      <p>恢复上一版本时会同时恢复更新前数据，并另存当前数据。恢复后的后台连接需要手动开启。</p>
      <p>若安装中断导致无法启动，可在恢复文件夹运行 Restore-GrayCode.cmd 修复程序文件。</p>
      <div class="actions">
        <button type="button" class="gc-button" :disabled="working || installation.busy || installation.recovery.version === installation.currentVersion" @click="action('desktop.updates.rollback')">恢复上一版本与数据</button>
        <button type="button" class="gc-button gc-button--ghost" @click="action('desktop.updates.openRecovery')">打开恢复文件夹</button>
      </div>
      <p v-if="installation.transitionResult === 'not-applied'" role="status">上次版本切换未完成，当前仍运行 {{ installation.currentVersion }}。可重新安装，或打开恢复文件夹。</p>
    </div>
    <p v-if="message" :class="{ error: failed }" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </div>
</template>

<style scoped>
.desktop-update { display: grid; gap: 10px; margin-top: 12px; font-size: var(--gc-font-size-control); }
p { margin: 0; line-height: 1.6; color: var(--gc-text-muted); overflow-wrap: anywhere; }
.path { font-family: var(--gc-font-mono, monospace); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ready, .recovery { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--gc-border); background: var(--gc-surface-muted); }
.error { color: var(--gc-danger); }
</style>
