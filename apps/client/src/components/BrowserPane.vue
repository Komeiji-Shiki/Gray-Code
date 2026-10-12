<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import type { BrowserState, BrowserTab, BrowserControlAction } from '@graycode/contracts';
import { rpc as call, subscribe } from '../api';
import { state, guard } from '../state';
const props = defineProps<{ active: boolean }>();
const viewport = ref<HTMLElement>();
const address = ref('');
const loaded = ref('about:blank');
const browser = ref<BrowserState>({ profiles: [], tabs: [] });
const selectedProfile = ref('');
const profileName = ref('');
const editingProfile = ref<'create' | 'rename' | null>(null);
const activeTab = computed(() => browser.value.tabs.find((tab) => tab.id === browser.value.activeTabId));
const isWeb = window.graycode?.kind === 'web';
let observer: ResizeObserver | undefined;
let frame = 0;
let last = '';
let refreshPromise: Promise<void> | undefined;
let refreshAgain = false;
let disposed = false;
let loadedTabId: string | undefined;
function layout() {
  if (disposed) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (disposed || isWeb || !viewport.value) return;
    const rect = viewport.value.getBoundingClientRect();
    const input = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visible:
        props.active &&
        !!activeTab.value &&
        !state.chatFocused &&
        !state.settingsOpen &&
        !state.panelResizing &&
        !state.panelObscured &&
        !state.contentPreviewOpen &&
        !state.inspectorOpen,
    };
    const serialized = JSON.stringify(input);
    if (serialized === last) return;
    last = serialized;
    void call('browser.layout', input).catch(() => {
      if (last === serialized) last = '';
    });
  });
}
async function refresh(): Promise<void> {
  if (disposed || isWeb) return;
  if (refreshPromise) {
    refreshAgain = true;
    return refreshPromise;
  }
  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      const result = await call('browser.state').catch((error) => {
        if (!disposed) throw error;
      });
      if (disposed || !result) return;
      browser.value = result;
      if (!selectedProfile.value || !result.profiles.some((profile) => profile.id === selectedProfile.value))
        selectedProfile.value = result.profiles[0]?.id ?? '';
      const current = result.tabs.find((tab) => tab.id === result.activeTabId);
      const url = current?.url || 'about:blank';
      if (loaded.value !== url || loadedTabId !== current?.id) {
        address.value = url === 'about:blank' ? '' : url;
        loaded.value = url;
        loadedTabId = current?.id;
      }
      await nextTick(layout);
    } while (refreshAgain && !disposed);
  })().finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}
