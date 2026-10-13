<script setup lang="ts">
import { shellText as t } from '../i18n';
import { collapsedConversationGroups as collapsedGroups, useConversationNavigation } from '../conversationNavigation';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ConversationNavigationItem, ConversationNavigationResult, ConversationViewInfo, NavigationOrdering } from '@graycode/contracts';
import { call, subscribe, uiRequest } from '../api';
import { guard, state } from '../state';
import NavigationIcon from './navigation/NavigationIcon.vue';
import ConversationNavigationRow from './navigation/ConversationNavigationRow.vue';
import { useNavigationDrag } from './navigation/useNavigationDrag';
import { useNavigationFocus } from './navigation/useNavigationFocus';
import { orderSidebarItems } from '../../../../shared/sidebarOrder';
defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{
  'update:collapsed': [value: boolean];
  addWorkspace: [];
  automations: [];
  navigate: [panel?: 'workbench'];
  jumpToMessage: [target: { conversationId: string; messageIndex: number; messageId?: string }];
}>();
const { navigate, command, newConversation, selectWorkspace } = useConversationNavigation((panel) => {
  if (panel) emit('navigate', panel);
  else emit('navigate');
});
const isDesktop = window.graycode?.kind !== 'web';
const navigation = ref<ConversationNavigationResult>({ items: [], pinned: [], workspaces: [], runs: [] });
const query = ref('');
const navigationScope = ref<'personal' | 'bots'>('personal');
const searchInput = ref<HTMLInputElement>();
const sidebarElement = ref<HTMLElement>();
let settingsTrigger: HTMLButtonElement | undefined;
const initialLoading = ref(true);
const loadingMore = ref(false);
const error = ref('');
interface NavigationProject {
  key: string;
  name: string;
  uri: string;
  workspace?: ConversationNavigationResult['workspaces'][number];
}
interface NavigationGroup extends NavigationProject {
  items: ConversationNavigationItem[];
}
type NavigationDialogKind = 'rename' | 'delete' | 'close' | 'project-rename' | 'project-remove';
const menu = ref<{ item?: ConversationNavigationItem; view?: ConversationViewInfo; project?: NavigationProject; x: number; y: number }>();
const createMenu = ref<{ x: number; y: number }>();
const createMenuElement = ref<HTMLDivElement>();
const menuElement = ref<HTMLDivElement>();
const dialogElement = ref<HTMLFormElement>();
const dialog = ref<{ kind: NavigationDialogKind; item?: ConversationNavigationItem; view?: ConversationViewInfo; project?: NavigationProject }>();
const projectRemoval = ref<{ count: number; activeCount: number; token: string }>();
const deleteProjectConversations = ref(false);
const title = ref('');
const dialogBusy = ref(false);
const overlayRoot = computed(() => dialogElement.value ?? menuElement.value ?? createMenuElement.value);
const { rememberTrigger } = useNavigationFocus(
  overlayRoot,
  dismissOverlay,
  () => searchInput.value ?? sidebarElement.value?.querySelector<HTMLButtonElement>('button') ?? undefined,
);
let disposed = false;
let epoch = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;
const ordering = computed<NavigationOrdering>(
  () => navigation.value.ordering ?? { revision: 0, groups: [], pinnedGroups: [], conversations: [], pinned: [], drafts: [] },
);
const views = computed(() => new Map(state.conversationViews.filter((view) => view.conversationId).map((view) => [view.conversationId!, view])));
const drafts = computed(() =>
  orderSidebarItems(
    state.conversationViews.filter((view) => !view.conversationId && (view.active || view.hasDraft)),
    ordering.value.drafts,
    (view) => view.id,
  ),
);
const runs = computed(() => new Map(navigation.value.runs.map((run) => [run.conversationId, run.status])));
const drag = useNavigationDrag(
  async (kind, ids) => {
    const scope = navigationScope.value;
    const result = await uiRequest('conversation.navigation.reorder', { scope, kind, ids, revision: ordering.value.revision });
    if (scope !== navigationScope.value) return;
    navigation.value = {
      ...navigation.value,
      ordering: result,
      nextCursor: undefined,
      items: orderSidebarItems(navigation.value.items, result.conversations, (item) => item.id),
      pinned: orderSidebarItems(navigation.value.pinned, result.pinned, (item) => item.id),
    };
    await refresh();
  },
  (cause) => {
    error.value = cause instanceof Error ? cause.message : String(cause);
  },
);
const groupPinned = (key: string) => ordering.value.pinnedGroups.includes(key);
const groupDrag = (key: string) => drag.target('groups', key, groupPinned(key) ? 'pinned-groups' : 'groups');
const groupDragIds = (key: string) => groups.value.filter((group) => groupPinned(group.key) === groupPinned(key)).map((group) => group.key);
const groups = computed<NavigationGroup[]>(() => {
  const items = navigation.value.items;
  if (navigationScope.value === 'bots')
    return orderSidebarItems(
      (['discord', 'onebot'] as const).map((platform) => ({
        key: platform,
        name: platform === 'discord' ? 'Discord' : 'QQ / OneBot',
        uri: '',
        workspace: undefined,
        items: items.filter((item) => item.botPlatform === platform),
      })),
      ordering.value.groups,
      (group) => group.key,
    );
  const workspaceIds = new Set(navigation.value.workspaces.map((workspace) => workspace.id));
  const byWorkspace = new Map<string, ConversationNavigationItem[]>();
  const unmapped = new Map<string, ConversationNavigationItem[]>();
  // 单遍分组；自动工作区仍属于普通对话，旧项目移除后也不能把历史藏起来。
  for (const item of items) {
    const mapped = !!item.workspaceId && workspaceIds.has(item.workspaceId) && !item.automaticWorkspace;
    const target = mapped ? byWorkspace : unmapped;
    const key = mapped ? item.workspaceId! : item.automaticWorkspace ? '' : (item.workspaceIdentity ?? item.workspaceUri ?? '');
    const values = target.get(key) ?? [];
    values.push(item);
    target.set(key, values);
  }
  const known = navigation.value.workspaces.map((workspace) => ({
    key: workspace.id,
    name: workspace.name,
    uri: workspace.uri,
    workspace,
    items: byWorkspace.get(workspace.id) ?? [],
  }));
  const other = [...unmapped].map(([key, values]) => {
    const uri = values[0].automaticWorkspace ? '' : (values[0].workspaceUri ?? '');
    let name = t('uiConversationSidebarRegularConversation');
    if (uri) {
      try {
        name = decodeURIComponent(uri).replace(/\/$/, '').split(/[\\/]/).at(-1) || uri;
      } catch {
        name = uri;
      }
    }
    return { key: key || 'general', name: values[0].projectName || name, uri, workspace: undefined, items: values };
  });
  // 普通对话是固定分类，即使暂时没有已加载的消息，也保留创建入口。
  if (!other.some((group) => group.key === 'general'))
    other.push({ key: 'general', name: t('uiConversationSidebarRegularConversation'), uri: '', workspace: undefined, items: [] });
  const ordered = orderSidebarItems([...known, ...other], ordering.value.groups, (group) => group.key);
  return [...ordered.filter((group) => groupPinned(group.key)), ...ordered.filter((group) => !groupPinned(group.key))];
});
async function refresh(reset = false, more = false) {
  if (disposed) return;
  if (more && (loadingMore.value || !navigation.value.nextCursor)) return;
  const current = ++epoch;
  const searching = query.value;
  if (more) loadingMore.value = true;
  try {
    const result = await uiRequest('conversation.navigation', {
      scope: navigationScope.value,
      query: searching,
      ...(more ? { cursor: navigation.value.nextCursor } : {}),
    });
    if (current !== epoch || searching !== query.value) return;
    const pinnedIds = new Set(result.pinned.map((item) => item.id));
    const items = new Map((reset ? [] : navigation.value.items).filter((item) => !pinnedIds.has(item.id)).map((item) => [item.id, item]));
    for (const item of result.items) items.set(item.id, item);
    const cursor =
      reset || more || !navigation.value.nextCursor || navigation.value.ordering?.revision !== result.ordering?.revision
        ? result.nextCursor
        : navigation.value.nextCursor;
    navigation.value = {
      ...result,
      items: orderSidebarItems(
        [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
        result.ordering?.conversations ?? [],
        (item) => item.id,
      ),
      nextCursor: cursor,
    };
    error.value = '';
    if (result.searchIndexing && searching) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh(true);
      }, 120);
    }
  } catch (cause) {
    if (current === epoch) error.value = (cause as Error).message;
  } finally {
    if (current === epoch) {
      initialLoading.value = false;
      loadingMore.value = false;
    }
  }
}
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 160);
}
function open(item: ConversationNavigationItem) {
  const intent = navigate({ workspaceId: item.workspaceId, tabId: item.id });
  menu.value = undefined;
  void guard(async () => {
    await command('platform.openModeConversation', { conversationId: item.id }, intent);
    if (intent.current() && item.searchHit)
      emit('jumpToMessage', {
        conversationId: item.id,
        messageIndex: item.searchHit.messageIndex,
        ...(item.searchHit.messageId ? { messageId: item.searchHit.messageId } : {}),
      });
  });
}
async function selectProject(group: (typeof groups.value)[number]) {
  if (!group.uri) {
    toggleGroup(group.key);
    return;
  }
  await selectWorkspace(group.workspace?.id ?? '', group, navigation.value.pinned);
}
function openSettings(event: MouseEvent) {
  settingsTrigger = event.currentTarget as HTMLButtonElement;
  void guard(() => command('showSettings'));
}
function showMenu(event: MouseEvent, item?: ConversationNavigationItem, view?: ConversationViewInfo) {
  rememberTrigger(event);
  createMenu.value = undefined;
  menu.value = { item, view: view ?? (item && views.value.get(item.id)), ...menuPosition(event) };
}
function showCreateMenu(event: MouseEvent) {
  rememberTrigger(event);
  event.stopPropagation();
  menu.value = undefined;
  createMenu.value = { ...menuPosition(event) };
}
async function createGeneralConversation(automaticWorkspace: boolean) {
  const intent = navigate();
  createMenu.value = undefined;
  const result = await uiRequest('ui.mode.new', { mode: 'chat', automaticWorkspace });
  if (intent.current()) await command('platform.openModeConversation', { conversationId: result.conversationId }, intent);
}
async function openInExplorer() {
  const selected = menu.value;
  menu.value = undefined;
  if (selected?.project) await call('workspace.openInExplorer', { workspaceId: selected.project.workspace?.id, workspaceUri: selected.project.uri });
  else if (selected?.item) await call('workspace.openInExplorer', { conversationId: selected.item.id });
}
function menuPosition(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const pointer = event.type === 'contextmenu' && (event.clientX || event.clientY);
  return {
    x: Math.max(8, Math.min(pointer ? event.clientX : rect.right - 210, window.innerWidth - 220)),
    y: Math.max(8, Math.min(pointer ? event.clientY : rect.bottom + 3, window.innerHeight - 185)),
  };
}
function showProjectMenu(event: MouseEvent, project: NavigationProject) {
  if (!project.uri && project.key !== 'general') return;
  event.preventDefault();
  event.stopPropagation();
  rememberTrigger(event);
  createMenu.value = undefined;
  menu.value = { project, ...menuPosition(event) };
}
async function changeGroupPin() {
  const project = menu.value?.project;
  menu.value = undefined;
  if (!project || (project.key !== 'general' && !project.workspace)) return;
  const result = await uiRequest('conversation.navigation.pinGroup', {
    key: project.key,
    pinned: !groupPinned(project.key),
    revision: ordering.value.revision,
  });
  navigation.value = { ...navigation.value, ordering: result, nextCursor: undefined };
  await refresh();
}
const projectTarget = (project: NavigationProject) => ({ workspaceId: project.workspace?.id, workspaceUri: project.uri });
async function showDialog(kind: NavigationDialogKind) {
  if (!menu.value) return;
  error.value = '';
  dialog.value = { ...menu.value, kind };
  title.value = menu.value.project?.name ?? menu.value.item?.title ?? menu.value.view?.title ?? '';
  menu.value = undefined;
  deleteProjectConversations.value = false;
  projectRemoval.value = undefined;
  dialogBusy.value = false;
  const selected = dialog.value;
  if (kind === 'project-remove') {
    dialogBusy.value = true;
    try {
      const preview = await uiRequest('projects.previewRemoval', projectTarget(selected.project!));
      if (!disposed && dialog.value === selected) projectRemoval.value = preview;
    } catch (cause) {
      if (!disposed && dialog.value === selected) error.value = (cause as Error).message;
    } finally {
      if (!disposed && dialog.value === selected) dialogBusy.value = false;
    }
  }
}
async function changePin() {
  const item = menu.value?.item;
  menu.value = undefined;
  if (!item) return;
  await uiRequest('conversation.pin', { conversationId: item.id, pinned: !item.pinnedAt });
  navigation.value.items = navigation.value.items.filter((value) => value.id !== item.id);
  navigation.value.pinned = navigation.value.pinned.filter((value) => value.id !== item.id);
  if (item.pinnedAt) navigation.value.items.push({ ...item, pinnedAt: undefined });
  await refresh();
}
async function closeView() {
  const view = menu.value?.view;
  if (!view) return;
  if (view.hasDraft) {
    showDialog('close');
    return;
  }
  menu.value = undefined;
  await command('platform.closeConversationView', { tabId: view.id });
}
async function confirmDialog() {
  if (!dialog.value || dialogBusy.value) return;
  const selected = dialog.value;
  dialogBusy.value = true;
  try {
    if (selected.kind === 'project-rename') await uiRequest('projects.rename', { ...projectTarget(selected.project!), name: title.value });
    else if (selected.kind === 'project-remove') {
      if (!projectRemoval.value) return;
      const result = await uiRequest('projects.remove', {
        ...projectTarget(selected.project!),
        deleteConversations: deleteProjectConversations.value,
        token: projectRemoval.value.token,
      });
      for (const view of state.conversationViews.filter((view) => view.conversationId && result.deletedIds.includes(view.conversationId)))
        await command('platform.closeConversationView', { tabId: view.id });
    } else if (selected.kind === 'rename') await uiRequest('conversation.rename', { conversationId: selected.item!.id, title: title.value });
    else if (selected.kind === 'close') await command('platform.closeConversationView', { tabId: selected.view!.id });
    else {
      await uiRequest('conversation.deleteConversation', { conversationId: selected.item!.id });
      navigation.value.items = navigation.value.items.filter((item) => item.id !== selected.item!.id);
      navigation.value.pinned = navigation.value.pinned.filter((item) => item.id !== selected.item!.id);
      if (selected.view) await command('platform.closeConversationView', { tabId: selected.view.id });
    }
    if (!disposed && dialog.value === selected) {
      dialogBusy.value = false;
      dialog.value = undefined;
      await refresh(true);
    }
  } catch (cause) {
    if (!disposed && dialog.value === selected) error.value = (cause as Error).message;
  } finally {
    if (!disposed && dialog.value === selected) dialogBusy.value = false;
  }
}
function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroups.value = next;
}
async function focusSearch() {
  emit('update:collapsed', false);
  await nextTick();
  searchInput.value?.focus();
}
function dismissOverlay() {
  menu.value = undefined;
  createMenu.value = undefined;
  if (!dialogBusy.value) dialog.value = undefined;
}
function dismiss(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.defaultPrevented) drag.clear();
}
watch([query, navigationScope], () => {
  ++epoch;
  drag.clear();
  menu.value = undefined;
  createMenu.value = undefined;
  initialLoading.value = true;
  navigation.value = { items: [], pinned: [], workspaces: [], runs: [] };
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh(true);
  }, 180);
});
watch([dialog, menu, createMenu], ([currentDialog, currentMenu, currentCreateMenu]) => {
  state.navigationDialogOpen = !!(currentDialog || currentMenu || currentCreateMenu);
});
// 设置页位于聊天 iframe，外层负责把返回焦点交还给唯一的设置入口。
watch(
  () => state.settingsOpen,
  (open, previous) => {
    if (!open && previous)
      void nextTick(() => {
        if (!disposed && settingsTrigger?.isConnected) settingsTrigger.focus();
      });
  },
);
onMounted(() => {
  void refresh(true);
  window.addEventListener('keydown', dismiss);
  unsubscribe = subscribe((event) => {
    if (event.type === 'conversation.navigation.changed' && !drag.state.saving) scheduleRefresh();
    if (event.type === 'project.navigation.changed') void refresh(true);
    if (event.type === 'transport.resumed' || event.type === 'migration.completed') scheduleRefresh();
    if (event.type === 'conversation.changed') {
      if (event.deleted) {
        navigation.value.items = navigation.value.items.filter((item) => item.id !== event.conversationId);
        navigation.value.pinned = navigation.value.pinned.filter((item) => item.id !== event.conversationId);
      }
      scheduleRefresh();
    }
    if (event.type === 'settings.changed' || (event.type === 'event' && event.event?.type?.startsWith('run.'))) scheduleRefresh();
  });
});
onUnmounted(() => {
  disposed = true;
  ++epoch;
  if (refreshTimer) clearTimeout(refreshTimer);
  unsubscribe?.();
  window.removeEventListener('keydown', dismiss);
  state.navigationDialogOpen = false;
});
</script>
<template>
  <aside ref="sidebarElement" class="conversation-sidebar" :class="{ collapsed }" :aria-label="t('uiConversationSidebarConversationNavigation')">
    <div class="navigation-top">
      <button v-if="navigationScope === 'bots'" :title="t('uiConversationSidebarBackToProjectsAndConversations')" @click="navigationScope = 'personal'">
        <NavigationIcon name="chevron" class="navigation-back" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarBackToProjectsAndConversations') }}</span>
      </button>
      <button v-else class="new-conversation" :title="t('uiConversationSidebarNewConversation') + ' (Ctrl+N)'" @click="guard(() => newConversation())">
        <NavigationIcon name="plus" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarNewChat') }}</span>
      </button>
      <button
        v-if="collapsed"
        :title="t('uiConversationSidebarSearchConversations')"
        :aria-label="t('uiConversationSidebarSearchConversations')"
        @click="focusSearch"
      >
        <NavigationIcon name="search" />
      </button>
    </div>
    <div v-if="navigationScope === 'bots' && !collapsed" class="navigation-scope-title">
      <NavigationIcon name="bot" />
      {{ t('uiConversationSidebarBotConversations') }}
    </div>
    <div v-if="!collapsed" class="navigation-search">
      <NavigationIcon name="search" />
      <input
        ref="searchInput"
        v-model="query"
        type="search"
        :aria-label="t('uiConversationSidebarSearchConversationPlaceholder')"
        :placeholder="t('uiConversationSidebarSearchConversationPlaceholder')"
      />
    </div>
    <div v-if="!collapsed" class="navigation-scroll">
      <p v-if="error && !dialog" class="navigation-error" role="alert">
        {{ error }}
        <button @click="refresh()">{{ t('retry') }}</button>
      </p>
      <section v-if="navigationScope === 'personal' && drafts.length && !query" class="navigation-group">
        <h3>{{ t('uiConversationSidebarCurrentInput') }}</h3>
        <div
          v-for="view in drafts"
          :key="view.id"
          class="navigation-draft"
          :class="{ active: view.active, ...drag.classes(drag.target('drafts', view.id)) }"
          :draggable="!drag.state.saving"
          @dragstart.stop="drag.start($event, drag.target('drafts', view.id))"
          @dragend="drag.clear"
          @dragover="drag.over($event, drag.target('drafts', view.id))"
          @drop="
            drag.drop(
              $event,
              drag.target('drafts', view.id),
              drafts.map((value) => value.id),
            )
          "
        >
          <button @click="guard(() => command('platform.switchConversationView', { tabId: view.id }))">
            <NavigationIcon name="chat" />
            <span>{{ view.hasDraft ? t('uiConversationSidebarUnsentDraft') : view.title }}</span>
          </button>
          <button
            :title="t('uiConversationSidebarDraftActions')"
            :aria-label="t('uiConversationSidebarDraftActions')"
            @click="showMenu($event, undefined, view)"
          >
            <NavigationIcon name="more" />
          </button>
        </div>
      </section>
      <section v-if="navigation.pinned.length" class="navigation-group">
        <h3>
          <NavigationIcon name="pin" />
          {{ t('uiConversationSidebarPin') }}
        </h3>
        <ConversationNavigationRow
          v-for="item in navigation.pinned"
          :key="item.id"
          :item="item"
          :active="state.conversationId === item.id"
          :status="runs.get(item.id)"
          :has-draft="views.get(item.id)?.hasDraft"
          :draggable="!drag.state.saving"
          :class="drag.classes(drag.target('pinned', item.id))"
          @dragstart.stop="drag.start($event, drag.target('pinned', item.id))"
          @dragend="drag.clear"
          @dragover="drag.over($event, drag.target('pinned', item.id))"
          @drop="
            drag.drop(
              $event,
              drag.target('pinned', item.id),
              navigation.pinned.map((value) => value.id),
            )
          "
          @select="open(item)"
          @menu="showMenu($event, item)"
        />
      </section>
      <p v-if="initialLoading" class="navigation-empty">{{ t('uiConversationSidebarLoadingConversations') }}</p>
      <section v-for="group in groups" :key="group.key" class="navigation-group" :data-navigation-group="group.key">
        <div
          class="navigation-group-heading"
          :class="{ selected: group.workspace?.id === state.workspaceId, ...drag.classes(groupDrag(group.key)) }"
          @contextmenu="showProjectMenu($event, group)"
          :draggable="!drag.state.saving"
          @dragstart.stop="drag.start($event, groupDrag(group.key))"
          @dragend="drag.clear"
          @dragover="drag.over($event, groupDrag(group.key))"
          @drop="drag.drop($event, groupDrag(group.key), groupDragIds(group.key))"
        >
          <button
            class="navigation-project-toggle"
            :aria-label="`${collapsedGroups.has(group.key) ? t('uiComputerPaneExpand') : t('uiComputerPaneCollapse')}${group.name}`"
            :aria-expanded="!collapsedGroups.has(group.key)"
            @click="toggleGroup(group.key)"
          >
            <NavigationIcon name="chevron" :class="{ expanded: !collapsedGroups.has(group.key) }" />
          </button>
          <button class="navigation-project-select" :title="group.workspace?.directory || group.uri" @click="guard(() => selectProject(group))">
            <NavigationIcon :name="group.uri ? 'folder' : 'chat'" />
            <span>{{ group.name }}</span>
            <NavigationIcon v-if="groupPinned(group.key)" name="pin" class="navigation-group-pin" />
          </button>
          <button
            v-if="group.workspace"
            class="navigation-project-add"
            :title="t('uiConversationSidebarCreateProjectConversation')"
            :aria-label="t('uiConversationSidebarCreateProjectConversation')"
            @click="guard(() => newConversation(group.workspace!.id))"
          >
            <NavigationIcon name="plus" />
          </button>
          <button
            v-else-if="group.key === 'general'"
            class="navigation-project-add"
            :title="t('uiConversationSidebarCreateRegularChat')"
            :aria-label="t('uiConversationSidebarCreateRegularChat')"
            aria-haspopup="menu"
            :aria-expanded="!!createMenu"
            @click="showCreateMenu($event)"
          >
            <NavigationIcon name="plus" />
          </button>
          <button
            v-if="group.uri || group.key === 'general'"
            class="navigation-project-more"
            :title="group.key === 'general' ? t('uiConversationSidebarRegularConversationActions') : t('uiConversationSidebarProjectActions')"
            :aria-label="group.key === 'general' ? t('uiConversationSidebarRegularConversationActions') : t('uiConversationSidebarProjectActions')"
            aria-haspopup="menu"
            @click="showProjectMenu($event, group)"
          >
            <NavigationIcon name="more" />
          </button>
        </div>
        <template v-if="!collapsedGroups.has(group.key)">
          <ConversationNavigationRow
            v-for="item in group.items"
            :key="item.id"
            :item="item"
            :active="state.conversationId === item.id"
            :status="runs.get(item.id)"
            :has-draft="views.get(item.id)?.hasDraft"
            :draggable="!drag.state.saving"
            :class="drag.classes(drag.target('conversations', item.id, group.key))"
            @dragstart.stop="drag.start($event, drag.target('conversations', item.id, group.key))"
            @dragend="drag.clear"
            @dragover="drag.over($event, drag.target('conversations', item.id, group.key))"
            @drop="
              drag.drop(
                $event,
                drag.target('conversations', item.id, group.key),
                group.items.map((value) => value.id),
              )
            "
            @select="open(item)"
            @menu="showMenu($event, item)"
          />
          <p v-if="!group.items.length" class="navigation-group-empty">
            {{
              query
                ? navigation.searchIndexing
                  ? t('uiConversationSidebarSearchingConversationContent')
                  : t('uiConversationSidebarNoMatchingConversations')
                : t('uiConversationSidebarNoRecentConversations')
            }}
          </p>
        </template>
      </section>
      <p v-if="navigation.searchIndexing" class="navigation-empty" role="status">{{ t('uiConversationSidebarIndexingConversationContent') }}</p>
      <p v-if="!initialLoading && !navigation.searchIndexing && !navigation.items.length && !navigation.pinned.length && query" class="navigation-empty">
        {{ t('uiConversationSidebarNoSearchMatches') }}
      </p>
      <button v-if="navigation.nextCursor && !navigation.searchIndexing" class="navigation-load-more" :disabled="loadingMore" @click="refresh(false, true)">
        {{ loadingMore ? t('uiComputerPaneLoading') : t('uiConversationSidebarShowMoreConversations') }}
      </button>
      <button v-if="navigationScope === 'personal'" class="navigation-add-project" @click="emit('addWorkspace')">
        <NavigationIcon name="folder" />
        {{ t('uiConversationSidebarAddProject') }}
      </button>
    </div>
    <div class="navigation-bottom">
      <button :title="t('uiConversationSidebarAutomations')" @click="emit('automations')">
        <NavigationIcon name="calendar" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarAutomations') }}</span>
      </button>
      <button
        :title="t('uiConversationSidebarBotConversations')"
        :aria-pressed="navigationScope === 'bots'"
        @click="navigationScope = navigationScope === 'bots' ? 'personal' : 'bots'"
      >
        <NavigationIcon name="bot" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarBotConversations') }}</span>
      </button>
      <button :title="t('uiConversationSidebarAllConversationHistory')" @click="guard(() => command('showHistory'))">
        <NavigationIcon name="history" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarAllHistory') }}</span>
      </button>
      <button :title="t('uiConversationSidebarUsageStatistics')" @click="guard(() => command('showUsage'))">
        <NavigationIcon name="chart" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarUsageStatistics') }}</span>
      </button>
      <button :title="t('uiConversationSidebarSettings')" @click="openSettings">
        <NavigationIcon name="settings" />
        <span v-if="!collapsed">{{ t('uiConversationSidebarSettings') }}</span>
      </button>
    </div>
  </aside>
  <Teleport v-if="menu || dialog || createMenu" to=".application">
    <template v-if="menu || createMenu">
      <div
        class="navigation-menu-dismiss"
        @pointerdown="
          menu = undefined;
          createMenu = undefined;
        "
        @contextmenu.prevent="
          menu = undefined;
          createMenu = undefined;
        "
      ></div>
      <div
        v-if="menu"
        ref="menuElement"
        class="navigation-menu"
        role="menu"
        tabindex="-1"
        :aria-label="
          menu.project?.key === 'general'
            ? t('uiConversationSidebarRegularConversationActions')
            : menu.project
              ? t('uiConversationSidebarProjectActions')
              : t('uiConversationSidebarConversationActions')
        "
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      >
        <button v-if="isDesktop && (menu.project?.uri || menu.item?.workspaceId || menu.item?.workspaceUri)" role="menuitem" @click="guard(openInExplorer)">
          {{ t('uiConversationSidebarOpenWorkspaceInExplorer') }}
        </button>
        <button v-if="menu.project && (menu.project.key === 'general' || menu.project.workspace)" role="menuitem" @click="guard(changeGroupPin)">
          {{ groupPinned(menu.project.key) ? t('uiConversationSidebarUnpinGroup') : t('uiConversationSidebarPinGroup') }}
        </button>
        <template v-if="menu.project?.uri">
          <button role="menuitem" @click="showDialog('project-rename')">{{ t('uiConversationSidebarRenameProject') }}</button>
          <button role="menuitem" class="danger" @click="showDialog('project-remove')">{{ t('uiConversationSidebarRemoveProject') }}</button>
        </template>
        <button v-if="menu.item" role="menuitem" @click="showDialog('rename')">{{ t('uiBrowserPaneRename') }}</button>
        <button v-if="menu.item" role="menuitem" @click="guard(changePin)">
          {{ menu.item.pinnedAt ? t('uiConversationSidebarUnpin') : t('uiConversationSidebarPinConversation') }}
        </button>
        <button v-if="menu.view" role="menuitem" @click="guard(closeView)">{{ t('uiConversationSidebarCloseViewKeepTask') }}</button>
        <button v-if="menu.item" role="menuitem" class="danger" @click="showDialog('delete')">{{ t('uiConversationSidebarDeleteConversation') }}</button>
      </div>
      <div
        v-else-if="createMenu"
        ref="createMenuElement"
        class="navigation-menu navigation-creation-menu"
        role="menu"
        tabindex="-1"
        :aria-label="t('uiConversationSidebarNewRegularConversation')"
        :style="{ left: createMenu.x + 'px', top: createMenu.y + 'px' }"
      >
        <button role="menuitem" @click="guard(() => createGeneralConversation(true))">
          <strong>{{ t('uiConversationSidebarChatWithAutoWorkspace') }}</strong>
          <small>{{ t('uiConversationSidebarAutoWorkspaceDirectoryHelp') }}</small>
        </button>
        <button role="menuitem" @click="guard(() => createGeneralConversation(false))">
          <strong>{{ t('uiConversationSidebarChatWithoutWorkspace') }}</strong>
          <small>{{ t('uiConversationSidebarWorkspaceFreeChatHelp') }}</small>
        </button>
      </div>
    </template>
    <div v-if="dialog" class="navigation-dialog-backdrop">
      <form
        ref="dialogElement"
        class="navigation-dialog"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        aria-labelledby="navigation-dialog-title"
        @submit.prevent="confirmDialog"
      >
        <h2 id="navigation-dialog-title">
          {{
            dialog.kind === 'project-rename'
              ? t('uiConversationSidebarRenameProject')
              : dialog.kind === 'project-remove'
                ? t('uiConversationSidebarRemoveProject')
                : dialog.kind === 'rename'
                  ? t('uiConversationSidebarRenameConversation')
                  : dialog.kind === 'close'
                    ? t('uiConversationSidebarCloseInputDraft')
                    : t('uiConversationSidebarDeleteConversation')
          }}
        </h2>
        <template v-if="dialog.kind === 'rename' || dialog.kind === 'project-rename'">
          <input
            v-model="title"
            maxlength="300"
            required
            :disabled="dialogBusy"
            :aria-label="dialog.kind === 'project-rename' ? t('uiConversationSidebarProjectName') : t('uiConversationSidebarConversationTitle')"
          />
          <p v-if="dialog.kind === 'project-rename'" class="navigation-hint">{{ t('uiConversationSidebarRenameProjectHelp') }}</p>
        </template>
        <template v-else-if="dialog.kind === 'project-remove'">
          <p>{{ t('uiConversationSidebarRemoveProjectPrefix') }}{{ dialog.project?.name }}{{ t('uiConversationSidebarRemoveProjectSuffix') }}</p>
          <label class="navigation-delete-history">
            <input v-model="deleteProjectConversations" type="checkbox" :disabled="!projectRemoval?.count || dialogBusy" />
            <span>
              {{ t('uiConversationSidebarDeleteAssociatedPrefix') }} {{ projectRemoval?.count ?? '…' }} {{ t('uiConversationSidebarConversationCountSuffix') }}
            </span>
          </label>
          <p v-if="deleteProjectConversations" class="danger">
            {{ t('uiConversationSidebarDeleteAssociatedHelp')
            }}{{ projectRemoval?.activeCount ? t('uiConversationSidebarStopAssociatedTasks', { value1: projectRemoval.activeCount }) : ''
            }}{{ t('uiConversationSidebarDeletionIrreversible') }}
          </p>
          <p v-else class="navigation-hint">{{ t('uiConversationSidebarRemoveProjectKeepHistoryHelp') }}</p>
        </template>
        <p v-else>
          {{
            dialog.kind === 'close'
              ? t('uiConversationSidebarCloseDraftHelp')
              : t('uiConversationSidebarDeleteConversationHelp', { value1: dialog.item?.title || t('uiConversationNavigationRowUntitledConversation') })
          }}
        </p>
        <p v-if="error" role="alert" class="navigation-error">{{ error }}</p>
        <div class="navigation-dialog-actions">
          <button type="button" data-navigation-cancel :disabled="dialogBusy" @click="dialog = undefined">{{ t('uiBrowserPaneCancel') }}</button>
          <button
            :class="dialog.kind === 'rename' || dialog.kind === 'project-rename' ? 'primary' : 'danger'"
            :disabled="dialogBusy || (dialog.kind === 'project-remove' && !projectRemoval)"
          >
            {{
              dialogBusy
                ? t('reviewProcessing')
                : dialog.kind === 'rename' || dialog.kind === 'project-rename'
                  ? t('uiConversationSidebarSaveName')
                  : dialog.kind === 'project-remove'
                    ? t('uiConversationSidebarRemoveProject')
                    : t('uiConversationSidebarConfirm')
            }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
<style scoped src="./navigation/conversationSidebar.css"></style>
