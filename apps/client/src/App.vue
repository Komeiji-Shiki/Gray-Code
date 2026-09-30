<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { appearance, guard, initialize, loadSettings, report, state } from './state';
import { appearancePalette, resolvedTheme, useSystemAppearance } from './appearance';
import { call, subscribe } from './api';
import { useNavigationIntent } from './navigationIntent';
import { shellText as t, setShellLanguage } from './i18n';
import { appearanceCssVariables } from '../../../shared/appearanceTokens';
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
const PetManager = defineAsyncComponent(() => import('./components/PetManager.vue'));
import PetSurface from './components/PetSurface.vue';
const ScreenSenseSettings = defineAsyncComponent(() => import('./components/ScreenSenseSettings.vue'));
import ScreenSenseStatus from './components/ScreenSenseStatus.vue';
const productChatFrame = ref<HTMLIFrameElement>();
function jumpToMessage(target: { conversationId: string; messageIndex: number; messageId?: string }) {
  productChatFrame.value?.contentWindow?.postMessage({ type: 'graycode.jumpToMessage', ...target },
    window.location.origin === 'null' ? '*' : window.location.origin);
}
function openWorkspacePanel(event: MessageEvent) {
  if (event.source === productChatFrame.value?.contentWindow && event.origin === window.location.origin
    && event.data?.type === 'graycode.language' && typeof event.data.language === 'string') setShellLanguage(event.data.language);
  const panel = readWorkspacePanelMessage(event, productChatFrame.value?.contentWindow, window.location.origin);
  if (panel === 'memory') openLibrary('memory');
  else if (panel === 'pets') petManagerOpen.value = true;
  else if (panel === 'screenSense') screenSenseOpen.value = true;
}
const screenSenseOpen = ref(false);
const petManagerOpen = ref(false);
const companionOpen = ref(false);
const characterSetup = ref<{ characterId?: string } | null>(null);
const libraryOpen = ref(false);
const libraryInitialTab = ref<'resources' | 'memory'>('resources');
function openLibrary(tab: 'resources' | 'memory' = 'resources') { libraryInitialTab.value = tab; libraryOpen.value = true; }
const automationsOpen = ref(false);
const chatReady = ref(false);
const chatLoadFailed = ref(false);
const chatFrameVersion = ref(0);
let chatReadyTimer: ReturnType<typeof setTimeout> | undefined;
function watchChatReady() {
  clearTimeout(chatReadyTimer);
  if (chatReady.value || !state.ready || lifetime.signal.aborted) return;
  chatReadyTimer = setTimeout(() => { if (!chatReady.value) chatLoadFailed.value = true; }, 20_000);
}
function reloadChat() {
  chatReady.value = false; chatLoadFailed.value = false; chatFrameVersion.value++;
  void nextTick().then(watchChatReady);
}
watch(() => state.ready, ready => { if (ready) void nextTick().then(watchChatReady); else clearTimeout(chatReadyTimer); });
import { webUi } from './webBridge';
const isWeb = window.graycode?.kind === 'web';
const appMenus = ['编辑', '视图'];
const compactQuery = window.matchMedia('(max-width: 850px)');
const compactViewport = ref(compactQuery.matches);
const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight);
const viewportWidth = ref(window.innerWidth);
const savedSidebarWidth = Number(localStorage.getItem('graycode.sidebarWidth'));
const sidebarWidth = ref(Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0 ? savedSidebarWidth : 250);
const sidebarMaximum = computed(() => Math.max(200, Math.min(560, viewportWidth.value - 360)));
const visibleSidebarWidth = computed(() => Math.max(200, Math.min(sidebarMaximum.value, sidebarWidth.value)));
const sidebarResizing = ref(false);
const navigation = ref<HTMLElement>();
const mobileNavigationOpen = ref(false);
const sidebarCollapsed = ref(localStorage.getItem('graycode.sidebarCollapsed') === 'true');
const navigationCollapsed = computed({ get: () => compactViewport.value ? !mobileNavigationOpen.value : sidebarCollapsed.value,
  set: value => { if (compactViewport.value) mobileNavigationOpen.value = !value; else sidebarCollapsed.value = value; } });