async function navigate() {
  const text = address.value.trim();
  if (!text) return;
  const url = /^(https?:\/\/|graycode-preview:\/\/|about:blank)/i.test(text) ? text : `https://${text}`;
  await call('browser.open', { url, tabId: activeTab.value?.id });
  if (isWeb) {
    loaded.value = url;
    layout();
  } else await refresh();
}
async function control(action: BrowserControlAction) {
  await call('browser.control', { action, tabId: activeTab.value?.id });
  await refresh();
}
async function createTab() {
  await call('browser.newTab', { profileId: selectedProfile.value || undefined });
  await refresh();
}
async function selectTab(tab: BrowserTab) {
  await call('browser.select', { tabId: tab.id });
  await refresh();
}
async function closeTab(tab: BrowserTab) {
  await call('browser.closeTab', { tabId: tab.id });
  await refresh();
}
async function saveProfile() {
  if (editingProfile.value === 'rename') await call('browser.profile.rename', { id: selectedProfile.value, name: profileName.value });
  else {
    const profile = await call('browser.profile.create', { name: profileName.value });
    selectedProfile.value = profile.id;
  }
  editingProfile.value = null;
  profileName.value = '';
  await refresh();
}
function editProfile(mode: 'create' | 'rename') {
  editingProfile.value = mode;
  profileName.value = mode === 'rename' ? (browser.value.profiles.find((profile) => profile.id === selectedProfile.value)?.name ?? '') : '';
  void nextTick(layout);
}
const unsubscribe = subscribe((event) => {
  if (event.type === 'browser.changed' || event.type === 'browser.opened') {
    if (isWeb && event.url) {
      address.value = event.url;
      loaded.value = event.url;
    } else void guard(refresh);
  }
});
watch(
  () => [
    props.active,
    state.chatFocused,
    state.settingsOpen,
    state.panelResizing,
    state.panelObscured,
    state.contentPreviewOpen,
    state.inspectorOpen,
    editingProfile.value,
  ],
  () => {
    void nextTick(layout);
  },
);
onMounted(() => {
  observer = new ResizeObserver(layout);
  if (viewport.value) observer.observe(viewport.value);
  window.addEventListener('resize', layout);
  void guard(refresh);
  layout();
});
onUnmounted(() => {
  disposed = true;
  refreshAgain = false;
  observer?.disconnect();
  unsubscribe();
  cancelAnimationFrame(frame);
  window.removeEventListener('resize', layout);
  if (!isWeb) void call('browser.layout', { x: 0, y: 0, width: 0, height: 0, visible: false }).catch(() => {});
});
</script>
<template>
  <section class="browser-pane">
    <div v-if="!isWeb" class="browser-tabs" role="tablist" :aria-label="t('uiBrowserPaneBrowserTabs')">
      <div v-for="tab in browser.tabs" :key="tab.id" class="browser-tab" :class="{ active: tab.id === browser.activeTabId }">
        <button role="tab" :aria-selected="tab.id === browser.activeTabId" :title="tab.url" @click="guard(() => selectTab(tab))">
          <span v-if="tab.loading">◌</span>
          <span v-else-if="tab.controlledBy" class="controlled-mark">◆</span>
          {{ tab.title || t('uiBrowserPaneNewTab') }}
        </button>
        <button
          class="close-tab"
          :aria-label="t('uiBrowserPaneClosePage', { value1: tab.title || t('uiBrowserPaneNewTab') })"
          @click="guard(() => closeTab(tab))"
        >
          ×
        </button>
      </div>
      <button class="new-tab" :title="t('uiBrowserPaneCreateTab')" :aria-label="t('uiBrowserPaneCreateTab')" @click="guard(createTab)">＋</button>
    </div>
    <form class="browser-toolbar" @submit.prevent="guard(navigate)">
      <button type="button" :title="t('uiBrowserPaneBack')" :disabled="isWeb || !activeTab?.canGoBack" @click="guard(() => control('back'))">←</button>
      <button type="button" :title="t('uiBrowserPaneForward')" :disabled="isWeb || !activeTab?.canGoForward" @click="guard(() => control('forward'))">→</button>
      <button
        type="button"
        :title="activeTab?.loading ? t('uiBrowserPaneStopLoading') : t('uiBrowserPaneRefresh')"
        :disabled="isWeb || !activeTab"
        @click="guard(() => control(activeTab?.loading ? 'stop' : 'reload'))"
      >
        {{ activeTab?.loading ? '×' : '↻' }}
      </button>
      <input v-model="address" :aria-label="t('uiBrowserPaneURL')" :placeholder="t('uiBrowserPaneUrlPlaceholder')" />
      <button type="submit">{{ t('uiBrowserPaneOpen') }}</button>
      <button v-if="!isWeb" type="button" :title="t('uiBrowserPaneDeveloperTools')" :disabled="!activeTab" @click="guard(() => control('devtools'))">
        &lt;/&gt;
      </button>
    </form>
    <div v-if="!isWeb" class="browser-context">
      <select v-model="selectedProfile" :aria-label="t('uiBrowserPaneNewTabProfile')" :title="t('uiBrowserPaneChooseNewTabProfile')">
        <option v-for="profile in browser.profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
      </select>
      <button :title="t('uiBrowserPaneCreateProfile')" @click="editProfile('create')">{{ t('uiBrowserPaneNewProfile') }}</button>
      <button :title="t('uiBrowserPaneRenameProfile')" @click="editProfile('rename')">{{ t('uiBrowserPaneRename') }}</button>
      <span class="profile-current">{{ browser.profiles.find((profile) => profile.id === activeTab?.profileId)?.name }}</span>
      <button
        v-if="activeTab?.controlledBy"
        class="takeover"
        @click="
          guard(async () => {
            await call('browser.takeover', { tabId: activeTab!.id });
            await refresh();
          })
        "
      >
        {{ t('uiBrowserPaneTakeControl') }}
      </button>
      <button
        v-else-if="activeTab?.userControlled"
        @click="
          guard(async () => {
            await call('browser.allowAutomation', { tabId: activeTab!.id });
            await refresh();
          })
        "
      >
        {{ t('uiBrowserPaneAllowModelControl') }}
      </button>
    </div>
    <form v-if="editingProfile" class="profile-editor" @submit.prevent="guard(saveProfile)">
      <input v-model="profileName" maxlength="100" :aria-label="t('uiBrowserPaneProfileName')" :placeholder="t('uiBrowserPaneProfileName')" />
      <button type="submit">{{ t('uiBrowserPaneSave') }}</button>
      <button type="button" @click="editingProfile = null">{{ t('uiBrowserPaneCancel') }}</button>
    </form>
    <div v-if="activeTab?.error" class="browser-error" role="alert">{{ activeTab.error }}</div>
    <div ref="viewport" class="browser-viewport">
      <iframe
        v-if="isWeb && loaded !== 'about:blank'"
        :src="loaded"
        sandbox="allow-scripts allow-forms allow-popups"
        :title="t('uiBrowserPaneWebPreview')"
      ></iframe>
      <p v-if="loaded === 'about:blank'">{{ t('uiBrowserPaneEmptyPreviewHelp') }}</p>
    </div>
  </section>
