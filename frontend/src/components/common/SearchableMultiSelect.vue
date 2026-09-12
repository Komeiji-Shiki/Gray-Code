<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
const props = withDefaults(defineProps<{ modelValue: string[]; options: Array<{ value: string; label: string; description?: string; group?: string }>; label: string; placeholder?: string }>(), { placeholder: '请选择，可多选' });
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const opened = ref(false); const query = ref('');
const container = ref<HTMLElement>(); const trigger = ref<HTMLButtonElement>(); const panel = ref<HTMLElement>(); const search = ref<HTMLInputElement>();
const panelStyle = ref<Record<string, string>>({});
const values = computed(() => {
  const options = new Map(props.options.map(option => [option.value, option]));
  for (const value of props.modelValue) if (!options.has(value)) options.set(value, { value, label: value, description: '已保存的选项，当前列表中暂不可用。' });
  return [...options.values()];
});
const filtered = computed(() => values.value.filter(option => !query.value.trim() || `${option.label} ${option.group ?? ''} ${option.description ?? ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const selected = computed(() => props.modelValue.map(value => values.value.find(option => option.value === value)?.label ?? value));
const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every(option => props.modelValue.includes(option.value)));
function toggle(value: string) { emit('update:modelValue', props.modelValue.includes(value) ? props.modelValue.filter(item => item !== value) : [...props.modelValue, value]); }
function toggleFiltered() {
  const matching = new Set(filtered.value.map(option => option.value));
  emit('update:modelValue', allSelected.value ? props.modelValue.filter(value => !matching.has(value)) : [...new Set([...props.modelValue, ...matching])]);
}
function close(focus = false) { opened.value = false; if (focus) trigger.value?.focus(); }
function position() {
  if (!opened.value || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) { close(); return; }
  const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
  const below = window.innerHeight - rect.bottom - 12; const above = rect.top - 12;
  const up = below < 240 && above > below; const maximum = Math.max(100, Math.min(380, up ? above : below));
  const height = Math.min(panel.value?.scrollHeight ?? maximum, maximum);
  panelStyle.value = { width: `${width}px`, left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, up ? rect.top - height - 4 : rect.bottom + 4)}px`, maxHeight: `${maximum}px` };
}
async function show() { query.value = ''; opened.value = true; await nextTick(); position(); search.value?.focus(); }
function outside(event: PointerEvent) { if (!container.value?.contains(event.target as Node) && !panel.value?.contains(event.target as Node)) close(); }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target === search.value && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const rows = [...(panel.value?.querySelectorAll<HTMLElement>('[role=option]') ?? [])];
  const current = rows.indexOf(document.activeElement as HTMLElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[index]?.focus();
}
watch([filtered, opened], () => { if (opened.value) void nextTick(position); });
onMounted(() => { window.addEventListener('pointerdown', outside); window.addEventListener('resize', position); window.addEventListener('scroll', position, true); });
onUnmounted(() => { window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); });
</script>
<template>
  <div ref="container" class="searchable-multiselect" @change.stop>
    <button ref="trigger" class="multiselect-trigger" type="button" :aria-label="label" aria-haspopup="listbox" :aria-expanded="opened" @click="opened ? close() : show()" @keydown.down.prevent="show">
      <span class="multiselect-label" :class="{ empty: !modelValue.length }">{{ selected.slice(0, 2).join('、') || placeholder }}{{ selected.length > 2 ? '…' : '' }}</span><small>可多选 · 已选 {{ modelValue.length }} 项</small><span class="multiselect-arrow">{{ opened ? '▴' : '▾' }}</span>
    </button>
  </div>
  <Teleport to="body"><div v-if="opened" ref="panel" class="multiselect-panel" :style="panelStyle" @keydown="keydown" @change.stop>
    <div class="multiselect-search"><i class="codicon codicon-search" aria-hidden="true"></i><input ref="search" v-model="query" type="search" :aria-label="`搜索${label}`" placeholder="搜索选项" data-preference-transient /></div>
    <div class="multiselect-toolbar"><span>已选择 {{ modelValue.length }} 项</span><button type="button" :disabled="!filtered.length" @click="toggleFiltered">{{ allSelected ? '取消筛选结果' : '全选筛选结果' }}</button></div>
    <div class="multiselect-options" role="listbox" aria-multiselectable="true" :aria-label="label">
      <label v-for="option in filtered" :key="option.value" role="option" tabindex="0" :aria-selected="modelValue.includes(option.value)" :class="{ selected: modelValue.includes(option.value) }"
        @keydown.space.prevent="toggle(option.value)" @keydown.enter.prevent="toggle(option.value)">
        <input class="multiselect-check" type="checkbox" :checked="modelValue.includes(option.value)" tabindex="-1" aria-hidden="true" @change="toggle(option.value)" />
        <span class="multiselect-info"><strong>{{ option.label }}</strong><small v-if="option.group">{{ option.group }}</small><span v-if="option.description" :title="option.description">{{ option.description }}</span></span>
      </label><p v-if="!filtered.length">没有匹配的选项。</p>
    </div>
    <div class="multiselect-footer"><span>点击整行即可多选</span><button type="button" @click="close(true)">完成</button></div>
  </div></Teleport>
