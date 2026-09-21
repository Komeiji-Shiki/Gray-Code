<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { DirectoryEntry } from '@graycode/contracts';
import { rpc as call, subscribe } from '../api';
import { guard, state } from '../state';
import { useWorkspaceRoots } from '../workspaceRoots';
import WorkspaceFileDialog from './WorkspaceFileDialog.vue';
import type { FileDialogRequest } from './files/types';
const emit = defineEmits<{ open: [path: string, workspaceId: string]; hide: [] }>();
const isWeb = window.graycode?.kind === 'web';
const { roots } = useWorkspaceRoots();
const rootPaths = computed(() => new Set(roots.value.length > 1 ? roots.value.map(root => '@' + root.name) : []));
const canCreate = computed(() => !!state.workspaceId && (roots.value.length < 2 || folder.value !== '.'));
const isRoot = (entry: DirectoryEntry) => rootPaths.value.has(entry.path);
const children = ref<Record<string, DirectoryEntry[]>>({});
const expanded = ref(new Set(['.']));
const selected = ref<DirectoryEntry>();
const menu = ref<{ entry: DirectoryEntry; workspaceId: string; x: number; y: number }>();
const dialog = ref<FileDialogRequest>();
const uploadInput = ref<HTMLInputElement>();
const viewport = ref<HTMLElement>();
const viewportHeight = ref(0);
const scrollTop = ref(0);
const rowHeight = ref(28);
const compactScreen = window.matchMedia('(max-width: 600px)');
let resizeObserver: ResizeObserver | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refreshDirectories = new Set<string>();
const loadVersions = new Map<string, number>();
let treeEpoch = 0;
const folder = computed(() => selected.value?.kind === 'directory' ? selected.value.path : selected.value?.path.split('/').slice(0, -1).join('/') || '.');
const nodes = computed(() => {
  const output: (DirectoryEntry & { depth: number })[] = [];
  function visit(directory: string, depth: number) {
    for (const entry of children.value[directory] ?? []) {
      output.push({ ...entry, depth });
      if (expanded.value.has(entry.path)) visit(entry.path, depth + 1);
    }
  }
  visit('.', 0); return output;
});
// 固定行高只渲染视口附近的目录项，展开状态和选择状态仍属于完整文件树。
const startRow = computed(() => Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - 8));
const visibleNodes = computed(() => nodes.value.slice(startRow.value,
  Math.ceil((scrollTop.value + viewportHeight.value) / rowHeight.value) + 8));
