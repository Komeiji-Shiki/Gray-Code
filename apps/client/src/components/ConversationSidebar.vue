<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ConversationNavigationItem, ConversationNavigationResult, ConversationViewInfo, NavigationOrdering } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { guard, state } from '../state';
import NavigationIcon from './navigation/NavigationIcon.vue';
import ConversationNavigationRow from './navigation/ConversationNavigationRow.vue';
import { useNavigationDrag } from './navigation/useNavigationDrag';
import { orderSidebarItems } from '../../../../shared/sidebarOrder';
const props = defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ 'update:collapsed': [value: boolean]; addWorkspace: []; automations: []; navigate: [panel?: 'workbench'] }>();
const isDesktop = window.graycode?.kind !== 'web';
const navigation = ref<ConversationNavigationResult>({ items: [], pinned: [], workspaces: [], runs: [] });
const query = ref('');
const navigationScope = ref<'personal' | 'bots'>('personal');
const searchInput = ref<HTMLInputElement>();
const initialLoading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const collapsedGroups = ref(new Set<string>());
interface NavigationProject { name: string; uri: string; workspace?: ConversationNavigationResult['workspaces'][number] }
type NavigationDialogKind = 'rename' | 'delete' | 'close' | 'project-rename' | 'project-remove';
const menu = ref<{ item?: ConversationNavigationItem; view?: ConversationViewInfo; project?: NavigationProject; x: number; y: number }>();
const dialog = ref<{ kind: NavigationDialogKind; item?: ConversationNavigationItem; view?: ConversationViewInfo; project?: NavigationProject }>();
const projectRemoval = ref<{ count: number; activeCount: number; token: string }>();
const deleteProjectConversations = ref(false);
const title = ref('');
const dialogBusy = ref(false);
const dialogInput = ref<HTMLInputElement>();
let epoch = 0; let refreshTimer: ReturnType<typeof setTimeout> | undefined; let unsubscribe: (() => void) | undefined;
const rpc = <T,>(type: string, data: Record<string, unknown> = {}) => call<T>('ui.request', { type, data });
const ordering = computed<NavigationOrdering>(() => navigation.value.ordering ?? { revision: 0, groups: [], conversations: [], pinned: [], drafts: [] });
const views = computed(() => new Map(state.conversationViews.filter(view => view.conversationId).map(view => [view.conversationId!, view])));
const drafts = computed(() => orderSidebarItems(state.conversationViews.filter(view => !view.conversationId && (view.active || view.hasDraft)), ordering.value.drafts, view => view.id));
const runs = computed(() => new Map(navigation.value.runs.map(run => [run.conversationId, run.status])));
const drag = useNavigationDrag(async (kind, ids) => {
  const scope = navigationScope.value;
  const result = await rpc<NavigationOrdering>('conversation.navigation.reorder', { scope, kind, ids, revision: ordering.value.revision });
  if (scope !== navigationScope.value) return;
  navigation.value = { ...navigation.value, ordering: result, nextCursor: undefined,
    items: orderSidebarItems(navigation.value.items, result.conversations, item => item.id),
    pinned: orderSidebarItems(navigation.value.pinned, result.pinned, item => item.id) };
  await refresh();
}, cause => { error.value = cause instanceof Error ? cause.message : String(cause); });
const groups = computed(() => {
  const items = navigation.value.items;
  if (navigationScope.value === 'bots') return orderSidebarItems((['discord', 'onebot'] as const).map(platform => ({ key: platform, name: platform === 'discord' ? 'Discord' : 'QQ / OneBot', uri: '', workspace: undefined,
    items: items.filter(item => item.botPlatform === platform) })), ordering.value.groups, group => group.key);
  const known = navigation.value.workspaces.map(workspace => ({ key: workspace.id, name: workspace.name, uri: workspace.uri, workspace, items: items.filter(item => item.workspaceId === workspace.id) }));
  const unmapped = new Map<string, ConversationNavigationItem[]>();
  for (const item of items.filter(item => !item.workspaceId || item.automaticWorkspace)) {
    const key = item.automaticWorkspace ? '' : item.workspaceIdentity ?? item.workspaceUri ?? '';
    const values = unmapped.get(key) ?? []; values.push(item); unmapped.set(key, values);
  }
  const other = [...unmapped].map(([key, values]) => {
    const uri = values[0].automaticWorkspace ? '' : values[0].workspaceUri ?? '';
    let name = '普通对话';
    if (uri) { try { name = decodeURIComponent(uri).replace(/\/$/, '').split(/[\\/]/).at(-1) || uri; } catch { name = uri; } }
    return { key: key || 'general', name: values[0].projectName || name, uri, workspace: undefined, items: values };
  });
  return orderSidebarItems([...known, ...other], ordering.value.groups, group => group.key);
});
async function refresh(reset = false, more = false) {
  if (more && (loadingMore.value || !navigation.value.nextCursor)) return;
  const current = ++epoch; const searching = query.value;
  if (more) loadingMore.value = true;
  try {
    const result = await rpc<ConversationNavigationResult>('conversation.navigation', { scope: navigationScope.value, query: searching, ...(more ? { cursor: navigation.value.nextCursor } : {}) });
    if (current !== epoch || searching !== query.value) return;
    const pinnedIds = new Set(result.pinned.map(item => item.id));
    const items = new Map((reset ? [] : navigation.value.items).filter(item => !pinnedIds.has(item.id)).map(item => [item.id, item]));
    for (const item of result.items) items.set(item.id, item);
    const cursor = reset || more || !navigation.value.nextCursor || navigation.value.ordering?.revision !== result.ordering?.revision ? result.nextCursor : navigation.value.nextCursor;
    navigation.value = { ...result, items: orderSidebarItems([...items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), result.ordering?.conversations ?? [], item => item.id), nextCursor: cursor };
    error.value = '';
  } catch (cause) { if (current === epoch) error.value = (cause as Error).message; }
  finally { if (current === epoch) { initialLoading.value = false; loadingMore.value = false; } }
}
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 160);
}
async function command(command: string, data?: Record<string, unknown>) {
  const result = await call('ui.command', { command, data });
  if (['newChat', 'platform.openModeConversation', 'platform.switchConversationView', 'showHistory', 'showUsage', 'showSettings'].includes(command)) emit('navigate');
  return result;
}
function open(item: ConversationNavigationItem) { menu.value = undefined; void guard(() => command('platform.openModeConversation', { conversationId: item.id })); }
async function selectProject(group: (typeof groups.value)[number]) {
  if (!group.uri) { toggleGroup(group.key); return; }
  const candidates = [...group.items, ...navigation.value.pinned.filter(item => group.workspace && item.workspaceId === group.workspace.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const selected = candidates.find(item => item.id === state.conversationId) ?? candidates[0];
  if (selected) await command('platform.openModeConversation', { conversationId: selected.id });
  if (group.workspace) state.workspaceId = group.workspace.id;
  const next = new Set(collapsedGroups.value); next.delete(group.key); collapsedGroups.value = next;
  state.chatFocused = false; emit('navigate', 'workbench');
}
async function newConversation(workspaceId?: string) {
  if (workspaceId) {
    const result = await rpc<{ conversationId: string }>('ui.mode.new', { mode: 'code', workspaceId });
    await command('platform.openModeConversation', { conversationId: result.conversationId });
  } else await command('newChat');
}
function showMenu(event: MouseEvent, item?: ConversationNavigationItem, view?: ConversationViewInfo) {
  menu.value = { item, view: view ?? (item && views.value.get(item.id)), ...menuPosition(event) };
}
async function openInExplorer() {
  const selected = menu.value; menu.value = undefined;
  if (selected?.project) await call('workspace.openInExplorer', { workspaceId: selected.project.workspace?.id, workspaceUri: selected.project.uri });
  else if (selected?.item) await call('workspace.openInExplorer', { conversationId: selected.item.id });
}
function menuPosition(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const pointer = event.type === 'contextmenu' && (event.clientX || event.clientY);
  return { x: Math.max(8, Math.min(pointer ? event.clientX : rect.right - 210, window.innerWidth - 220)),
    y: Math.max(8, Math.min(pointer ? event.clientY : rect.bottom + 3, window.innerHeight - 185)) };
}
function showProjectMenu(event: MouseEvent, project: NavigationProject) {
  if (!project.uri) return;
  event.preventDefault(); event.stopPropagation();
  menu.value = { project, ...menuPosition(event) };
}
const projectTarget = (project: NavigationProject) => ({ workspaceId: project.workspace?.id, workspaceUri: project.uri });
async function showDialog(kind: NavigationDialogKind) {
  if (!menu.value) return;
  error.value = '';
  dialog.value = { ...menu.value, kind }; title.value = menu.value.project?.name ?? menu.value.item?.title ?? menu.value.view?.title ?? ''; menu.value = undefined;
  deleteProjectConversations.value = false; projectRemoval.value = undefined;
  void nextTick(() => { dialogInput.value?.focus(); dialogInput.value?.select(); });
  if (kind === 'project-remove') {
    dialogBusy.value = true;
    try { projectRemoval.value = await rpc('projects.previewRemoval', projectTarget(dialog.value.project!)); }
    catch (cause) { error.value = (cause as Error).message; }
    finally { dialogBusy.value = false; }
  }
}
async function changePin() {
  const item = menu.value?.item; menu.value = undefined; if (!item) return;
  await rpc('conversation.pin', { conversationId: item.id, pinned: !item.pinnedAt });
  navigation.value.items = navigation.value.items.filter(value => value.id !== item.id);
  navigation.value.pinned = navigation.value.pinned.filter(value => value.id !== item.id);
  if (item.pinnedAt) navigation.value.items.push({ ...item, pinnedAt: undefined });
  await refresh();
}
async function closeView() {
  const view = menu.value?.view; if (!view) return;
  if (view.hasDraft) { showDialog('close'); return; }
  menu.value = undefined; await command('platform.closeConversationView', { tabId: view.id });
}
async function confirmDialog() {
  if (!dialog.value || dialogBusy.value) return;
  const selected = dialog.value; dialogBusy.value = true;
  try {
    if (selected.kind === 'project-rename') await rpc('projects.rename', { ...projectTarget(selected.project!), name: title.value });
    else if (selected.kind === 'project-remove') {
      if (!projectRemoval.value) return;
      const result = await rpc<{ deletedIds: string[] }>('projects.remove', { ...projectTarget(selected.project!), deleteConversations: deleteProjectConversations.value, token: projectRemoval.value.token });
      for (const view of state.conversationViews.filter(view => view.conversationId && result.deletedIds.includes(view.conversationId)))
        await command('platform.closeConversationView', { tabId: view.id });
    }
    else if (selected.kind === 'rename') await rpc('conversation.rename', { conversationId: selected.item!.id, title: title.value });
    else if (selected.kind === 'close') await command('platform.closeConversationView', { tabId: selected.view!.id });
    else {
      await rpc('conversation.deleteConversation', { conversationId: selected.item!.id });
      navigation.value.items = navigation.value.items.filter(item => item.id !== selected.item!.id);
      navigation.value.pinned = navigation.value.pinned.filter(item => item.id !== selected.item!.id);
      if (selected.view) await command('platform.closeConversationView', { tabId: selected.view.id });
    }
    dialog.value = undefined; await refresh(true);
  } catch (cause) { error.value = (cause as Error).message; }
  finally { dialogBusy.value = false; }
}
function toggleGroup(key: string) { const next = new Set(collapsedGroups.value); if (next.has(key)) next.delete(key); else next.add(key); collapsedGroups.value = next; }
async function focusSearch() { emit('update:collapsed', false); await nextTick(); searchInput.value?.focus(); }
function dismiss(event: KeyboardEvent) { if (event.key === 'Escape') { drag.clear(); menu.value = undefined; if (!dialogBusy.value) dialog.value = undefined; } }
watch([query, navigationScope], () => { ++epoch; drag.clear(); menu.value = undefined; initialLoading.value = true; navigation.value = { items: [], pinned: [], workspaces: [], runs: [] }; if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(true); }, 180); });
watch([dialog, menu], ([currentDialog, currentMenu]) => { state.navigationDialogOpen = !!(currentDialog || currentMenu); });
onMounted(() => {
  void refresh(true); window.addEventListener('keydown', dismiss);
  unsubscribe = subscribe(event => {
    if (event.type === 'conversation.navigation.changed' && !drag.state.saving) scheduleRefresh();
    if (event.type === 'project.navigation.changed') void refresh(true);
    if (event.type === 'transport.resumed' || event.type === 'migration.completed') scheduleRefresh();
    if (event.type === 'conversation.changed') {
      if (event.deleted) { navigation.value.items = navigation.value.items.filter(item => item.id !== event.conversationId); navigation.value.pinned = navigation.value.pinned.filter(item => item.id !== event.conversationId); }
      scheduleRefresh();
    }
    if (event.type === 'settings.changed' || event.type === 'event' && event.event?.type?.startsWith('run.')) scheduleRefresh();
  });
});
onUnmounted(() => { ++epoch; if (refreshTimer) clearTimeout(refreshTimer); unsubscribe?.(); window.removeEventListener('keydown', dismiss); state.navigationDialogOpen = false; });
</script>
<template>
  <aside class="conversation-sidebar" :class="{ collapsed }" aria-label="对话导航">
    <div class="navigation-top"><button v-if="navigationScope === 'bots'" title="返回项目与对话" @click="navigationScope = 'personal'"><NavigationIcon name="chevron" class="navigation-back" /><span v-if="!collapsed">返回项目与对话</span></button><button v-else class="new-conversation" title="新建对话" @click="guard(() => newConversation())"><NavigationIcon name="plus" /><span v-if="!collapsed">新对话</span></button><button v-if="collapsed" title="搜索对话" aria-label="搜索对话" @click="focusSearch"><NavigationIcon name="search" /></button></div>
    <div v-if="navigationScope === 'bots' && !collapsed" class="navigation-scope-title"><NavigationIcon name="bot" />机器人会话</div>
    <div v-if="!collapsed" class="navigation-search"><NavigationIcon name="search" /><input ref="searchInput" v-model="query" type="search" aria-label="搜索对话标题" placeholder="搜索对话标题" /></div>
    <div v-if="!collapsed" class="navigation-scroll">
      <p v-if="error && !dialog" class="navigation-error" role="alert">{{ error }}<button @click="refresh()">重试</button></p>
      <section v-if="navigationScope === 'personal' && drafts.length && !query" class="navigation-group"><h3>当前输入</h3>
        <div v-for="view in drafts" :key="view.id" class="navigation-draft" :class="{ active: view.active, ...drag.classes(drag.target('drafts', view.id)) }"
          :draggable="!drag.state.saving" @dragstart.stop="drag.start($event, drag.target('drafts', view.id))" @dragend="drag.clear"
          @dragover="drag.over($event, drag.target('drafts', view.id))" @drop="drag.drop($event, drag.target('drafts', view.id), drafts.map(value => value.id))">
          <button @click="guard(() => command('platform.switchConversationView', { tabId: view.id }))"><NavigationIcon name="chat" /><span>{{ view.hasDraft ? '未发送的草稿' : view.title }}</span></button>
          <button title="草稿操作" aria-label="草稿操作" @click="showMenu($event, undefined, view)"><NavigationIcon name="more" /></button>
        </div>
      </section>
      <section v-if="navigation.pinned.length" class="navigation-group"><h3><NavigationIcon name="pin" />置顶</h3>
        <ConversationNavigationRow v-for="item in navigation.pinned" :key="item.id" :item="item" :active="state.conversationId === item.id" :status="runs.get(item.id)" :has-draft="views.get(item.id)?.hasDraft"
          :draggable="!drag.state.saving" :class="drag.classes(drag.target('pinned', item.id))"
          @dragstart.stop="drag.start($event, drag.target('pinned', item.id))" @dragend="drag.clear"
          @dragover="drag.over($event, drag.target('pinned', item.id))" @drop="drag.drop($event, drag.target('pinned', item.id), navigation.pinned.map(value => value.id))"
          @select="open(item)" @menu="showMenu($event, item)" />
      </section>
      <p v-if="initialLoading" class="navigation-empty">正在读取对话…</p>
      <section v-for="group in groups" :key="group.key" class="navigation-group" :data-navigation-group="group.key">
        <div class="navigation-group-heading" :class="{ selected: group.workspace?.id === state.workspaceId, ...drag.classes(drag.target('groups', group.key)) }" @contextmenu="showProjectMenu($event, group)"
          :draggable="!drag.state.saving" @dragstart.stop="drag.start($event, drag.target('groups', group.key))" @dragend="drag.clear"
          @dragover="drag.over($event, drag.target('groups', group.key))" @drop="drag.drop($event, drag.target('groups', group.key), groups.map(value => value.key))">
          <button class="navigation-project-toggle" :aria-label="`${collapsedGroups.has(group.key) ? '展开' : '收起'}${group.name}`" :aria-expanded="!collapsedGroups.has(group.key)" @click="toggleGroup(group.key)"><NavigationIcon name="chevron" :class="{ expanded: !collapsedGroups.has(group.key) }" /></button>
          <button class="navigation-project-select" :title="group.workspace?.directory || group.uri" @click="guard(() => selectProject(group))"><NavigationIcon :name="group.uri ? 'folder' : 'chat'" /><span>{{ group.name }}</span></button>
          <button v-if="group.workspace" class="navigation-project-add" title="在这个项目中新建对话" aria-label="在这个项目中新建对话" @click="guard(() => newConversation(group.workspace!.id))"><NavigationIcon name="plus" /></button>
          <button v-if="group.uri" class="navigation-project-more" title="项目操作" aria-label="项目操作" aria-haspopup="menu" @click="showProjectMenu($event, group)"><NavigationIcon name="more" /></button>
        </div>
        <template v-if="!collapsedGroups.has(group.key)">
          <ConversationNavigationRow v-for="item in group.items" :key="item.id" :item="item" :active="state.conversationId === item.id" :status="runs.get(item.id)" :has-draft="views.get(item.id)?.hasDraft"
            :draggable="!drag.state.saving" :class="drag.classes(drag.target('conversations', item.id, group.key))"
            @dragstart.stop="drag.start($event, drag.target('conversations', item.id, group.key))" @dragend="drag.clear"
            @dragover="drag.over($event, drag.target('conversations', item.id, group.key))" @drop="drag.drop($event, drag.target('conversations', item.id, group.key), group.items.map(value => value.id))"
            @select="open(item)" @menu="showMenu($event, item)" />
          <p v-if="!group.items.length" class="navigation-group-empty">{{ query ? '没有匹配的对话' : '暂无最近对话' }}</p>
        </template>
      </section>
      <p v-if="!initialLoading && !navigation.items.length && !navigation.pinned.length && query" class="navigation-empty">没有找到匹配的对话。</p>
      <button v-if="navigation.nextCursor" class="navigation-load-more" :disabled="loadingMore" @click="refresh(false, true)">{{ loadingMore ? '正在读取…' : '显示更多对话' }}</button>
      <button v-if="navigationScope === 'personal'" class="navigation-add-project" @click="emit('addWorkspace')"><NavigationIcon name="folder" />添加项目</button>
    </div>
    <div class="navigation-bottom"><button title="自动任务" @click="emit('automations')"><NavigationIcon name="calendar" /><span v-if="!collapsed">自动任务</span></button><button title="机器人会话" :aria-pressed="navigationScope === 'bots'" @click="navigationScope = navigationScope === 'bots' ? 'personal' : 'bots'"><NavigationIcon name="bot" /><span v-if="!collapsed">机器人会话</span></button><button title="全部对话历史" @click="guard(() => command('showHistory'))"><NavigationIcon name="history" /><span v-if="!collapsed">全部历史</span></button><button title="用量统计" @click="guard(() => command('showUsage'))"><NavigationIcon name="chart" /><span v-if="!collapsed">用量统计</span></button><button title="设置" @click="guard(() => command('showSettings'))"><NavigationIcon name="settings" /><span v-if="!collapsed">设置</span></button></div>
  </aside>
  <Teleport v-if="menu || dialog" to=".application">
    <template v-if="menu">
      <div class="navigation-menu-dismiss" @pointerdown="menu = undefined" @contextmenu.prevent="menu = undefined"></div>
      <div class="navigation-menu" role="menu" :aria-label="menu.project ? '项目操作' : '对话操作'" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <button v-if="isDesktop && (menu.project || menu.item?.workspaceId || menu.item?.workspaceUri)" role="menuitem" @click="guard(openInExplorer)">在资源管理器中打开工作区</button>
        <template v-if="menu.project"><button role="menuitem" @click="showDialog('project-rename')">重命名项目</button><button role="menuitem" class="danger" @click="showDialog('project-remove')">移除项目</button></template>
        <button v-if="menu.item" role="menuitem" @click="showDialog('rename')">重命名</button><button v-if="menu.item" role="menuitem" @click="guard(changePin)">{{ menu.item.pinnedAt ? '取消置顶' : '置顶对话' }}</button><button v-if="menu.view" role="menuitem" @click="guard(closeView)">关闭视图，保留任务</button><button v-if="menu.item" role="menuitem" class="danger" @click="showDialog('delete')">删除对话</button>
      </div>
    </template>
    <div v-if="dialog" class="navigation-dialog-backdrop">
      <form class="navigation-dialog" role="dialog" aria-modal="true" aria-labelledby="navigation-dialog-title" @submit.prevent="confirmDialog">
        <h2 id="navigation-dialog-title">{{ dialog.kind === 'project-rename' ? '重命名项目' : dialog.kind === 'project-remove' ? '移除项目' : dialog.kind === 'rename' ? '重命名对话' : dialog.kind === 'close' ? '关闭输入草稿' : '删除对话' }}</h2>
        <template v-if="dialog.kind === 'rename' || dialog.kind === 'project-rename'"><input ref="dialogInput" v-model="title" maxlength="300" required :aria-label="dialog.kind === 'project-rename' ? '项目名称' : '对话标题'" /><p v-if="dialog.kind === 'project-rename'" class="navigation-hint">修改项目列表中的显示名称，磁盘文件夹名称保持原样。</p></template>
        <template v-else-if="dialog.kind === 'project-remove'">
          <p>将「{{ dialog.project?.name }}」从左侧项目列表移除，磁盘上的文件会保留。重新添加同一目录可以恢复项目显示。</p>
          <label class="navigation-delete-history"><input v-model="deleteProjectConversations" type="checkbox" :disabled="!projectRemoval?.count || dialogBusy" /><span>同时删除关联的 {{ projectRemoval?.count ?? '…' }} 个对话</span></label>
          <p v-if="deleteProjectConversations" class="danger">这些对话及其分支将被删除，相关视图会关闭，未发送的草稿也会丢弃。{{ projectRemoval?.activeCount ? `其中 ${projectRemoval.activeCount} 个正在运行的任务会停止。` : '' }}删除后无法恢复。</p>
          <p v-else class="navigation-hint">已有对话可继续从“全部历史”打开，当前任务和草稿会保留。机器人会话单独管理。</p>
        </template>
        <p v-else>{{ dialog.kind === 'close' ? '关闭后会丢弃这个视图中尚未发送的文字和附件，已有历史与后台任务会保留。' : `将删除「${dialog.item?.title || '未命名对话'}」及其分支记录，正在执行的任务也会停止。此操作无法撤销。` }}</p>
        <p v-if="error" role="alert" class="navigation-error">{{ error }}</p>
        <div class="navigation-dialog-actions"><button type="button" :disabled="dialogBusy" @click="dialog = undefined">取消</button><button :class="dialog.kind === 'rename' || dialog.kind === 'project-rename' ? 'primary' : 'danger'" :disabled="dialogBusy || dialog.kind === 'project-remove' && !projectRemoval">{{ dialogBusy ? '正在处理…' : dialog.kind === 'rename' || dialog.kind === 'project-rename' ? '保存名称' : dialog.kind === 'project-remove' ? '移除项目' : '确认' }}</button></div>
      </form>
    </div>
  </Teleport>
</template>
<style scoped src="./navigation/conversationSidebar.css"></style>
