<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { WorkspaceDefinition } from '@graycode/contracts';
const props = defineProps<{ modelValue: string; workspaces: readonly WorkspaceDefinition[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; browse: [] }>();
const open = ref(false); const container = ref<HTMLElement>(); const trigger = ref<HTMLButtonElement>();
const selected = computed(() => props.workspaces.find(workspace => workspace.id === props.modelValue));
const selectedOptionId = computed(() => selected.value?.managedConversationId ? '' : props.modelValue);
const options = computed(() => [{ id: '', name: '自动创建工作区', directory: '新对话在 Documents/graycode 下使用独立文件夹' }, ...props.workspaces.filter(workspace => !workspace.managedConversationId)]);
async function show() {
  open.value = true; await nextTick();
  const index = Math.max(0, options.value.findIndex(option => option.id === selectedOptionId.value));
  container.value?.querySelectorAll<HTMLButtonElement>('[role=option]')[index]?.focus();
}
function close() { open.value = false; }
function choose(value: string) { emit('update:modelValue', value); close(); trigger.value?.focus(); }
function move(event: KeyboardEvent) {
  const buttons = [...(container.value?.querySelectorAll<HTMLButtonElement>('[role=option]') ?? [])];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
function outside(event: PointerEvent) { if (!container.value?.contains(event.target as Node)) close(); }
onMounted(() => { window.addEventListener('pointerdown', outside); window.addEventListener('blur', close); });
onUnmounted(() => { window.removeEventListener('pointerdown', outside); window.removeEventListener('blur', close); });
</script>

<template>
  <div ref="container" class="workspace-picker" @keydown.esc.stop.prevent="close(); trigger?.focus()" @focusout="event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) close(); }">
    <button ref="trigger" class="workspace-trigger" aria-label="当前工作区" aria-haspopup="listbox" :aria-expanded="open" :title="selected?.directory" @click="open ? close() : show()" @keydown.down.prevent="show" @keydown.up.prevent="show"><span>{{ selected?.managedConversationId ? '自动工作区' : selected?.name || '自动创建工作区' }}</span><span class="workspace-caret">⌄</span></button>
    <div v-if="open" class="workspace-options" @keydown.down.prevent="move" @keydown.up.prevent="move" @keydown.home.prevent="move" @keydown.end.prevent="move">
      <div role="listbox" aria-label="选择工作区">
      <button v-for="option in options" :key="option.id" role="option" :aria-selected="option.id === selectedOptionId" :title="option.directory" @click="choose(option.id)"><span class="workspace-option-content"><strong>{{ option.name }}</strong><small>{{ option.directory }}</small></span><span v-if="option.id === selectedOptionId" class="workspace-check">✓</span></button>
      </div>
      <button class="workspace-browse" @click="close(); emit('browse')">＋ 选择文件夹添加工作区…</button>
    </div>
  </div>
</template>

<style scoped>
.workspace-picker{position:relative;min-width:0;width:clamp(130px,19vw,260px);-webkit-app-region:no-drag}.workspace-trigger{width:100%;display:flex;align-items:center;gap:14px;padding:7px 10px;background:var(--input);color:var(--text);text-align:left;min-height:32px}.workspace-trigger>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.workspace-caret{color:var(--muted);font-size:12px}
.workspace-options{position:absolute;top:calc(100% + 5px);left:0;width:max(100%,320px);max-width:calc(100vw - 32px);max-height:min(420px,70vh);overflow:auto;padding:4px;background:var(--panel);color:var(--text);border:1px solid var(--border);box-shadow:0 8px 22px #0006;z-index:10000}.workspace-options button{display:flex;align-items:center;width:100%;gap:16px;padding:9px 11px;text-align:left;background:transparent;border:0;min-width:0;color:var(--text)}.workspace-options button:hover,.workspace-options button:focus-visible{background:var(--hover)}.workspace-options button[aria-selected=true]{background:color-mix(in srgb,var(--accent) 18%,var(--panel))}.workspace-option-content{flex:1;min-width:0}.workspace-option-content strong{display:block;font-size:13px;font-weight:500}.workspace-option-content small{display:block;margin-top:4px;font-size:11px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}.workspace-check{color:var(--accent);flex-shrink:0}
:global(.compact-host) .workspace-picker{flex:1;width:auto}:global(.compact-host) .workspace-options{width:100%}
.workspace-options .workspace-browse{border-top:1px solid var(--border);margin-top:4px;color:var(--accent);font-size:12px}
</style>