watch(sidebarCollapsed, value => localStorage.setItem('graycode.sidebarCollapsed', String(value)));
if (compactViewport.value) state.chatFocused = true;
function updateViewport() { compactViewport.value = compactQuery.matches; viewportHeight.value = window.visualViewport?.height ?? window.innerHeight; viewportWidth.value = window.innerWidth; }
function finishNavigation(panel?: 'workbench') { if (compactViewport.value) { mobileNavigationOpen.value = false; state.chatFocused = panel !== 'workbench'; } }
watch(() => state.settingsOpen, value => { if (value) mobileNavigationOpen.value = false; });
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
  unsubscribeState?.(); initialization?.abort(); initialization = new AbortController();
  const signal = initialization.signal;
  try {
    unsubscribeState = await initialize(signal);
    if (signal.aborted) return;
    await call('ui.context.set', { workspaceId: state.workspaceId, mode: state.mode });
    if (signal.aborted) return;
    if (!isWeb) { await nextTick(); if (!signal.aborted) await call('desktop.files.ready'); }
  } catch (error) {
    if (!signal.aborted) {
      state.ready = false; state.initializationError = error instanceof Error ? error.message : String(error);
      report(error);
    }
  } finally { if (!signal.aborted) booting.value = false; }
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
    await loadSettings(); if (intent.current()) state.workspaceId = workspace.id;
  } finally { choosingWorkspace.value = false; }
}
const modeMenuOpen = ref(false);
const modeMenu = ref<HTMLElement>();
const modeTrigger = ref<HTMLElement>();
const modeFocus = useNavigationFocus(modeMenu, () => { modeMenuOpen.value = false; }, () => modeTrigger.value);
const choosingMode = ref(false);
const modes = computed(() => [{ id: 'chat', name: t('chat'), detail: t('chatDetail') }, { id: 'code', name: t('code'), detail: t('codeDetail') }, { id: 'character', name: t('character'), detail: t('characterDetail') }] as const);
async function selectMode(mode: 'chat' | 'code' | 'character') {
  if (choosingMode.value) return;
  choosingMode.value = true;
  const intent = navigate({ workspaceId: state.workspaceId, tabId: state.conversationId ?? undefined });
  try {
    const result = await call('ui.request', { type: 'ui.mode.select', data: { mode, conversationId: state.conversationId, workspaceId: mode === 'code' ? state.workspaceId : undefined } });
    if (!intent.current()) return;
    if (mode === 'code' && result.workspaceId) state.workspaceId = result.workspaceId;
    state.mode = mode; modeMenuOpen.value = false;
  } finally { choosingMode.value = false; }
}
watch([libraryOpen, automationsOpen, characterSetup, companionOpen, petManagerOpen, screenSenseOpen, () => state.navigationDialogOpen, () => state.fileDialogOpen, () => state.panelMenuOpen], () => { state.panelObscured = libraryOpen.value || automationsOpen.value || !!characterSetup.value || companionOpen.value || petManagerOpen.value || screenSenseOpen.value || state.navigationDialogOpen || state.fileDialogOpen || state.panelMenuOpen; });
function dragSplit(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId); resizing.value = true; state.panelResizing = true;
}
function moveSplit(event: PointerEvent) {
  if (!resizing.value || !container.value) return;
  const bounds = container.value.getBoundingClientRect();
  split.value = Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100));
}
function endSplit() { resizing.value = false; state.panelResizing = false; localStorage.setItem('graycode.chatWidth', String(split.value)); }
function dragSidebar(event: PointerEvent) {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  sidebarResizing.value = true; state.panelResizing = true;
}
function moveSidebar(event: PointerEvent) {
  if (!sidebarResizing.value || !navigation.value) return;
  sidebarWidth.value = Math.max(200, Math.min(sidebarMaximum.value, event.clientX - navigation.value.getBoundingClientRect().left));
}
function endSidebar(event?: PointerEvent) {
  const target = event?.currentTarget as HTMLElement | undefined;
  if (event && target?.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  sidebarResizing.value = false; state.panelResizing = false;
  sidebarWidth.value = visibleSidebarWidth.value;
  localStorage.setItem('graycode.sidebarWidth', String(sidebarWidth.value));
}
function resizeSidebarBy(amount: number) { sidebarWidth.value = visibleSidebarWidth.value + amount; endSidebar(); }
const variables = computed(() => {
  const config = appearance.value;
  if (!config) return {};
  return { '--ui-font': config.uiFont, '--code-font': config.codeFont, '--text-font': config.textFont,
    '--font-size': config.fontSize + 'px', '--line-height': String(config.lineHeight),
    ...appearanceCssVariables(Object.fromEntries(Object.entries(appearancePalette.value).filter(([name, value]) => /^[a-zA-Z-]+$/.test(name) && CSS.supports('color', value)))) };
});
useSystemAppearance();
watch(() => state.workspaceId, id => { localStorage.setItem('graycode.workspaceId', id); if (state.ready) void guard(() => call('ui.context.set', { workspaceId: id, mode: state.mode })); });
onMounted(() => {
  window.addEventListener('message', openWorkspacePanel);
  compactQuery.addEventListener('change', updateViewport);
  window.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport);
  unsubscribeHost = subscribe(event => {
    if (lifetime.signal.aborted) return;
    if (event.type === 'ui.ready') { chatReady.value = true; chatLoadFailed.value = false; clearTimeout(chatReadyTimer); }
    if (event.type === 'transport.resumed' && !state.ready && !booting.value) void bootstrap();
    if (event.type === 'pets.open') petManagerOpen.value = true;
    if (event.type === 'screenSense.open') screenSenseOpen.value = true;
    if (event.type === 'ui.view.changed') state.settingsOpen = event.view === 'settings';
    if (event.type === 'settings.open') void guard(() => call('ui.command', { command: 'showSettings' }));
    if (event.type === 'ui.message' && event.message?.command === 'channels.configChanged') void guard(() => loadSettings(lifetime.signal));
  });
  void bootstrap();
});
onUnmounted(() => { lifetime.abort(); initialization?.abort(); unsubscribeState?.(); clearTimeout(chatReadyTimer); window.removeEventListener('message', openWorkspacePanel); unsubscribeHost?.(); compactQuery.removeEventListener('change', updateViewport); window.removeEventListener('resize', updateViewport); window.visualViewport?.removeEventListener('resize', updateViewport); });
</script>
<template>
  <div class="application" :class="{ 'web-host': isWeb, 'compact-host': compactViewport }" :style="[variables, { '--viewport-height': viewportHeight + 'px' }]" :data-theme="resolvedTheme" :data-density="appearance?.density">
    <header class="titlebar">
      <button v-if="!state.settingsOpen" class="sidebar-toggle" :title="navigationCollapsed ? '展开对话列表' : '收起对话列表'" :aria-expanded="!navigationCollapsed" aria-label="切换对话列表" @click="navigationCollapsed = !navigationCollapsed"><NavigationIcon name="panel" /></button>
      <div class="mode-switcher" @focusout="event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) modeMenuOpen = false; }">
        <button ref="modeTrigger" class="mode-trigger" :aria-expanded="modeMenuOpen" aria-haspopup="menu" @click="modeFocus.rememberTrigger($event); modeMenuOpen = !modeMenuOpen"><strong>GrayCode</strong><span>{{ modes.find(mode => mode.id === state.mode)?.name }}</span><span>⌄</span></button>
        <div v-if="modeMenuOpen" ref="modeMenu" class="mode-menu" role="menu" tabindex="-1">
          <button v-for="mode in modes" :key="mode.id" role="menuitemradio" :disabled="choosingMode" :aria-checked="state.mode === mode.id" @click="guard(() => selectMode(mode.id))"><span><strong>{{ mode.name }}</strong><small>{{ mode.detail }}</small></span><span v-if="state.mode === mode.id">✓</span></button>
        </div>
      </div>
      <nav v-if="!isWeb && !compactViewport" class="app-menu" aria-label="应用菜单"><button v-for="menu in appMenus" :key="menu" @click="guard(() => call('desktop.menu', { label: menu }))">{{ menu }}</button></nav>
      <div v-if="state.mode === 'code' || !state.chatFocused" class="titlebar-center"><span class="subtle">{{ t('workspace') }}</span>
        <WorkspaceSelector :model-value="state.workspaceId" @update:model-value="id => { navigate({ workspaceId: id }); state.workspaceId = id; }" :workspaces="state.snapshot?.settings.workspaces ?? []" @browse="guard(addWorkspace)" />
        <button class="quiet-button workspace-add" :disabled="choosingWorkspace" :title="isWeb ? t('chooseFolder') : t('addWorkspace')" :aria-label="isWeb ? t('chooseFolder') : t('addWorkspace')" @click="guard(addWorkspace)">＋</button>
      </div>
      <button v-if="!state.settingsOpen" class="quiet-button panel-toggle" :aria-pressed="!state.chatFocused" @click="state.chatFocused = !state.chatFocused; mobileNavigationOpen = false">{{ compactViewport ? (state.chatFocused ? t('workbench') : t('backToChat')) : (state.chatFocused ? t('openPanel') : t('closePanel')) }}</button>
      <button v-if="!compactViewport" class="quiet-button" @click="openLibrary()">{{ t('library') }}</button><button v-if="!compactViewport && state.mode === 'character'" class="quiet-button" @click="characterSetup = {}">{{ t('characterSetup') }}</button>
      <button v-if="!compactViewport && !state.settingsOpen && state.mode === 'chat'" class="quiet-button" @click="companionOpen = true">陪伴配置</button>
      <button v-if="isWeb && !compactViewport" class="quiet-button" @click="guard(() => call('web.logout'))">退出登录</button>
      <details v-if="compactViewport" class="mobile-tools"><summary>更多</summary><div @click="($event.currentTarget as HTMLElement).parentElement?.removeAttribute('open')"><template v-if="!isWeb"><button v-for="menu in appMenus" :key="menu" @click="guard(() => call('desktop.menu', { label: menu }))">{{ menu }}</button></template><button :disabled="choosingWorkspace" @click="guard(addWorkspace)">{{ isWeb ? t('chooseFolder') : t('addWorkspace') }}</button><button @click="automationsOpen = true">自动任务</button><button @click="openLibrary()">{{ t('library') }}</button><button v-if="state.mode === 'chat'" @click="companionOpen = true">陪伴配置</button><button v-if="state.mode === 'character'" @click="characterSetup = {}">{{ t('characterSetup') }}</button><button v-if="isWeb" @click="guard(() => call('web.logout'))">退出登录</button></div></details>
    </header>
    <ErrorBanner v-if="state.error" :message="state.error" @dismiss="state.error = ''" />
    <div v-if="state.notice" class="notice-banner" :data-severity="state.notice.severity" role="status"><span>{{ state.notice.message }}</span><button @click="state.notice = null">{{ t('close') }}</button></div>
    <div v-if="state.ready && chatLoadFailed" class="notice-banner" data-severity="warning" role="alert"><span>{{ t('chatInitializationFailed') }}</span><button @click="reloadChat">{{ t('retryChat') }}</button></div>
    <ComputerStatus v-if="state.ready" /><ScreenSenseStatus v-if="state.ready" @manage="screenSenseOpen = true" />
    <ScreenSenseSettings v-if="screenSenseOpen" @close="screenSenseOpen = false" />
    <CharacterSetup v-if="characterSetup" :character-id="characterSetup.characterId" @close="characterSetup = null" />
    <CompanionSetup v-if="companionOpen" :conversation-id="state.conversationId || undefined" @close="companionOpen = false" @memory="openLibrary('memory')" @reminders="automationsOpen = true" @applied="id => { if (id !== state.conversationId) guard(() => call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } })); }" />
    <ResourceLibrary v-if="libraryOpen" :initial-tab="libraryInitialTab" @close="libraryOpen = false" @pets="petManagerOpen = true" @play="id => { libraryOpen = false; characterSetup = { characterId: id }; }" />
    <PetManager v-if="petManagerOpen" @close="petManagerOpen = false" @screen-sense="screenSenseOpen = true" />
    <PetSurface v-if="state.ready" surface="app" :conversation-id="state.conversationId || undefined" @manage="petManagerOpen = true" @open="id => guard(() => call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } }))" />
    <ContentPreview />
    <WebDialogs v-if="isWeb" />
    <AutomationsPanel :open="automationsOpen" @close="automationsOpen = false" />
    <RunInspector v-if="state.ready && !state.settingsOpen" />
    <div v-if="!state.ready" class="loading-state" :class="{ 'startup-error': state.initializationError }" :role="state.initializationError ? 'alert' : 'status'">
      <template v-if="state.initializationError"><strong>{{ t('initializationFailed') }}</strong><p>{{ state.initializationError }}</p><button :disabled="booting" @click="bootstrap">{{ t('retryInitialization') }}</button></template>
      <template v-else>{{ t('connecting') }}</template>
    </div>
    <div v-else class="application-body" :class="{ resizing: sidebarResizing }">
      <button v-if="compactViewport && mobileNavigationOpen && !state.settingsOpen" class="navigation-backdrop" aria-label="收起对话列表" @click="mobileNavigationOpen = false"></button>
      <div ref="navigation" v-show="!state.settingsOpen && (!compactViewport || mobileNavigationOpen)" class="conversation-navigation" :style="{ '--sidebar-width': visibleSidebarWidth + 'px' }" :inert="!chatReady || undefined" :aria-busy="!chatReady">
        <ConversationSidebar v-model:collapsed="navigationCollapsed" @automations="finishNavigation(); automationsOpen = true" @navigate="finishNavigation" @jump-to-message="jumpToMessage" @add-workspace="guard(async () => { finishNavigation(); await addWorkspace(); })" />
        <div v-if="!compactViewport && !navigationCollapsed" class="navigation-resize" role="separator" aria-label="调整对话列表宽度" aria-orientation="vertical" :aria-valuemin="200" :aria-valuemax="sidebarMaximum" :aria-valuenow="Math.round(visibleSidebarWidth)" tabindex="0" @pointerdown.prevent="dragSidebar" @pointermove="moveSidebar" @pointerup="endSidebar" @pointercancel="endSidebar" @lostpointercapture="endSidebar" @keydown.left.prevent="resizeSidebarBy(-10)" @keydown.right.prevent="resizeSidebarBy(10)" @dblclick="sidebarWidth = 250; endSidebar()"></div>
      </div>
    <div ref="container" class="desktop-workspace" :class="{ 'chat-focused': state.chatFocused || state.settingsOpen, 'workbench-expanded': state.workbenchExpanded && !state.chatFocused && !state.settingsOpen, 'mobile-workbench': compactViewport && !state.chatFocused && !state.settingsOpen, resizing }" :style="{ '--chat-width': split + '%' }">
      <iframe :key="chatFrameVersion" ref="productChatFrame" class="product-chat" src="./chat/platform.html" title="GrayCode 对话和设置" @load="watchChatReady" @error="chatLoadFailed = true"></iframe>
      <div v-if="!state.chatFocused && !state.settingsOpen" class="split-handle" role="separator" aria-label="调整对话与侧边面板宽度" aria-orientation="vertical" :aria-valuemin="25" :aria-valuemax="75" :aria-valuenow="Math.round(split)" tabindex="0" @pointerdown.prevent="dragSplit" @pointermove="moveSplit" @pointerup="endSplit" @pointercancel="endSplit" @lostpointercapture="endSplit" @keydown.left.prevent="split = Math.max(25, split - 2); endSplit()" @keydown.right.prevent="split = Math.min(75, split + 2); endSplit()"></div>
      <Workbench v-show="!state.chatFocused && !state.settingsOpen" :compact="compactViewport" />
    </div>
    </div>
    <footer class="statusbar"><span>{{ state.snapshot?.settings.workspaces.find(workspace => workspace.id === state.workspaceId)?.directory ?? '直接输入消息开始对话' }}</span><span class="statusbar-right">{{ isWeb ? (webUi.connection === 'connected' ? 'Web · 已连接' : 'Web · 正在重新连接…') : 'GrayCode · 桌面' }}</span></footer>
  </div>