</template>
<style scoped>
.searchable-multiselect{min-width:0;width:100%}.multiselect-trigger{width:100%;min-width:0;display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--vscode-input-background);border:1px solid var(--gc-border-control);border-radius:0;color:var(--gc-text-primary);font:inherit;cursor:pointer;text-align:left}.multiselect-trigger[aria-expanded=true],.multiselect-trigger:focus-visible{border-color:var(--vscode-focusBorder);outline:none}.multiselect-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty,.multiselect-trigger small,.multiselect-arrow{color:var(--gc-text-muted)}.multiselect-trigger small{font-size:11px;white-space:nowrap}.multiselect-panel{position:fixed;display:flex;flex-direction:column;z-index:10050;overflow:hidden;background:var(--gc-surface-raised,var(--vscode-editor-background));border:1px solid var(--gc-border-control);box-shadow:0 8px 24px #0007;font-size:13px;color:var(--gc-text-primary)}.multiselect-search{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--gc-border-control)}.multiselect-search input{width:100%;min-width:0;padding:6px;border:0;outline:0;color:inherit;background:var(--vscode-input-background);font:inherit;border-radius:0}.multiselect-toolbar,.multiselect-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;color:var(--gc-text-muted);font-size:11px;flex-shrink:0}.multiselect-toolbar button,.multiselect-footer button{border:0;background:transparent;color:var(--vscode-textLink-foreground);padding:5px;cursor:pointer;font:inherit}.multiselect-options{min-height:0;overflow:auto;padding:4px;scrollbar-width:thin;scrollbar-color:var(--gc-border-control) transparent}.multiselect-options>label{display:flex;align-items:flex-start;gap:11px;width:100%;padding:10px;text-align:left;color:inherit;border:1px solid transparent;background:transparent;cursor:pointer;font:inherit;border-radius:0}.multiselect-options>label:hover,.multiselect-options>label:focus-visible{background:var(--vscode-list-hoverBackground);outline:none}.multiselect-options>label.selected{background:color-mix(in srgb,var(--vscode-focusBorder) 13%,transparent);border-color:color-mix(in srgb,var(--vscode-focusBorder) 45%,transparent)}.multiselect-check{appearance:auto;width:18px;height:18px;flex:0 0 18px;margin:1px 0 0;padding:0;accent-color:var(--vscode-focusBorder);cursor:pointer;color-scheme:inherit}.multiselect-info{display:grid;gap:4px;min-width:0}.multiselect-info strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}.multiselect-info small,.multiselect-info>span{font-size:11px;line-height:1.5;color:var(--gc-text-muted)}.multiselect-info>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.multiselect-options p{padding:16px;color:var(--gc-text-muted)}.multiselect-footer{border-top:1px solid var(--gc-border-control)}
</style>
