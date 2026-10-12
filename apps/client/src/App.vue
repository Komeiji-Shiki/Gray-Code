<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { appearance, guard, initialize, loadSettings, report, state } from './state';
import { appearanceSystemLight, useSystemAppearance } from './appearance';
import { call, subscribe } from './api';
import { CHAT_INITIALIZATION_MESSAGE } from '../../../shared/chatInitialization';
import { SHELL_SHORTCUTS_MESSAGE, SHELL_SHORTCUT_MESSAGE, matchShellShortcut, shellShortcuts } from '../../../shared/shellShortcutBridge';
import { debugControl, debugState } from './debugging';
import { useNavigationIntent } from './navigationIntent';
import { shellText as t, setShellLanguage } from './i18n';
import { applyAppearanceVariables } from '../../../shared/appearanceTokens';
const navigate = useNavigationIntent();
import { readWorkspacePanelMessage } from '../../../shared/workspacePanelNavigation';
import Workbench from './components/Workbench.vue';
import ErrorBanner from './components/ErrorBanner.vue';
import ContentPreview from './components/ContentPreview.vue';
import RunInspector from './components/RunInspector.vue';
const ResourceLibrary = defineAsyncComponent(() => import('./components/ResourceLibrary.vue'));
const CharacterSetup = defineAsyncComponent(() => import('./components/CharacterSetup.vue'));
import AutomationsPanel from './components/AutomationsPanel.vue';
import ConversationSidebar from './components/ConversationSidebar.vue';
import WorkspaceSelector from './components/WorkspaceSelector.vue';
import WebDialogs from './components/WebDialogs.vue';
import NavigationIcon from './components/navigation/NavigationIcon.vue';
import { useNavigationFocus } from './components/navigation/useNavigationFocus';
import ComputerStatus from './components/ComputerStatus.vue';
const CompanionSetup = defineAsyncComponent(() => import('./components/CompanionSetup.vue'));
import PetSurface from './components/PetSurface.vue';
import ScreenSenseStatus from './components/ScreenSenseStatus.vue';
const productChatFrame = ref<HTMLIFrameElement>();
const conversationSidebar = ref<InstanceType<typeof ConversationSidebar>>();
const workbench = ref<InstanceType<typeof Workbench>>();
function jumpToMessage(target: { conversationId: string; messageIndex: number; messageId?: string }) {
  productChatFrame.value?.contentWindow?.postMessage(
    { type: 'graycode.jumpToMessage', ...target },
    window.location.origin === 'null' ? '*' : window.location.origin,
  );
}
function openWorkspacePanel(event: MessageEvent) {
  if (event.source === productChatFrame.value?.contentWindow && event.origin === window.location.origin) {
    if (event.data?.type === 'graycode.language' && typeof event.data.language === 'string') setShellLanguage(event.data.language);
    if (event.data?.type === CHAT_INITIALIZATION_MESSAGE && ['ready', 'failed'].includes(event.data.status)) {
      chatInitialized.value = event.data.status === 'ready';
      chatLoadFailed.value = !chatInitialized.value;
      chatInitializationError.value = typeof event.data.error === 'string' ? event.data.error : '';
      clearTimeout(chatReadyTimer);
    }
    if (event.data?.type === SHELL_SHORTCUTS_MESSAGE) sendShellShortcuts();
    if (event.data?.type === SHELL_SHORTCUT_MESSAGE
      && enabledShortcuts.value.some(binding => binding.command === event.data.command)) executeShellShortcut(event.data.command);
  }
  const panel = readWorkspacePanelMessage(event, productChatFrame.value?.contentWindow, window.location.origin);
  if (panel === 'memory') openLibrary('memory');
  else if (panel === 'pets') openCompanionSettings('pet');
  else if (panel === 'screenSense') openCompanionSettings('screen');
}
const companionOpen = ref(false);
const companionStep = ref<'character' | 'pet' | 'screen' | 'greeting'>('character');
const companionConversationId = ref<string>();
function openCompanionSettings(step: typeof companionStep.value = 'character') {
  companionStep.value = step;
  companionConversationId.value = state.mode === 'chat' ? state.conversationId || undefined : undefined;
  companionOpen.value = true;
}
const characterSetup = ref<{ characterId?: string } | null>(null);
const libraryOpen = ref(false);
const libraryInitialTab = ref<'resources' | 'memory'>('resources');
function openLibrary(tab: 'resources' | 'memory' = 'resources') {
  libraryInitialTab.value = tab;
  libraryOpen.value = true;
}
const automationsOpen = ref(false);
const companionGreeting = ref<{ conversationId: string }>();
function openCompanionGreeting(conversationId: string) {
  companionGreeting.value = { conversationId };
  automationsOpen.value = true;
}
function closeAutomations() {
  automationsOpen.value = false;
  companionGreeting.value = undefined;
}
const chatReady = ref(false);
const chatInitialized = ref(false);
const chatLoadFailed = ref(false);
const chatInitializationError = ref('');
const chatFrameVersion = ref(0);
let chatReadyTimer: ReturnType<typeof setTimeout> | undefined;
function watchChatReady() {
  clearTimeout(chatReadyTimer);
  if (chatInitialized.value || chatLoadFailed.value || !state.ready || lifetime.signal.aborted) return;
  chatReadyTimer = setTimeout(() => {
    if (!chatInitialized.value) chatLoadFailed.value = true;
  }, 20_000);
}
function reloadChat() {
  chatReady.value = false;
  chatInitialized.value = false;
  chatLoadFailed.value = false;
  chatInitializationError.value = '';
  chatFrameVersion.value++;
  void nextTick().then(watchChatReady);
}
function autoStartScreenSense(conversationId: string | null) {
  // 正常恢复的陪伴对话要等聊天初始化完成；启动失败页和重新加载期间不采集。
  if (!conversationId || !state.ready || !chatInitialized.value || chatLoadFailed.value || state.initializationError) return;
  void guard(() => call('screenSense.conversationOpened', { conversationId }));
}
watch([() => state.ready, chatInitialized], () => autoStartScreenSense(state.conversationId));
watch(
  () => state.ready,
  (ready) => {
    if (ready) void nextTick().then(watchChatReady);
    else clearTimeout(chatReadyTimer);
  },
);
import { webUi } from './webBridge';
const isWeb = window.graycode?.kind === 'web';
const appMenus = [
  { id: 'file', title: 'nativeFileMenu' },
  { id: 'edit', title: 'nativeEditMenu' },
  { id: 'view', title: 'nativeViewMenu' },
] as const;
const compactQuery = window.matchMedia('(max-width: 850px)');
const compactViewport = ref(compactQuery.matches);
const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight);
const viewportWidth = ref(window.innerWidth);
const savedSidebarWidth = Number(localStorage.getItem('graycode.sidebarWidth'));
const sidebarWidth = ref(Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0 ? savedSidebarWidth : 250);
// 侧栏拖到最宽时仍为聊天列和分隔条保留位置。
const sidebarMaximum = computed(() => Math.max(200, Math.min(560, viewportWidth.value - 480 - 5)));
const visibleSidebarWidth = computed(() => Math.max(200, Math.min(sidebarMaximum.value, sidebarWidth.value)));
const sidebarResizing = ref(false);
const navigation = ref<HTMLElement>();
const mobileNavigationOpen = ref(false);
const sidebarCollapsed = ref(localStorage.getItem('graycode.sidebarCollapsed') === 'true');
const navigationCollapsed = computed({
  get: () => (compactViewport.value ? !mobileNavigationOpen.value : sidebarCollapsed.value),
  set: (value) => {
    if (compactViewport.value) mobileNavigationOpen.value = !value;
    else sidebarCollapsed.value = value;
  },
});
const enabledShortcuts = computed(() => !state.ready ? [] : Object.entries(shellShortcuts)
  .filter(([command]) => !command.startsWith('debug.') || !!debugState.activeId)
  .map(([command, binding]) => ({ command, ...binding })));
