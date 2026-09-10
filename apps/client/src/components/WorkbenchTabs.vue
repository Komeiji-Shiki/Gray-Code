<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import NavigationIcon from './navigation/NavigationIcon.vue';
import { workbenchPanels, type WorkbenchTab } from './workbenchPanels';
const props = defineProps<{ tabs: WorkbenchTab[]; active: string; treeVisible: boolean; editor: boolean; expanded: boolean; compact: boolean }>();
const emit = defineEmits<{ select: [id: string]; close: [id: string]; add: [id: string]; tree: []; expand: []; hide: []; menu: [open: boolean] }>();
const root = ref<HTMLElement>(); const addButton = ref<HTMLButtonElement>(); const menu = ref<HTMLElement>();
const menuOpen = ref(false); const menuLeft = ref(8);
watch(menuOpen, value => emit('menu', value));
async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (!menuOpen.value) return;
  menuLeft.value = Math.max(8, Math.min((addButton.value?.getBoundingClientRect().left ?? 0) - (root.value?.getBoundingClientRect().left ?? 0), (root.value?.clientWidth ?? 280) - 270));
  await nextTick(); menu.value?.querySelector<HTMLButtonElement>('button')?.focus();
}
function choose(id: string) { menuOpen.value = false; emit('add', id); }
function dismiss(event: PointerEvent) { if (event.target instanceof Node && !root.value?.contains(event.target)) menuOpen.value = false; }
function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); menuOpen.value = false; addButton.value?.focus(); return; }
  const buttons = [...menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? []];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
  if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
}
async function tabKey(event: KeyboardEvent, index: number) {
  const next = event.key === 'ArrowRight' ? (index + 1) % props.tabs.length : event.key === 'ArrowLeft' ? (index + props.tabs.length - 1) % props.tabs.length : -1;
  if (next < 0) return; event.preventDefault(); emit('select', props.tabs[next].id);
  await nextTick(); root.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}
onMounted(() => window.addEventListener('pointerdown', dismiss));
onUnmounted(() => { window.removeEventListener('pointerdown', dismiss); emit('menu', false); });
</script>
<template>
  <header ref="root" class="workbench-tabbar">
    <div class="workbench-tabstrip" role="tablist" aria-label="已打开的侧边面板">
      <div v-for="(tab, index) in tabs" :key="tab.id" class="workbench-tab" :class="{ selected: active === tab.id }">
        <button class="tab-activate" role="tab" :aria-selected="active === tab.id" :tabindex="active === tab.id ? 0 : -1" :title="tab.title || tab.label" @click="menuOpen = false; emit('select', tab.id)" @keydown="tabKey($event, index)">
          <NavigationIcon :name="tab.icon" /><span>{{ tab.label }}</span><span v-if="tab.dirty" class="unsaved-dot" aria-label="未保存"></span>
        </button>
        <button class="tab-dismiss" :aria-label="'关闭 ' + tab.label" :title="'关闭 ' + tab.label" @click="menuOpen = false; emit('close', tab.id)"><NavigationIcon name="close" /></button>
      </div>
    </div>
    <button ref="addButton" class="panel-icon add-panel" title="添加面板" aria-label="添加面板" aria-haspopup="menu" :aria-expanded="menuOpen" @click="toggleMenu"><NavigationIcon name="plus" /></button>
    <div class="panel-window-actions">
      <button v-if="editor" class="panel-icon" :class="{ pressed: treeVisible }" :aria-pressed="treeVisible" :title="treeVisible ? '隐藏文件列表' : '显示文件列表'" @click="emit('tree')"><NavigationIcon name="folder" /></button>
      <button v-if="!compact" class="panel-icon" :title="expanded ? '恢复面板宽度' : '展开面板'" @click="emit('expand')"><NavigationIcon :name="expanded ? 'restore' : 'expand'" /></button>
      <button class="panel-icon" :title="compact ? '返回对话' : '关闭侧边面板'" @click="menuOpen = false; emit('hide')"><NavigationIcon name="panel" /></button>
    </div>
    <div v-if="menuOpen" ref="menu" class="workbench-add-menu" role="menu" aria-label="添加侧边面板" :style="{ left: menuLeft + 'px' }" @keydown="menuKey">
      <button v-for="item in workbenchPanels" :key="item.id" role="menuitem" @click="choose(item.id)"><NavigationIcon :name="item.icon" /><span>{{ item.label }}</span><small>{{ item.description }}</small></button>
    </div>
  </header>
</template>
<style scoped>
.workbench-tabbar{position:relative;display:flex;align-items:center;gap:4px;min-width:0;padding:5px 8px;background:var(--surface,#101217);border-bottom:1px solid var(--border);z-index:25}.workbench-tabstrip{display:flex;align-items:center;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:none}.workbench-tabstrip::-webkit-scrollbar{display:none}.workbench-tab{display:flex;align-items:center;flex-shrink:0;max-width:220px;height:34px;border:1px solid transparent;border-bottom-color:transparent;color:var(--muted)}.workbench-tab.selected{background:var(--panel,#191c22);border-bottom-color:var(--accent);color:var(--text)}.workbench-tab:hover{background:var(--hover,#ffffff08)}button{font:inherit;color:inherit;border:0;border-radius:0;background:transparent;cursor:pointer}.tab-activate{display:flex;align-items:center;gap:9px;min-width:0;max-width:190px;height:32px;padding:0 8px 0 10px;text-align:left}.tab-activate>span:not(.unsaved-dot){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.tab-activate svg{width:15px;height:15px;flex-shrink:0}.tab-dismiss{display:grid;place-items:center;width:27px;height:28px;padding:5px;margin-right:2px;color:var(--muted);opacity:.6}.tab-dismiss:hover{color:var(--text);opacity:1}.tab-dismiss svg{width:12px;height:12px}.unsaved-dot{width:5px;height:5px;background:var(--accent);flex-shrink:0}.panel-icon{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;padding:6px;color:var(--muted)}.panel-icon:hover,.panel-icon.pressed{background:var(--hover,#ffffff08);color:var(--text)}.panel-icon svg{width:16px;height:16px}.panel-window-actions{display:flex;align-items:center;margin-left:auto;gap:2px;padding-left:8px}.add-panel{margin-left:2px}.workbench-add-menu{position:absolute;top:calc(100% + 5px);width:260px;padding:6px;border:1px solid var(--border);background:var(--panel,#1b1e24);box-shadow:0 12px 30px #0006;z-index:30}.workbench-add-menu button{display:grid;grid-template-columns:18px minmax(48px,1fr) auto;align-items:center;gap:10px;width:100%;padding:11px 10px;text-align:left;font-size:13px}.workbench-add-menu button:hover,.workbench-add-menu button:focus-visible{background:var(--hover,#ffffff0c);outline:0}.workbench-add-menu svg{color:var(--muted);width:16px;height:16px}.workbench-add-menu small{color:var(--muted);font-size:10px}button:focus-visible{outline:1px solid var(--accent);outline-offset:-2px}@media(max-width:600px){.workbench-tabbar{padding-inline:4px}.workbench-tab{max-width:190px}.panel-window-actions{padding-left:2px}.workbench-add-menu{width:min(260px,calc(100vw - 24px))}}
</style>