</template>
<style>
.loading-state.startup-error{flex-direction:column;gap:12px;padding:24px;text-align:center}.startup-error p{max-width:640px;overflow-wrap:anywhere;color:var(--muted);margin:0}
.mode-navigation{display:flex;gap:2px;-webkit-app-region:no-drag}.mode-navigation button{border:0;border-radius:0;background:transparent;color:var(--muted);padding:7px 12px;cursor:pointer}.mode-navigation button[aria-pressed="true"]{color:var(--text);box-shadow:inset 0 -2px var(--accent);background:var(--surface)}.desktop-workspace.chat-focused .product-chat{border-right:0}
.desktop-workspace { display: grid; grid-template-columns: minmax(300px, var(--chat-width, 48%)) 5px minmax(0, 1fr); flex: 1; min-height: 0; grid-template-rows: minmax(0, 1fr); overflow: hidden; }
.application-body { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; position: relative; }
.application-body .desktop-workspace { min-width: 0; }
.conversation-navigation{display:flex;min-height:0;flex-shrink:0;position:relative}
.navigation-resize{position:absolute;right:-3px;top:0;bottom:0;width:7px;z-index:3;cursor:col-resize;touch-action:none;outline:none}
.navigation-resize:hover::after,.navigation-resize:focus-visible::after,.resizing .navigation-resize::after{content:'';position:absolute;inset:0 2px;background:var(--accent,#91a4be)}
.conversation-navigation[inert]{opacity:.55}
.sidebar-toggle { display: flex; align-items: center; justify-content: center; background: transparent; border: 0; padding: 7px; flex-shrink: 0; }
.desktop-workspace.chat-focused { grid-template-columns: minmax(0, 1fr); }
.product-chat { width: 100%; height: 100%; min-height: 0; border: 0; border-right: 1px solid var(--border); }
.split-handle { cursor: col-resize; touch-action: none; background: var(--border); }
.split-handle:hover, .split-handle:focus-visible { background: var(--accent, #91a4be); }
.resizing { user-select: none; cursor: col-resize; }.resizing iframe { pointer-events: none; }
.application > .titlebar { -webkit-app-region: drag; justify-content: flex-start; padding-right: 148px; height: 40px; min-height: 40px; padding-block: 0; box-sizing: border-box; }
.titlebar button,.titlebar select { -webkit-app-region: no-drag; }
.app-menu { display: flex; gap: 1px; }.app-menu button { background: transparent; border: 0; color: var(--text); padding: 7px 8px; font: inherit; cursor: pointer; }
.app-menu button:hover { background: var(--surface-hover, #ffffff10); }
.workspace-add { font-size: 21px; padding: 2px 8px; }
.application.web-host > .titlebar { padding-right: 14px; -webkit-app-region: no-drag; }
.application.web-host{height:100dvh}.application.compact-host{height:var(--viewport-height,100dvh)}
.compact-host .titlebar{flex-wrap:wrap;height:auto;min-height:44px;gap:4px;padding:4px 8px}.compact-host .titlebar button{min-height:38px;padding:7px 9px}.compact-host .mode-trigger{gap:6px}.compact-host .titlebar-center{order:2;flex:1 0 100%;min-width:0;gap:8px}.compact-host .titlebar select{max-width:none;flex:1}.compact-host .desktop-workspace{grid-template-columns:minmax(0,1fr)}.compact-host .split-handle,.mobile-workbench>.product-chat{display:none}.compact-host .product-chat{border-right:0}.compact-host .statusbar{font-size:10px;padding-inline:8px;gap:10px}.compact-host .statusbar>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.compact-host .statusbar-right{white-space:nowrap}.compact-host .conversation-sidebar{position:absolute;inset:0 auto 0 0;width:min(290px,86%);z-index:21}.navigation-backdrop{position:absolute;inset:0;border:0;background:#0009;z-index:20;padding:0}.navigation-backdrop:hover{background:#0009}
</style>

<style>
.compact-host .conversation-navigation{position:absolute;inset:0 auto 0 0;width:min(290px,86%);z-index:21}.compact-host .conversation-sidebar{position:static;width:100%;flex-basis:auto}.mobile-tools{position:relative}.mobile-tools summary{cursor:pointer;padding:10px 8px;font-size:13px;list-style:none}.mobile-tools summary::-webkit-details-marker{display:none}.mobile-tools>div{position:absolute;top:100%;right:0;min-width:160px;display:grid;background:var(--panel);border:1px solid var(--border);z-index:10001;padding:5px}.mobile-tools button{text-align:left;border:0;background:transparent}.compact-host .mode-trigger strong{font-size:16px}
</style>

<style>
.mode-switcher{position:relative;-webkit-app-region:no-drag;flex-shrink:0}.mode-trigger{display:flex;align-items:center;gap:10px;border:0;background:transparent;min-height:38px;padding:6px 12px}.mode-trigger strong{font-size:17px}.mode-trigger>span{color:var(--muted);font-size:13px}.mode-menu{position:absolute;top:calc(100% + 7px);left:0;width:270px;padding:6px;background:var(--panel);border:1px solid var(--border);box-shadow:0 10px 30px #0006;z-index:10000}.mode-menu button{display:flex;align-items:center;justify-content:space-between;width:100%;padding:12px;text-align:left;border:0;background:transparent}.mode-menu button[aria-checked=true]{background:var(--hover)}.mode-menu strong,.mode-menu small{display:block}.mode-menu small{color:var(--muted);font-size:12px;margin-top:5px}.titlebar-center{min-width:0}.application{overflow:hidden}.product-chat{min-width:0;display:block}.statusbar{flex-shrink:0}.titlebar{flex-shrink:0}
</style>

<style>.titlebar>.panel-toggle{margin-left:auto}.desktop-workspace.workbench-expanded{grid-template-columns:minmax(0,1fr)}.desktop-workspace.workbench-expanded>.product-chat,.desktop-workspace.workbench-expanded>.split-handle{display:none}.desktop-workspace.workbench-expanded>.workbench{grid-column:1}</style>

<style>
.compact-host:not(.web-host)>.titlebar{padding-right:148px}.compact-host .titlebar button,.compact-host .titlebar summary{white-space:nowrap;flex-shrink:0}
</style>