function sendShellShortcuts() {
  productChatFrame.value?.contentWindow?.postMessage({ type: SHELL_SHORTCUTS_MESSAGE, bindings: enabledShortcuts.value },
    window.location.origin === 'null' ? '*' : window.location.origin);
}
function executeShellShortcut(command: string) {
  if (!state.ready) return;
  if (command === 'newConversation') void guard(() => conversationSidebar.value!.newConversation());
  else if (command === 'toggleSidebar') navigationCollapsed.value = !navigationCollapsed.value;
  else if (command === 'projectSearch') workbench.value?.activatePanel('search');
  else if (command.startsWith('debug.') && debugState.activeId) void debugControl(command.slice('debug.'.length));
}
function handleShellShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  const binding = matchShellShortcut(event, enabledShortcuts.value);
  if (!binding) return;
  event.preventDefault();
  executeShellShortcut(binding.command);
}
watch(enabledShortcuts, sendShellShortcuts);
watch(sidebarCollapsed, (value) => localStorage.setItem('graycode.sidebarCollapsed', String(value)));
if (compactViewport.value) state.chatFocused = true;
function updateViewport() {
  compactViewport.value = compactQuery.matches;
  viewportHeight.value = window.visualViewport?.height ?? window.innerHeight;
  viewportWidth.value = window.innerWidth;
}
function finishNavigation(panel?: 'workbench') {
  if (compactViewport.value) {
    mobileNavigationOpen.value = false;
    state.chatFocused = panel !== 'workbench';
  }
}
watch(
  () => state.settingsOpen,
  (value) => {
    if (value) mobileNavigationOpen.value = false;
  },
);
// 初始化包含多次请求，卸载时解除监听并忽略迟到的结果。
const lifetime = new AbortController();
let unsubscribeHost: (() => void) | undefined;
let unsubscribeState: (() => void) | undefined;
let initialization: AbortController | undefined;
const booting = ref(false);
async function bootstrap() {
  if (booting.value || lifetime.signal.aborted) return;
  booting.value = true;
  if (state.initializationError && state.error === state.initializationError) state.error = '';
  unsubscribeState?.();
  initialization?.abort();
  initialization = new AbortController();
  const signal = initialization.signal;
  try {
    unsubscribeState = await initialize(signal);
    if (signal.aborted) return;
    await call('ui.context.set', { workspaceId: state.workspaceId, mode: state.mode });
    if (signal.aborted) return;
    if (!isWeb) {
      await nextTick();
      if (!signal.aborted) await call('desktop.files.ready');
    }
  } catch (error) {
    if (!signal.aborted) {
      state.ready = false;
      state.initializationError = error instanceof Error ? error.message : String(error);
      report(error);
    }
  } finally {
    if (!signal.aborted) booting.value = false;
  }
}
const storedSplit = Number(localStorage.getItem('graycode.chatWidth'));
const split = ref(Number.isFinite(storedSplit) && storedSplit > 0 ? Math.max(25, Math.min(75, storedSplit)) : 48);
const resizing = ref(false);
const container = ref<HTMLElement>();
const choosingWorkspace = ref(false);
async function addWorkspace() {
  const intent = navigate();
  if (choosingWorkspace.value) return;
  choosingWorkspace.value = true;
  try {
    const selected = await call<{ directory: string; name: string } | null>('desktop.chooseWorkspace');
    if (!selected) return;
    const workspace = await call<{ id: string }>('workspaces.add', selected);
    await loadSettings();
    if (intent.current()) await conversationSidebar.value?.selectWorkspace(workspace.id);
  } finally {
    choosingWorkspace.value = false;
  }
}
const modeMenuOpen = ref(false);
const modeMenu = ref<HTMLElement>();
const modeTrigger = ref<HTMLElement>();
const modeFocus = useNavigationFocus(
  modeMenu,
  () => {
    modeMenuOpen.value = false;
  },
  () => modeTrigger.value,
);
const choosingMode = ref(false);
const modes = computed(
  () =>
    [
      { id: 'chat', name: t('chat'), detail: t('chatDetail') },
      { id: 'code', name: t('code'), detail: t('codeDetail') },
      { id: 'character', name: t('character'), detail: t('characterDetail') },
    ] as const,
);
async function selectMode(mode: 'chat' | 'code' | 'character') {
  if (choosingMode.value) return;
  choosingMode.value = true;
  const intent = navigate({ workspaceId: state.workspaceId, tabId: state.conversationId ?? undefined });
  try {
    const result = await call('ui.request', {
      type: 'ui.mode.select',
      data: { mode, conversationId: state.conversationId, workspaceId: mode === 'code' ? state.workspaceId : undefined },
    });
    if (!intent.current()) return;
    if (mode === 'code' && result.workspaceId) state.workspaceId = result.workspaceId;
    state.mode = mode;
    modeMenuOpen.value = false;
  } finally {
    choosingMode.value = false;
  }
}
watch(
  [
    libraryOpen,
    automationsOpen,
    characterSetup,
    companionOpen,
    () => state.navigationDialogOpen,
    () => state.fileDialogOpen,
    () => state.panelMenuOpen,
  ],
  () => {
    state.panelObscured =
      libraryOpen.value ||
      automationsOpen.value ||
      !!characterSetup.value ||
      companionOpen.value ||
      state.navigationDialogOpen ||
      state.fileDialogOpen ||
      state.panelMenuOpen;
  },
);
function dragSplit(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  resizing.value = true;
  state.panelResizing = true;
}
function moveSplit(event: PointerEvent) {
  if (!resizing.value || !container.value) return;
  const bounds = container.value.getBoundingClientRect();
  split.value = Math.max(25, Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100));
}
function endSplit() {
  resizing.value = false;
  state.panelResizing = false;
  localStorage.setItem('graycode.chatWidth', String(split.value));
}
function dragSidebar(event: PointerEvent) {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  sidebarResizing.value = true;
  state.panelResizing = true;
}
function moveSidebar(event: PointerEvent) {
  if (!sidebarResizing.value || !navigation.value) return;
  sidebarWidth.value = Math.max(200, Math.min(sidebarMaximum.value, event.clientX - navigation.value.getBoundingClientRect().left));
}
function endSidebar(event?: PointerEvent) {
  const target = event?.currentTarget as HTMLElement | undefined;
  if (event && target?.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  sidebarResizing.value = false;
  state.panelResizing = false;
  sidebarWidth.value = visibleSidebarWidth.value;
  localStorage.setItem('graycode.sidebarWidth', String(sidebarWidth.value));
}
function resizeSidebarBy(amount: number) {
  sidebarWidth.value = visibleSidebarWidth.value + amount;
  endSidebar();
}
// 与聊天文档一致：变量写到根元素，tokens.css 的派生色才能拿到当前色板。
watchEffect(() => {
  if (appearance.value) applyAppearanceVariables(document.documentElement, appearance.value, appearanceSystemLight.value);
});
useSystemAppearance();
watch(
  () => state.workspaceId,
  (id) => {
    if (state.ready) void guard(() => call('ui.context.set', { workspaceId: id, mode: state.mode }));
  },
);
onMounted(() => {
  window.addEventListener('message', openWorkspacePanel);
  window.addEventListener('keydown', handleShellShortcut);
  compactQuery.addEventListener('change', updateViewport);
  window.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport);
  unsubscribeHost = subscribe((event) => {
    if (lifetime.signal.aborted) return;
    if (event.type === 'ui.ready') chatReady.value = true;
    if (event.type === 'desktop.shortcut' && enabledShortcuts.value.some(binding => binding.command === event.command))
      executeShellShortcut(event.command);
    if (event.type === 'workspace.selected' && event.source === 'desktop')
      void guard(() => conversationSidebar.value!.selectWorkspace(event.workspaceId));
    if (event.type === 'transport.resumed' && !state.ready && !booting.value) void bootstrap();
    if (event.type === 'pets.open') openCompanionSettings('pet');
    if (event.type === 'screenSense.open') openCompanionSettings('screen');
    if (event.type === 'ui.conversation.focused' && !event.resynchronized) autoStartScreenSense(event.conversationId);
    if (event.type === 'ui.view.changed') state.settingsOpen = event.view === 'settings';
    if (event.type === 'settings.open') void guard(() => call('ui.command', { command: 'showSettings' }));
    if (event.type === 'ui.message' && event.message?.command === 'channels.configChanged') void guard(() => loadSettings(lifetime.signal));
  });
  void bootstrap();
});
onUnmounted(() => {
  lifetime.abort();
  initialization?.abort();
  unsubscribeState?.();
  clearTimeout(chatReadyTimer);
  window.removeEventListener('message', openWorkspacePanel);
  window.removeEventListener('keydown', handleShellShortcut);
  unsubscribeHost?.();
  compactQuery.removeEventListener('change', updateViewport);
  window.removeEventListener('resize', updateViewport);
  window.visualViewport?.removeEventListener('resize', updateViewport);
});
</script>
<template>
  <div
    class="application"
    :class="{ 'web-host': isWeb, 'compact-host': compactViewport }"
    :style="{ '--gc-viewport-height': viewportHeight + 'px' }"
    :data-density="appearance?.density"
  >
    <header class="titlebar">
      <button
        v-if="!state.settingsOpen"
        class="sidebar-toggle"
        :title="(navigationCollapsed ? t('uiAppExpandConversationList') : t('uiAppCollapseConversationList')) + ' (Ctrl+B)'"
        :aria-expanded="!navigationCollapsed"
        :aria-label="t('uiAppToggleConversationList')"
        @click="navigationCollapsed = !navigationCollapsed"
      >
        <NavigationIcon name="panel" />
      </button>
      <div
        class="mode-switcher"
        @focusout="
          (event) => {
            if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) modeMenuOpen = false;
          }
        "
      >
        <button
          ref="modeTrigger"
          class="mode-trigger"
          :aria-expanded="modeMenuOpen"
          aria-haspopup="menu"
          @click="
            modeFocus.rememberTrigger($event);
            modeMenuOpen = !modeMenuOpen;
          "
        >
          <strong>GrayCode</strong>
          <span>{{ modes.find((mode) => mode.id === state.mode)?.name }}</span>
          <span>⌄</span>
        </button>
        <div v-if="modeMenuOpen" ref="modeMenu" class="mode-menu" role="menu" tabindex="-1">
          <button
            v-for="mode in modes"
            :key="mode.id"
            role="menuitemradio"
            :disabled="choosingMode"
            :aria-checked="state.mode === mode.id"
            @click="guard(() => selectMode(mode.id))"
          >
            <span>
              <strong>{{ mode.name }}</strong>
              <small>{{ mode.detail }}</small>
            </span>
            <span v-if="state.mode === mode.id">✓</span>
          </button>
        </div>
      </div>
      <nav v-if="!isWeb && !compactViewport" class="app-menu" :aria-label="t('uiAppApplicationMenu')">
        <button v-for="menu in appMenus" :key="menu.id" @click="guard(() => call('desktop.menu', { id: menu.id }))">{{ t(menu.title) }}</button>
      </nav>
      <div v-if="state.mode === 'code' || !state.chatFocused" class="titlebar-center">
        <span class="subtle">{{ t('workspace') }}</span>
        <WorkspaceSelector
          :model-value="state.workspaceId"
          @update:model-value="(id) => guard(() => conversationSidebar!.selectWorkspace(id))"
          :workspaces="state.snapshot?.settings.workspaces ?? []"
          @browse="guard(addWorkspace)"
        />
        <button
          class="quiet-button workspace-add"
          :disabled="choosingWorkspace"
          :title="isWeb ? t('chooseFolder') : t('addWorkspace')"
          :aria-label="isWeb ? t('chooseFolder') : t('addWorkspace')"
          @click="guard(addWorkspace)"
        >
          ＋
        </button>
      </div>
      <button
        v-if="!state.settingsOpen"
        class="quiet-button panel-toggle"
        :aria-pressed="!state.chatFocused"
        @click="
          state.chatFocused = !state.chatFocused;
          mobileNavigationOpen = false;
        "
      >
        {{ compactViewport ? (state.chatFocused ? t('workbench') : t('backToChat')) : state.chatFocused ? t('openPanel') : t('closePanel') }}
      </button>
      <button v-if="!compactViewport" class="quiet-button" @click="openLibrary()">{{ t('library') }}</button>
      <button v-if="!compactViewport && state.mode === 'character'" class="quiet-button" @click="characterSetup = {}">{{ t('characterSetup') }}</button>
      <button v-if="!compactViewport && !state.settingsOpen && state.mode === 'chat'" class="quiet-button" @click="openCompanionSettings()">
        {{ t('uiAppCompanionSettings') }}
      </button>
      <button v-if="isWeb && !compactViewport" class="quiet-button" @click="guard(() => call('web.logout'))">{{ t('uiAppSignOut') }}</button>
      <details v-if="compactViewport" class="mobile-tools">
        <summary>{{ t('uiAppMore') }}</summary>
        <div @click="($event.currentTarget as HTMLElement).parentElement?.removeAttribute('open')">
          <template v-if="!isWeb">
            <button v-for="menu in appMenus" :key="menu.id" @click="guard(() => call('desktop.menu', { id: menu.id }))">{{ t(menu.title) }}</button>
          </template>
          <button :disabled="choosingWorkspace" @click="guard(addWorkspace)">{{ isWeb ? t('chooseFolder') : t('addWorkspace') }}</button>
          <button @click="automationsOpen = true">{{ t('uiConversationSidebarAutomations') }}</button>
          <button @click="openLibrary()">{{ t('library') }}</button>
          <button v-if="state.mode === 'chat'" @click="openCompanionSettings()">{{ t('uiAppCompanionSettings') }}</button>
          <button v-if="state.mode === 'character'" @click="characterSetup = {}">{{ t('characterSetup') }}</button>
          <button v-if="isWeb" @click="guard(() => call('web.logout'))">{{ t('uiAppSignOut') }}</button>
        </div>
      </details>
    </header>
    <ErrorBanner v-if="state.error" :message="state.error" @dismiss="state.error = ''" />
    <div v-if="state.notice" class="notice-banner" :data-severity="state.notice.severity" role="status">
      <span>{{ state.notice.message }}</span>
      <button @click="state.notice = null">{{ t('close') }}</button>
    </div>
    <div v-if="state.ready && chatLoadFailed" class="notice-banner" data-severity="warning" role="alert">
      <span>
        {{ t('chatInitializationFailed') }}
        <template v-if="chatInitializationError">{{ chatInitializationError }}</template>
      </span>
      <button @click="reloadChat">{{ t('retryChat') }}</button>
    </div>
    <ComputerStatus v-if="state.ready" />
    <ScreenSenseStatus v-if="state.ready" @manage="openCompanionSettings('screen')" />
    <CharacterSetup v-if="characterSetup" :character-id="characterSetup.characterId" @close="characterSetup = null" />
    <CompanionSetup
      v-if="companionOpen"
      :conversation-id="companionConversationId"
      :initial-step="companionStep"
      @close="companionOpen = false"
      @memory="openLibrary('memory')"
      @reminders="automationsOpen = true"
      @greeting="openCompanionGreeting"
      @applied="
        (id) => {
          if (id !== state.conversationId) guard(() => call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } }));
        }
      "
    />
    <ResourceLibrary
      v-if="libraryOpen"
      :initial-tab="libraryInitialTab"
      @close="libraryOpen = false"
      @pets="openCompanionSettings('pet')"
      @play="
        (id) => {
          libraryOpen = false;
          characterSetup = { characterId: id };
        }
      "
    />
    <PetSurface
      v-if="state.ready"
      surface="app"
      :conversation-id="state.conversationId || undefined"
      @manage="openCompanionSettings('pet')"
      @open="(id) => guard(() => call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } }))"
    />
    <ContentPreview />
    <WebDialogs v-if="isWeb" />
    <AutomationsPanel :open="automationsOpen" :companion-request="companionGreeting" @close="closeAutomations" />
    <RunInspector v-if="state.ready && !state.settingsOpen" />
    <div
      v-if="!state.ready"
      class="loading-state"
      :class="{ 'startup-error': state.initializationError }"
      :role="state.initializationError ? 'alert' : 'status'"
    >
      <template v-if="state.initializationError">
        <strong>{{ t('initializationFailed') }}</strong>
        <p>{{ state.initializationError }}</p>
        <button :disabled="booting" @click="bootstrap">{{ t('retryInitialization') }}</button>
      </template>
      <template v-else>{{ t('connecting') }}</template>
    </div>
    <div v-else class="application-body" :class="{ resizing: sidebarResizing }">
      <button
        v-if="compactViewport && mobileNavigationOpen && !state.settingsOpen"
        class="navigation-backdrop"
        :aria-label="t('uiAppCollapseConversationList')"
        @click="mobileNavigationOpen = false"
      ></button>
      <div
        ref="navigation"
        v-show="!state.settingsOpen && (!compactViewport || mobileNavigationOpen)"
        class="conversation-navigation"
        :style="{ '--gc-sidebar-width': visibleSidebarWidth + 'px' }"
        :inert="!chatReady || undefined"
        :aria-busy="!chatReady"
      >
        <ConversationSidebar
          ref="conversationSidebar"
          v-model:collapsed="navigationCollapsed"
          @automations="
            finishNavigation();
            automationsOpen = true;
          "
          @navigate="finishNavigation"
          @jump-to-message="jumpToMessage"
          @add-workspace="
            guard(async () => {
              finishNavigation();
              await addWorkspace();
            })
          "
        />
        <div
          v-if="!compactViewport && !navigationCollapsed"
          class="navigation-resize"
          role="separator"
          :aria-label="t('uiAppResizeConversationList')"
          aria-orientation="vertical"
          :aria-valuemin="200"
          :aria-valuemax="sidebarMaximum"
          :aria-valuenow="Math.round(visibleSidebarWidth)"
          tabindex="0"
          @pointerdown.prevent="dragSidebar"
          @pointermove="moveSidebar"
          @pointerup="endSidebar"
          @pointercancel="endSidebar"
          @lostpointercapture="endSidebar"
          @keydown.left.prevent="resizeSidebarBy(-10)"
          @keydown.right.prevent="resizeSidebarBy(10)"
          @dblclick="
            sidebarWidth = 250;
            endSidebar();
          "
        ></div>
      </div>
      <div
        ref="container"
        class="desktop-workspace"
        :class="{
          'chat-focused': state.chatFocused || state.settingsOpen,
          'workbench-expanded': state.workbenchExpanded && !state.chatFocused && !state.settingsOpen,
          'mobile-workbench': compactViewport && !state.chatFocused && !state.settingsOpen,
          resizing,
        }"
        :style="{ '--gc-chat-width': split + '%' }"
      >
        <iframe
          :key="chatFrameVersion"
          ref="productChatFrame"
          class="product-chat"
          src="./chat/platform.html"
          :title="t('uiAppConversationsAndSettings')"
          @load="watchChatReady"
          @error="chatLoadFailed = true"
        ></iframe>
        <div
          v-if="!state.chatFocused && !state.settingsOpen"
          class="split-handle"
          role="separator"
          :aria-label="t('uiAppResizeConversationAndPanel')"
          aria-orientation="vertical"
          :aria-valuemin="25"
          :aria-valuemax="75"
          :aria-valuenow="Math.round(split)"
          tabindex="0"
          @pointerdown.prevent="dragSplit"
          @pointermove="moveSplit"
          @pointerup="endSplit"
          @pointercancel="endSplit"
          @lostpointercapture="endSplit"
          @keydown.left.prevent="
            split = Math.max(25, split - 2);
            endSplit();
          "
          @keydown.right.prevent="
            split = Math.min(75, split + 2);
            endSplit();
          "
        ></div>
        <Workbench ref="workbench" v-show="!state.chatFocused && !state.settingsOpen" :compact="compactViewport" />
      </div>
    </div>
    <footer class="statusbar">
      <span>
        {{ state.snapshot?.settings.workspaces.find((workspace) => workspace.id === state.workspaceId)?.directory ?? '' }}
      </span>
      <span class="statusbar-right">
        {{ isWeb ? (webUi.connection === 'connected' ? t('uiAppWebConnected') : t('uiAppWebReconnecting')) : t('uiAppDesktopTitle') }}
      </span>
    </footer>
  </div>
</template>
<style src="./styles/appShell.css"></style>
