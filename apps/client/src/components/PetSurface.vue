<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PetSnapshot } from '@graycode/contracts';
import { call, subscribe } from '../api';
import PetPlayer from './PetPlayer.vue';
import PetInbox from './PetInbox.vue';
import ScreenSenseStatus from './ScreenSenseStatus.vue';
const props = defineProps<{ surface: 'app' | 'floating'; conversationId?: string }>();
const emit = defineEmits<{ manage: []; open: [id: string] }>();
const snapshot = ref<PetSnapshot>(), expanded = ref(false), error = ref('');
const visible = computed(() => snapshot.value?.configuration.visible && snapshot.value.configuration.surface === props.surface);
const dimensions = computed(() => ({ width: `${240 * (snapshot.value?.configuration.scale ?? 1)}px`, height: `${260 * (snapshot.value?.configuration.scale ?? 1)}px` }));
const position = ref<{ x: number; y: number }>();
let unsubscribe: (() => void) | undefined, sequence = 0, drag: { x: number; y: number; initialX: number; initialY: number; element: HTMLElement } | undefined;
async function refresh() { const request = ++sequence; try { const value = await call<PetSnapshot>('pets.status'); if (request === sequence) { snapshot.value = value; position.value = value.configuration.position; } } catch (cause) { error.value = (cause as Error).message; } }
async function change(values: Record<string, unknown>) { try { await call('pets.configure', { configuration: { ...snapshot.value!.configuration, ...values }, revision: snapshot.value!.revision }); await refresh(); } catch (cause) { error.value = (cause as Error).message; } }
async function toggle() { expanded.value = !expanded.value; if (props.surface === 'floating') await call('desktop.pet.expand', { expanded: expanded.value }); }
function startDrag(event: PointerEvent) {
  if (props.surface !== 'app' || (event.target as HTMLElement).closest('button')) return;
  const element = (event.currentTarget as HTMLElement).closest('.pet-surface') as HTMLElement, bounds = element.getBoundingClientRect();
  drag = { x: event.clientX, y: event.clientY, initialX: bounds.left, initialY: bounds.top, element }; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) { if (!drag) return; position.value = { x: Math.max(0, Math.min(innerWidth - drag.element.offsetWidth, drag.initialX + event.clientX - drag.x)), y: Math.max(38, Math.min(innerHeight - 50, drag.initialY + event.clientY - drag.y)) }; }
function endDrag() { if (!drag) return; drag = undefined; void call('pets.position', { position: position.value }).catch(cause => { error.value = cause.message; }); }
onMounted(() => { void refresh(); unsubscribe = subscribe(event => { if (event.type === 'pets.changed') {
  if (snapshot.value && snapshot.value.configuration.resourceId === event.configuration.resourceId) { snapshot.value = { ...snapshot.value, configuration: event.configuration, revision: event.revision, state: event.state }; if (!drag) position.value = event.configuration.position; }
  else void refresh();
} else if (event.type === 'transport.resumed') void refresh(); }); });
onBeforeUnmount(() => { unsubscribe?.(); sequence++; });
</script>
<template><section v-if="visible && snapshot?.resource" class="pet-surface" :class="{ floating: surface === 'floating', expanded }" :style="surface === 'app' && position ? { left: position.x + 'px', top: position.y + 'px', right: 'auto', bottom: 'auto' } : {}" aria-label="桌宠">
  <div class="pet-toolbar" @pointerdown="startDrag" @pointermove="move" @pointerup="endDrag" @pointercancel="endDrag"><span>{{ snapshot.resource.name }}</span><button @click="toggle">{{ expanded ? '收起' : '交流' }}</button><button @click="change({ stopped: !snapshot.configuration.stopped })">{{ snapshot.configuration.stopped ? '恢复' : '停止' }}</button><button title="桌宠资源与显示设置" @click="emit('manage')">设置</button><button @click="change({ visible: false })">隐藏</button></div>
  <ScreenSenseStatus v-if="surface === 'floating'" @manage="call('desktop.pet.screenSense')" />
  <p v-if="error" class="surface-error" role="alert">{{ error }}</p>
  <div class="pet-stage" :style="dimensions"><PetPlayer :key="snapshot.state.generation" :resource="snapshot.resource" :configuration="snapshot.configuration" :state="snapshot.state" controlled /></div>
  <PetInbox v-if="expanded" :conversation-id="conversationId" @open="id => emit('open', id)" />
</section></template>
<style scoped>.pet-surface{position:fixed;right:22px;bottom:32px;z-index:25;max-width:calc(100vw - 12px);color:var(--text);font-size:12px}.pet-toolbar{display:flex;align-items:center;gap:5px;cursor:move;touch-action:none;background:var(--background);border:1px solid var(--border);padding:5px}.pet-toolbar span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:auto;padding:0 5px}.pet-toolbar button{border:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--text);padding:4px 6px;font:inherit;cursor:pointer;white-space:nowrap}.pet-stage{max-width:100%;max-height:65dvh;margin:0 auto;pointer-events:none}.expanded{width:440px}.expanded .pet-stage{max-height:150px}.floating{position:static;width:100%;height:100%;max-width:none;display:flex;flex-direction:column}.floating .pet-toolbar{-webkit-app-region:drag}.floating button{-webkit-app-region:no-drag}.floating .pet-stage{flex:1;min-height:80px;width:100%!important;max-height:none}.floating.expanded .pet-stage{height:130px!important;flex:none}.surface-error{padding:8px;background:#111e;color:#edaaaa;margin:0}.floating :deep(.pet-inbox){max-height:none;flex:1;min-height:0}@media(max-width:600px){.pet-toolbar{font-size:11px;gap:3px}.pet-toolbar button{padding:4px}.pet-surface.expanded{width:calc(100vw - 12px);left:6px!important;top:auto!important;bottom:8px!important}}</style>
