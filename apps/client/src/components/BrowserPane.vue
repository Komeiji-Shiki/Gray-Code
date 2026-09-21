<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import type { BrowserState, BrowserTab, BrowserControlAction } from '@graycode/contracts';
import { rpc as call, subscribe } from '../api';
import { state, guard } from '../state';
const props = defineProps<{ active: boolean }>();
const viewport = ref<HTMLElement>(); const address = ref(''); const loaded = ref('about:blank');
const browser = ref<BrowserState>({ profiles: [], tabs: [] });
const selectedProfile = ref(''); const profileName = ref(''); const editingProfile = ref<'create' | 'rename' | null>(null);
const activeTab = computed(() => browser.value.tabs.find(tab => tab.id === browser.value.activeTabId));
const isWeb = window.graycode?.kind === 'web';
let observer: ResizeObserver | undefined; let frame = 0; let last = ''; let refreshPromise: Promise<void> | undefined; let refreshAgain = false;
function layout() {
  cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
    if (isWeb || !viewport.value) return;
    const rect = viewport.value.getBoundingClientRect();
    const input = { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      visible: props.active && !!activeTab.value && !state.chatFocused && !state.settingsOpen && !state.panelResizing && !state.panelObscured && !state.contentPreviewOpen && !state.inspectorOpen };
    const serialized = JSON.stringify(input); if (serialized === last) return; last = serialized;
    void call('browser.layout', input).catch(() => {});
  });
}
async function refresh(): Promise<void> {
  if (isWeb) return;
  if (refreshPromise) { refreshAgain = true; return refreshPromise; }
  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      const result = await call('browser.state');
      browser.value = result;
      if (!selectedProfile.value || !result.profiles.some(profile => profile.id === selectedProfile.value)) selectedProfile.value = result.profiles[0]?.id ?? '';
      const current = result.tabs.find(tab => tab.id === result.activeTabId);
      const url = current?.url || 'about:blank';
      if (loaded.value !== url) { address.value = url === 'about:blank' ? '' : url; loaded.value = url; }
      await nextTick(layout);
    } while (refreshAgain);
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}
async function navigate() {
  const text = address.value.trim(); if (!text) return;
  const url = /^(https?:\/\/|graycode-preview:\/\/|about:blank)/i.test(text) ? text : `https://${text}`;
  await call('browser.open', { url, tabId: activeTab.value?.id });
  if (isWeb) { loaded.value = url; layout(); } else await refresh();
}
async function control(action: BrowserControlAction) { await call('browser.control', { action, tabId: activeTab.value?.id }); await refresh(); }
async function createTab() { await call('browser.newTab', { profileId: selectedProfile.value || undefined }); await refresh(); address.value = ''; }
async function selectTab(tab: BrowserTab) { await call('browser.select', { tabId: tab.id }); await refresh(); address.value = tab.url === 'about:blank' ? '' : tab.url; }
async function closeTab(tab: BrowserTab) { await call('browser.closeTab', { tabId: tab.id }); await refresh(); }
async function saveProfile() {
  if (editingProfile.value === 'rename') await call('browser.profile.rename', { id: selectedProfile.value, name: profileName.value });
  else { const profile = await call('browser.profile.create', { name: profileName.value }); selectedProfile.value = profile.id; }
  editingProfile.value = null; profileName.value = ''; await refresh();
}
function editProfile(mode: 'create' | 'rename') {
  editingProfile.value = mode;
  profileName.value = mode === 'rename' ? browser.value.profiles.find(profile => profile.id === selectedProfile.value)?.name ?? '' : '';
  void nextTick(layout);
}
const unsubscribe = subscribe(event => {
  if (event.type === 'browser.changed' || event.type === 'browser.opened') {
    if (isWeb && event.url) { address.value = event.url; loaded.value = event.url; }
    else void guard(refresh);
  }
});
watch(() => [props.active, state.chatFocused, state.settingsOpen, state.panelResizing, state.panelObscured, state.contentPreviewOpen, state.inspectorOpen, editingProfile.value], () => { void nextTick(layout); });
onMounted(() => {
  observer = new ResizeObserver(layout); if (viewport.value) observer.observe(viewport.value);
  window.addEventListener('resize', layout); void guard(refresh); layout();
});
onUnmounted(() => {
  observer?.disconnect(); unsubscribe(); cancelAnimationFrame(frame); window.removeEventListener('resize', layout);
  if (!isWeb) void call('browser.layout', { x: 0, y: 0, width: 0, height: 0, visible: false });
});
</script>
<template>
  <section class="browser-pane">
    <div v-if="!isWeb" class="browser-tabs" role="tablist" aria-label="网页标签">
      <div v-for="tab in browser.tabs" :key="tab.id" class="browser-tab" :class="{ active: tab.id === browser.activeTabId }">
        <button role="tab" :aria-selected="tab.id === browser.activeTabId" :title="tab.url" @click="guard(() => selectTab(tab))"><span v-if="tab.loading">◌</span><span v-else-if="tab.controlledBy" class="controlled-mark">◆</span>{{ tab.title || '新标签' }}</button>
        <button class="close-tab" :aria-label="`关闭网页 ${tab.title || '新标签'}`" @click="guard(() => closeTab(tab))">×</button>
      </div>
      <button class="new-tab" title="新建网页标签" aria-label="新建网页标签" @click="guard(createTab)">＋</button>
    </div>
    <form class="browser-toolbar" @submit.prevent="guard(navigate)">
      <button type="button" title="后退" :disabled="isWeb || !activeTab?.canGoBack" @click="guard(() => control('back'))">←</button>
      <button type="button" title="前进" :disabled="isWeb || !activeTab?.canGoForward" @click="guard(() => control('forward'))">→</button>
      <button type="button" :title="activeTab?.loading ? '停止加载' : '刷新'" :disabled="isWeb || !activeTab" @click="guard(() => control(activeTab?.loading ? 'stop' : 'reload'))">{{ activeTab?.loading ? '×' : '↻' }}</button>
      <input v-model="address" aria-label="网页地址" placeholder="输入网址，按回车打开" /><button type="submit">打开</button>
      <button v-if="!isWeb" type="button" title="开发者工具" :disabled="!activeTab" @click="guard(() => control('devtools'))">&lt;/&gt;</button>
    </form>
    <div v-if="!isWeb" class="browser-context">
      <select v-model="selectedProfile" aria-label="新标签的登录配置" title="为新标签选择独立的登录配置">
        <option v-for="profile in browser.profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
      </select>
      <button title="新建登录配置" @click="editProfile('create')">新配置</button><button title="重命名登录配置" @click="editProfile('rename')">重命名</button>
      <span class="profile-current">{{ browser.profiles.find(profile => profile.id === activeTab?.profileId)?.name }}</span>
      <button v-if="activeTab?.controlledBy" class="takeover" @click="guard(async () => { await call('browser.takeover', { tabId: activeTab!.id }); await refresh(); })">模型正在操作 · 接管</button>
      <button v-else-if="activeTab?.userControlled" @click="guard(async () => { await call('browser.allowAutomation', { tabId: activeTab!.id }); await refresh(); })">已接管 · 允许模型操作</button>
    </div>
    <form v-if="editingProfile" class="profile-editor" @submit.prevent="guard(saveProfile)">
      <input v-model="profileName" maxlength="100" aria-label="登录配置名称" placeholder="登录配置名称" /><button type="submit">保存</button><button type="button" @click="editingProfile = null">取消</button>
    </form>
    <div v-if="activeTab?.error" class="browser-error" role="alert">{{ activeTab.error }}</div>
    <div ref="viewport" class="browser-viewport">
      <iframe v-if="isWeb && loaded !== 'about:blank'" :src="loaded" sandbox="allow-scripts allow-forms allow-popups" title="网页预览"></iframe>
      <p v-if="loaded === 'about:blank'">在上方输入网址，或从文件列表打开 HTML。</p>
    </div>
  </section>