function measure() {
  rowHeight.value = compactScreen.matches ? 38 : 28;
  viewportHeight.value = viewport.value?.clientHeight ?? 0;
}
onMounted(() => {
  measure(); resizeObserver = new ResizeObserver(measure);
  if (viewport.value) resizeObserver.observe(viewport.value);
  compactScreen.addEventListener('change', measure);
});
async function load(directory = '.') {
  const workspaceId = state.workspaceId; const epoch = treeEpoch;
  if (!workspaceId) return;
  const version = (loadVersions.get(directory) ?? 0) + 1; loadVersions.set(directory, version);
  try {
    const entries = await call('files.list', { workspaceId, path: directory });
    if (epoch === treeEpoch && workspaceId === state.workspaceId && loadVersions.get(directory) === version) {
      children.value[directory] = entries; return true;
    }
  } catch (error) {
    if (epoch !== treeEpoch || workspaceId !== state.workspaceId || loadVersions.get(directory) !== version) return;
    if (directory !== '.') { expanded.value.delete(directory); delete children.value[directory]; }
    else throw error;
  }
}
async function refresh() { await Promise.all([...expanded.value].map(directory => load(directory))); }
const parentDirectory = (path: string) => path.split('/').slice(0, -1).join('/') || '.';
function scheduleRefresh(directories: Iterable<string>) {
  for (const directory of directories) if (expanded.value.has(directory)) refreshDirectories.add(directory);
  if (refreshTimer !== undefined || !refreshDirectories.size) return;
  refreshTimer = setTimeout(async () => {
    const pending = [...refreshDirectories]; refreshDirectories.clear();
    try { await guard(() => Promise.all(pending.map(directory => load(directory)))); }
    finally { refreshTimer = undefined; scheduleRefresh([]); }
  }, 16);
}
async function click(entry: DirectoryEntry) {
  selected.value = entry;
  if (entry.kind === 'directory') {
    if (expanded.value.has(entry.path)) expanded.value.delete(entry.path);
    else { const epoch = treeEpoch; if (await load(entry.path) && epoch === treeEpoch) expanded.value.add(entry.path); }
  } else emit('open', entry.path, state.workspaceId);
}
async function navigate(event: KeyboardEvent, entry: DirectoryEntry) {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  let index = nodes.value.findIndex(node => node.path === entry.path);
  if (event.key === 'ArrowRight' && entry.kind === 'directory' && !expanded.value.has(entry.path)) { await click(entry); return; }
  if (event.key === 'ArrowLeft') {
    if (entry.kind === 'directory' && expanded.value.has(entry.path)) { await click(entry); return; }
    index = nodes.value.findIndex(node => node.path === parentDirectory(entry.path));
  } else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = nodes.value.length - 1;
  else index += event.key === 'ArrowUp' ? -1 : 1;
  const target = nodes.value[index]; if (!target || !viewport.value) return;
  selected.value = target;
  const top = index * rowHeight.value;
  if (top < scrollTop.value) viewport.value.scrollTop = top;
  else if (top + rowHeight.value > scrollTop.value + viewportHeight.value) viewport.value.scrollTop = top + rowHeight.value - viewportHeight.value;
  scrollTop.value = viewport.value.scrollTop;
  await nextTick();
  const row = [...viewport.value.querySelectorAll<HTMLElement>('[data-path]')].find(element => element.dataset.path === target.path);
  row?.querySelector<HTMLButtonElement>('.tree-row')?.focus();
}
function showMenu(event: MouseEvent, entry: DirectoryEntry) {
  selected.value = entry;
  if (isRoot(entry)) { menu.value = undefined; return; }
  menu.value = { entry, workspaceId: state.workspaceId, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)) };
}
async function editEntry(kind: 'move' | 'remove') {
  const chosen = menu.value; menu.value = undefined; if (!chosen) return;
  const entry = await call('files.inspect', { workspaceId: chosen.workspaceId, path: chosen.entry.path });
  if (state.workspaceId !== chosen.workspaceId) return;
  if (entry.kind === 'missing') throw new Error('目录项已经不存在，请刷新文件列表。');
  dialog.value = { kind, workspaceId: chosen.workspaceId, path: entry.path, entry };
}
function create(kind: 'file' | 'directory') {
  dialog.value = { kind, workspaceId: state.workspaceId, path: folder.value === '.' ? '' : folder.value + '/' };
}
function chooseUpload(event: Event) {
  const input = event.target as HTMLInputElement; const files = [...input.files ?? []]; input.value = '';
  if (files.length) dialog.value = { kind: 'upload', workspaceId: state.workspaceId, path: folder.value, files };
}
async function changed(path: string, workspaceId: string, open: boolean) {
  if (workspaceId === state.workspaceId) await load(parentDirectory(path));
  if (open) emit('open', path, workspaceId);
}
async function download() {
  const chosen = menu.value; menu.value = undefined;
  if (chosen) await call('files.download', { workspaceId: chosen.workspaceId, path: chosen.entry.path });
}
watch([menu, dialog], () => { state.fileDialogOpen = !!menu.value || !!dialog.value; });
watch([() => state.workspaceId, () => JSON.stringify(roots.value)], () => {
  ++treeEpoch; children.value = {}; expanded.value = new Set(['.']); selected.value = undefined; menu.value = undefined;
  refreshDirectories.clear(); loadVersions.clear(); scrollTop.value = 0;
  if (viewport.value) viewport.value.scrollTop = 0;
  void guard(() => load());
}, { immediate: true });
watch(() => nodes.value.length, () => {
  const maximum = Math.max(0, nodes.value.length * rowHeight.value - viewportHeight.value);
  if (scrollTop.value > maximum) { scrollTop.value = maximum; if (viewport.value) viewport.value.scrollTop = maximum; }
});
const unsubscribe = subscribe(event => {
  if (event.type === 'workspace.entry.changed' && event.workspaceId === state.workspaceId) {
    if (event.kind === 'move' || event.kind === 'remove') {
      for (const directory of [...expanded.value]) if (directory === event.from || directory.startsWith(event.from + '/')) {
        expanded.value.delete(directory); delete children.value[directory];
        if (event.to) expanded.value.add(event.to + directory.slice(event.from.length));
      }
      if (selected.value && (selected.value.path === event.from || selected.value.path.startsWith(event.from + '/'))) {
        const path = event.to ? event.to + selected.value.path.slice(event.from.length) : undefined;
        selected.value = path ? { ...selected.value, path, name: path.split('/').at(-1)! } : undefined;
      }
    }
    const affected = [parentDirectory(event.from), ...(event.to ? [parentDirectory(event.to)] : [])];
    if (event.kind === 'move' && event.to) for (const directory of expanded.value)
      if (directory === event.to || directory.startsWith(event.to + '/')) affected.push(directory);
    scheduleRefresh(affected);
  } else if (event.type === 'file.changed' && event.workspaceId === state.workspaceId) scheduleRefresh([parentDirectory(event.path)]);
  else if (event.type === 'workspace.git.changed' && event.workspaceId === state.workspaceId) scheduleRefresh(expanded.value);
});
onUnmounted(() => {
  ++treeEpoch; unsubscribe(); state.fileDialogOpen = false; resizeObserver?.disconnect();
  compactScreen.removeEventListener('change', measure); clearTimeout(refreshTimer); refreshDirectories.clear();
});
</script>
<template>
  <section class="file-tree">
    <header class="panel-heading"><span>文件</span><button class="icon-button" title="刷新文件" @click="guard(refresh)">↻</button><button class="icon-button" title="隐藏文件列表" @click="emit('hide')">‹</button></header>
    <div class="file-tree-actions"><button :disabled="!canCreate" title="新建文件" @click="create('file')">新建文件</button><button :disabled="!canCreate" title="新建目录" @click="create('directory')">目录＋</button><button :disabled="!canCreate" title="上传文件" @click="uploadInput?.click()">上传</button><input ref="uploadInput" type="file" multiple hidden aria-label="选择上传文件" @change="chooseUpload" /></div>
    <div v-if="state.workspaceId" class="file-tree-location" :title="folder">位置：{{ folder === '.' ? roots.length > 1 ? '选择一个目录后新建或上传文件' : '工作区根目录' : folder }}</div>
    <div v-else class="empty-note">选择工作区以浏览文件。</div>
    <div ref="viewport" class="file-tree-viewport" :style="{ '--file-row-height': rowHeight + 'px' }" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
    <div class="file-tree-spacer" :style="{ height: nodes.length * rowHeight + 'px' }">
    <div class="file-tree-visible" :style="{ transform: `translateY(${startRow * rowHeight}px)` }">
    <div v-for="entry in visibleNodes" :key="entry.path" :data-path="entry.path" class="file-tree-entry" :class="{ selected: selected?.path === entry.path }" @contextmenu.prevent="showMenu($event, entry)">
      <button class="tree-row" :style="{ paddingLeft: `${12 + entry.depth * 15}px` }" :title="entry.path" @click="guard(() => click(entry))" @keydown="guard(() => navigate($event, entry))"><span class="file-glyph">{{ entry.kind === 'directory' ? expanded.has(entry.path) ? '⌄' : '›' : entry.kind === 'symlink' ? '↗' : '·' }}</span><span class="file-name">{{ entry.name }}</span></button>
      <button v-if="!isRoot(entry)" class="file-entry-more" :aria-label="`操作 ${entry.name}`" title="文件操作" @click="showMenu($event, entry)">⋯</button>
    </div>
    </div>
    </div>
    </div>
    <Teleport to=".application">
      <template v-if="menu"><div class="file-menu-backdrop" @pointerdown="menu = undefined"></div><div class="file-entry-menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }"><button role="menuitem" @click="guard(() => editEntry('move'))">重命名或移动</button><button v-if="menu.entry.kind !== 'directory'" role="menuitem" @click="guard(download)">{{ isWeb ? '下载文件' : '另存文件' }}</button><button role="menuitem" class="danger" @click="guard(() => editEntry('remove'))">删除</button></div></template>
      <WorkspaceFileDialog v-if="dialog" :request="dialog" @close="dialog = undefined" @changed="(path, workspaceId, open) => guard(() => changed(path, workspaceId, open))" />
    </Teleport>
  </section>
