<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { UI_FILE_UPLOAD_LIMIT, type FileEntryInfo } from '@graycode/contracts';
import { call } from '../api';
import { state } from '../state';
import type { FileDialogRequest } from './files/types';
const props = defineProps<{ request: FileDialogRequest }>();
const emit = defineEmits<{ close: []; changed: [path: string, workspaceId: string, open: boolean] }>();
const target = ref(props.request.path); const input = ref<HTMLInputElement>();
const currentEntry = ref(props.request.entry);
const busy = ref(false); const error = ref(''); const scanning = ref(false); const stopping = ref(false);
const rows = ref((props.request.files ?? []).map(file => ({ file, name: file.name, entry: undefined as FileEntryInfo | undefined, overwrite: false, status: 'ready', error: '' })));
const workspaceName = computed(() => state.snapshot?.settings.workspaces.find(item => item.id === props.request.workspaceId)?.name ?? props.request.workspaceId);
const titles = { file: '新建文件', directory: '新建目录', move: '重命名或移动', remove: '删除目录项', upload: '上传文件' };
const title = computed(() => props.request.kind === 'remove' ? currentEntry.value?.kind === 'directory' ? '删除目录' : currentEntry.value?.kind === 'symlink' ? '删除链接' : '删除文件' : titles[props.request.kind]);
const hasCompleted = computed(() => rows.value.some(row => row.status === 'done'));
const canUpload = computed(() => rows.value.some(row => row.status !== 'done') && rows.value.filter(row => row.status !== 'done').every(row => !row.error && row.entry && (row.entry.kind === 'missing' || row.entry.kind === 'file' && row.overwrite)));
const destination = (name: string) => [target.value.trim().replace(/[\\/]+$/, '').replace(/^\.$/, ''), name.trim()].filter(Boolean).join('/');
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
let scanTimer: ReturnType<typeof setTimeout> | undefined; let scanEpoch = 0;
function scheduleScan() {
  ++scanEpoch; scanning.value = true;
  for (const row of rows.value.filter(row => row.status !== 'done')) { row.entry = undefined; row.overwrite = false; row.error = ''; }
  if (scanTimer) clearTimeout(scanTimer); scanTimer = setTimeout(() => { scanTimer = undefined; void scan(); }, 180);
}
async function scan() {
  const epoch = ++scanEpoch; scanning.value = true;
  const names = rows.value.map(row => destination(row.name));
  await Promise.all(rows.value.map(async (row, index) => {
    if (row.status === 'done') return;
    try {
      if (row.file.size > UI_FILE_UPLOAD_LIMIT) throw new Error('单个文件不能超过 64 MiB。');
      if (!row.name.trim() || names.filter(name => name === names[index]).length > 1) throw new Error('目标文件名不能为空或重复。');
      const entry = await call<FileEntryInfo>('files.inspect', { workspaceId: props.request.workspaceId, path: names[index] });
      if (epoch !== scanEpoch) return;
      row.entry = entry; row.overwrite = false; row.error = ['file', 'missing'].includes(entry.kind) ? '' : '目标是目录或链接，请更换文件名。';
    } catch (cause) { if (epoch === scanEpoch) row.error = (cause as Error).message; }
  }));
  if (epoch === scanEpoch) scanning.value = false;
}
async function submit() {
  if (busy.value || scanning.value) return;
  if (props.request.kind === 'upload' && !canUpload.value) return;
  busy.value = true; error.value = ''; stopping.value = false;
  try {
    const base = { workspaceId: props.request.workspaceId, path: props.request.path };
    if (props.request.kind === 'upload') {
      for (const row of rows.value) {
        if (stopping.value) break;
        if (row.status === 'done') continue;
        row.status = 'uploading';
        try {
          const result = await call<FileEntryInfo>('files.upload', { workspaceId: base.workspaceId, path: destination(row.name), expectedVersion: row.entry!.version, bytes: new Uint8Array(await row.file.arrayBuffer()) });
          row.status = 'done'; row.error = ''; emit('changed', result.path, base.workspaceId, false);
        } catch (cause) { row.status = 'error'; row.error = (cause as Error).message; break; }
      }
      if (rows.value.every(row => row.status === 'done')) emit('close');
      return;
    }
    if (props.request.kind === 'remove') {
      await call('files.remove', { ...base, expectedVersion: currentEntry.value!.version, recursive: currentEntry.value?.kind === 'directory' });
      emit('changed', props.request.path, base.workspaceId, false);
    } else {
      const result = await call<FileEntryInfo>(props.request.kind === 'move' ? 'files.move' : 'files.create', props.request.kind === 'move'
        ? { ...base, target: target.value.trim(), expectedVersion: currentEntry.value!.version }
        : { ...base, path: target.value.trim(), kind: props.request.kind });
      emit('changed', result.path, base.workspaceId, props.request.kind === 'file');
    }
    emit('close');
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
function dismiss() { if (!busy.value) emit('close'); }
async function refreshEntry() {
  busy.value = true;
  try { currentEntry.value = await call<FileEntryInfo>('files.inspect', { workspaceId: props.request.workspaceId, path: props.request.path }); error.value = ''; }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(async () => {
  if (props.request.kind === 'upload') await scan();
  else { await nextTick(); input.value?.focus(); if (props.request.kind === 'move') input.value?.setSelectionRange(target.value.lastIndexOf('/') + 1, target.value.length); }
});
onUnmounted(() => { stopping.value = true; ++scanEpoch; if (scanTimer) clearTimeout(scanTimer); });
</script>
<template>
  <div class="file-dialog-backdrop" @click.self="dismiss" @keydown.esc="dismiss"><form class="workspace-file-dialog" role="dialog" aria-modal="true" :aria-label="title" @submit.prevent="submit">
    <header><h2>{{ title }}</h2><button type="button" aria-label="关闭文件操作" :disabled="busy" @click="dismiss">×</button></header>
    <p class="file-workspace">工作区：{{ workspaceName }}</p>
    <template v-if="request.kind === 'remove'"><p>将删除 <strong>{{ request.path }}</strong>{{ currentEntry?.kind === 'directory' ? ' 及其全部内容' : '' }}。此操作无法在应用内撤销。</p><p>有未保存内容的文件会阻止删除。</p></template>
    <template v-else><label>{{ request.kind === 'upload' ? '目标目录（相对于工作区）' : '目标路径（相对于工作区）' }}<input ref="input" v-model="target" :disabled="busy || hasCompleted" required spellcheck="false" autocapitalize="off" @input="request.kind === 'upload' && scheduleScan()" /></label><p v-if="request.kind === 'move'">当前位置：{{ request.path }}。目标的上级目录需要已经存在。</p></template>
    <div v-if="request.kind === 'upload'" class="file-upload-list"><div v-for="(row, index) in rows" :key="index" class="file-upload-row"><div><strong>{{ row.file.name }}</strong><span>{{ size(row.file.size) }}</span></div><input v-model="row.name" :aria-label="`上传目标 ${index + 1}`" :disabled="busy || row.status === 'done'" @input="scheduleScan" /><p v-if="row.status === 'done'">已上传</p><p v-else-if="row.status === 'uploading'" role="status">正在上传…</p><p v-else-if="row.error" class="file-operation-error">{{ row.error }}</p><label v-else-if="row.entry?.kind === 'file'" class="file-overwrite"><input v-model="row.overwrite" type="checkbox" :disabled="busy" />目标文件已存在，确认替换磁盘内容</label></div></div>
    <p v-if="request.kind === 'upload'">单个文件最多 64 MiB，按顺序上传。遇到冲突时会停止，已经完成的文件保留。</p>
    <p v-if="error" class="file-operation-error" role="alert">{{ error }}</p>
    <div v-if="currentEntry" class="file-entry-version"><span>最近修改：{{ currentEntry.modifiedAt ? new Date(currentEntry.modifiedAt).toLocaleString() : '目录项已不存在' }}</span><button v-if="error" type="button" :disabled="busy" @click="refreshEntry">重新读取</button></div>
    <footer><button v-if="request.kind === 'upload' && !busy" type="button" :disabled="scanning" @click="scan">重新检查</button><button v-if="busy && request.kind === 'upload'" type="button" @click="stopping = true">{{ stopping ? '当前文件完成后停止' : '停止后续上传' }}</button><button type="button" :disabled="busy" @click="dismiss">取消</button><button :class="request.kind === 'remove' ? 'danger' : 'primary'" :disabled="busy || scanning || request.kind === 'upload' && !canUpload">{{ busy ? '正在处理…' : scanning ? '正在检查…' : request.kind === 'remove' ? '确认删除' : request.kind === 'upload' ? '开始上传' : '确定' }}</button></footer>
  </form></div>
</template>
<style scoped>
.file-dialog-backdrop{position:fixed;inset:0;background:#0009;z-index:10040;display:grid;place-items:center;padding:20px}.workspace-file-dialog{width:min(560px,100%);max-height:calc(100dvh - 40px);overflow:auto;padding:22px;background:var(--panel);border:1px solid var(--border);font-size:14px}.workspace-file-dialog header{display:flex;align-items:center;justify-content:space-between;gap:18px}.workspace-file-dialog h2{font-size:20px;margin:0}.workspace-file-dialog header button{font-size:20px;border:0;background:transparent;padding:3px 8px}.workspace-file-dialog p{line-height:1.7;overflow-wrap:anywhere}.file-workspace{color:var(--muted)}.workspace-file-dialog label:not(.file-overwrite){display:grid;gap:10px}.workspace-file-dialog input:not([type=checkbox]){width:100%;font-family:var(--code-font)}.workspace-file-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px;flex-wrap:wrap}.file-upload-list{margin-top:20px}.file-upload-row{padding:13px 0;border-top:1px solid var(--border)}.file-upload-row>div{display:flex;justify-content:space-between;gap:18px;margin-bottom:8px}.file-upload-row strong{overflow-wrap:anywhere}.file-upload-row span{color:var(--muted);white-space:nowrap}.file-overwrite{display:flex;gap:10px;align-items:center;margin-top:10px;font-size:12px}.file-overwrite input{width:18px;height:18px;accent-color:var(--accent);flex-shrink:0}.file-operation-error,.danger{color:#ef9494}@media(max-width:600px){.file-dialog-backdrop{padding:12px}.workspace-file-dialog{padding:18px;max-height:calc(100dvh - 24px)}.workspace-file-dialog input:not([type=checkbox]){font-size:16px}}
</style>