</template>
<style scoped>
.browser-pane{height:100%;display:flex;flex-direction:column;min-height:0;min-width:0}.browser-tabs{display:flex;align-items:stretch;overflow:auto;min-height:34px;border-bottom:1px solid var(--border);flex-shrink:0}.browser-tab{display:flex;max-width:210px;min-width:110px;border-right:1px solid var(--border);border-top:2px solid transparent;background:var(--surface)}.browser-tab.active{border-top-color:var(--accent);background:var(--background)}.browser-tab>button{border:0;border-radius:0;background:transparent;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:7px 9px;font-size:12px}.browser-tab>button:first-child{flex:1;text-align:left}.browser-tab .close-tab{flex-shrink:0;padding:5px 8px;color:var(--muted)}.new-tab{border:0;border-radius:0;min-width:34px}.controlled-mark{color:var(--accent);margin-right:6px}.browser-toolbar{display:flex;gap:4px;align-items:center;padding:7px;border-bottom:1px solid var(--border);flex-shrink:0}.browser-toolbar input{flex:1;min-width:0}.browser-toolbar button{padding:6px 8px}.browser-context{display:flex;align-items:center;gap:5px;padding:5px 8px;border-bottom:1px solid var(--border);min-height:34px;flex-wrap:wrap}.browser-context select{max-width:180px;min-width:80px;font-size:11px;padding:4px}.browser-context button{font-size:11px;padding:4px 7px}.profile-current{flex:1;color:var(--muted);font-size:11px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.takeover{color:var(--accent);border-color:var(--accent)}.profile-editor{display:flex;padding:7px;gap:5px;border-bottom:1px solid var(--border)}.profile-editor input{flex:1;min-width:0}.browser-error{padding:8px 12px;color:var(--error);font-size:12px;border-bottom:1px solid var(--border)}.browser-viewport{flex:1;min-height:0;position:relative;background:var(--background)}iframe{border:0;width:100%;height:100%}p{padding:25px;color:var(--muted)}
</style>
