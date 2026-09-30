<script setup lang="ts">
import type { ConversationNavigationItem, RunRecord } from '@graycode/contracts';
import NavigationIcon from './NavigationIcon.vue';
import { shellText } from '../../i18n';
defineProps<{ item: ConversationNavigationItem; active: boolean; status?: RunRecord['status']; hasDraft?: boolean }>();
defineEmits<{ select: []; menu: [event: MouseEvent] }>();
const labels: Record<RunRecord['status'], string> = { queued: '等待执行', running: '正在执行', awaiting_input: '等待回答', awaiting_approval: '等待确认', completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' };
const statusLabel = (status: RunRecord['status']) => status === 'awaiting_input' ? shellText('awaitingInput') : status === 'awaiting_approval' ? shellText('awaitingApproval') : labels[status];
</script>
<template>
  <div class="navigation-row" :class="{ active }" :data-conversation-id="item.id" @contextmenu.prevent="$emit('menu', $event)">
    <button class="navigation-select" :aria-current="active ? 'page' : undefined" :title="item.searchHit ? `${item.title || '未命名对话'}\n${item.searchHit.excerpt}` : item.title || '未命名对话'" @click="$emit('select')">
      <span v-if="status" class="navigation-run-dot" :class="status" :title="statusLabel(status)" :aria-label="statusLabel(status)" :aria-hidden="status === 'awaiting_input' || status === 'awaiting_approval' ? true : undefined"></span><span v-else-if="hasDraft" class="navigation-draft-dot" title="有未发送的草稿" aria-label="有未发送的草稿"></span>
      <span class="navigation-labels"><span class="navigation-title">{{ item.title || '未命名对话' }}</span><span v-if="item.searchHit" class="navigation-excerpt">{{ item.searchHit.excerpt }}</span></span>
      <span v-if="status === 'awaiting_input' || status === 'awaiting_approval'" class="navigation-waiting-status" :class="status">{{ statusLabel(status) }}</span>
    </button>
    <button class="navigation-more" title="对话操作" aria-label="对话操作" aria-haspopup="menu" @click="$emit('menu', $event)"><NavigationIcon name="more" /></button>
  </div>
</template>
<style scoped>
.navigation-row{display:flex;align-items:center;min-width:0;min-height:35px;margin:2px 0;border-left:2px solid transparent}.navigation-row:hover{background:var(--gc-surface-hover)}.navigation-row.active{background:color-mix(in srgb,var(--gc-accent) 12%,var(--gc-surface-raised));border-left-color:var(--gc-accent)}
button{border:0;background:transparent;padding:8px;min-width:0}.navigation-select{display:flex;align-items:center;gap:8px;flex:1;text-align:left;min-height:35px}.navigation-labels{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}.navigation-title,.navigation-excerpt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.navigation-excerpt{color:var(--gc-text-muted);font-size:11px}.navigation-more{display:flex;padding:6px;flex-shrink:0;opacity:0}.navigation-row:hover .navigation-more,.navigation-row:focus-within .navigation-more{opacity:1}.navigation-more:hover{background:var(--gc-surface-hover)}
.navigation-run-dot,.navigation-draft-dot{width:6px;height:6px;background:var(--gc-accent);flex-shrink:0}.navigation-run-dot.awaiting_input{background:var(--gc-accent)}.navigation-run-dot.awaiting_approval{background:#d9b96a;transform:rotate(45deg)}.navigation-draft-dot{background:var(--gc-text-muted);width:4px;height:4px}
.navigation-waiting-status{flex-shrink:0;font-size:11px;line-height:1.4;color:var(--gc-accent)}.navigation-waiting-status.awaiting_approval{color:#d9b96a}
@media(hover:none){.navigation-more{opacity:1}}
</style>