</template>
<style scoped>
.file-tree{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}.file-tree-viewport{flex:1;min-height:0;overflow:auto;overflow-anchor:none}.file-tree-spacer{position:relative}.file-tree-visible{position:absolute;inset:0 0 auto}.file-tree-entry{height:var(--file-row-height)}.file-tree .panel-heading,.file-tree-actions,.file-tree-location{flex-shrink:0}
.file-tree-actions{display:flex;gap:4px;padding:7px 8px}.file-tree-actions button{font-size:11px;padding:5px;white-space:nowrap}.file-tree-location{font-size:11px;padding:3px 12px 8px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-tree-entry{display:flex;min-width:0}.file-tree-entry.selected{background:var(--hover)}.file-tree-entry .tree-row{min-width:0;flex:1}.file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-entry-more{padding:0 7px;min-width:28px;background:transparent;border:0;flex-shrink:0;opacity:0}.file-tree-entry:hover .file-entry-more,.file-tree-entry:focus-within .file-entry-more{opacity:1}.file-menu-backdrop{position:fixed;inset:0;z-index:10038}.file-entry-menu{position:fixed;z-index:10039;width:200px;padding:5px;background:var(--panel);border:1px solid var(--border);box-shadow:0 8px 28px #0006}.file-entry-menu button{display:block;text-align:left;width:100%;border:0;background:transparent;padding:10px}.file-entry-menu .danger{color:#ef9494}@media(hover:none){.file-entry-more{opacity:1}}@media(max-width:600px){.file-entry-more{opacity:1;min-width:36px}.file-tree-actions button{min-height:36px;font-size:12px;padding:6px 9px}.file-tree-entry .tree-row{min-height:38px}}
</style>