</template>
<style scoped>
.browser-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.browser-tabs {
  display: flex;
  align-items: stretch;
  overflow: auto;
  min-height: 34px;
  border-bottom: 1px solid var(--gc-border-subtle);
  flex-shrink: 0;
}
.browser-tab {
  display: flex;
  max-width: 210px;
  min-width: 110px;
  border-right: 1px solid var(--gc-border-subtle);
  border-top: 2px solid transparent;
  background: var(--gc-surface-sunken);
}
.browser-tab.active {
  border-top-color: var(--gc-accent);
  background: var(--gc-surface-base);
}
.browser-tab > button {
  border: 0;
  border-radius: var(--gc-radius-sm);
  background: transparent;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 7px 9px;
  font-size: 12px;
}
.browser-tab > button:first-child {
  flex: 1;
  text-align: left;
}
.browser-tab .close-tab {
  flex-shrink: 0;
  padding: 5px 8px;
  color: var(--gc-text-muted);
}
.new-tab {
  border: 0;
  border-radius: 0;
  min-width: 34px;
}
.controlled-mark {
  color: var(--gc-accent);
  margin-right: 6px;
}
.browser-toolbar {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 7px;
  border-bottom: 1px solid var(--gc-border-subtle);
  flex-shrink: 0;
}
.browser-toolbar input {
  flex: 1;
  min-width: 0;
}
.browser-toolbar button {
  padding: 6px 8px;
}
.browser-context {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--gc-border-subtle);
  min-height: 34px;
  flex-wrap: wrap;
}
.browser-context select {
  max-width: 180px;
  min-width: 80px;
  font-size: 11px;
  padding: 4px;
}
.browser-context button {
  font-size: 11px;
  padding: 4px 7px;
}
.profile-current {
  flex: 1;
  color: var(--gc-text-muted);
  font-size: 11px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.takeover {
  color: var(--gc-accent);
  border-color: var(--gc-accent);
}
.profile-editor {
  display: flex;
  padding: 7px;
  gap: 5px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.profile-editor input {
  flex: 1;
  min-width: 0;
}
.browser-error {
  padding: 8px 12px;
  color: var(--gc-danger);
  font-size: 12px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.browser-viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--gc-surface-base);
}
iframe {
  border: 0;
  width: 100%;
  height: 100%;
}
p {
  padding: 25px;
  color: var(--gc-text-muted);
}
</style>
