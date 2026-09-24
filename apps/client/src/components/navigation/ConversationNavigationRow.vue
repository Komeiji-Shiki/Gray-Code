<script setup lang="ts">
import type { ConversationNavigationItem, RunRecord } from '@graycode/contracts';
import NavigationIcon from './NavigationIcon.vue';
defineProps<{ item: ConversationNavigationItem; active: boolean; status?: RunRecord['status']; hasDraft?: boolean }>();
defineEmits<{ select: []; menu: [event: MouseEvent] }>();
const labels: Record<RunRecord['status'], string> = { queued: '等待执行', running: '正在执行', awaiting_input: '等待回答', awaiting_approval: '等待确认', completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' };
</script>
<template>
  <div class="navigation-row" :class="{ active }" :data-conversation-id="item.id" @contextmenu.prevent="$emit('menu', $event)">
    <button class="navigation-select" :aria-current="active ? 'page' : undefined" :title="item.searchHit ? `${item.title || '未命名对话'}\n${item.searchHit.excerpt}` : item.title || '未命名对话'" @click="$emit('select')">
      <span v-if="status" class="navigation-run-dot" :class="status" :title="labels[status]" :aria-label="labels[status]"></span><span v-else-if="hasDraft" class="navigation-draft-dot" title="有未发送的草稿" aria-label="有未发送的草稿"></span>
      <span class="navigation-labels"><span class="navigation-title">{{ item.title || '未命名对话' }}</span><span v-if="item.searchHit" class="navigation-excerpt">{{ item.searchHit.excerpt }}</span></span>
    </button>
    <button class="navigation-more" title="对话操作" aria-label="对话操作" aria-haspopup="menu" @click="$emit('menu', $event)"><NavigationIcon name="more" /></button>
  </div>
</template>
<style scoped>
.navigation-row{display:flex;align-items:center;min-width:0;min-height:35px;margin:2px 0;border-left:2px solid transparent}.navigation-row:hover{background:var(--hover)}.navigation-row.active{background:color-mix(in srgb,var(--accent) 12%,var(--panel));border-left-color:var(--accent)}
button{border:0;background:transparent;padding:8px;min-width:0}.navigation-select{display:flex;align-items:center;gap:8px;flex:1;text-align:left;min-height:35px}.navigation-labels{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}.navigation-title,.navigation-excerpt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.navigation-excerpt{color:var(--muted);font-size:11px}.navigation-more{display:flex;padding:6px;flex-shrink:0;opacity:0}.navigation-row:hover .navigation-more,.navigation-row:focus-within .navigation-more{opacity:1}.navigation-more:hover{background:var(--hover)}
.navigation-run-dot,.navigation-draft-dot{width:6px;height:6px;background:var(--accent);flex-shrink:0}.navigation-run-dot.awaiting_input,.navigation-run-dot.awaiting_approval{background:#d9b96a}.navigation-draft-dot{background:var(--muted);width:4px;height:4px}
@media(hover:none){.navigation-more{opacity:1}}
</style>
