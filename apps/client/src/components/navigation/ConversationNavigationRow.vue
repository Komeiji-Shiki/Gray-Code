<script setup lang="ts">
import { computed } from 'vue';

import { shellText as t } from '../../i18n';
import type { ConversationNavigationItem, RunRecord } from '@graycode/contracts';
import NavigationIcon from './NavigationIcon.vue';
import { shellText } from '../../i18n';
defineProps<{ item: ConversationNavigationItem; active: boolean; status?: RunRecord['status']; hasDraft?: boolean }>();
defineEmits<{ select: []; menu: [event: MouseEvent] }>();
const labels = computed<Record<RunRecord['status'], string>>(() => ({
  queued: t('uiNodeTasksWaitingToRun'),
  running: t('uiNodeTasksRunning'),
  awaiting_input: t('awaitingInput'),
  awaiting_approval: t('awaitingApproval'),
  completed: t('uiComputerPaneCompleted'),
  failed: t('uiConversationNavigationRowExecutionFailed'),
  cancelled: t('reviewCancelledStatus'),
  interrupted: t('uiMemoryLibraryInterrupted'),
}));
const statusLabel = (status: RunRecord['status']) =>
  status === 'awaiting_input' ? shellText('awaitingInput') : status === 'awaiting_approval' ? shellText('awaitingApproval') : labels.value[status];
</script>
<template>
  <div class="navigation-row" :class="{ active }" :data-conversation-id="item.id" @contextmenu.prevent="$emit('menu', $event)">
    <button
      class="navigation-select"
      :aria-current="active ? 'page' : undefined"
      :title="
        item.searchHit
          ? `${item.title || t('uiConversationNavigationRowUntitledConversation')}\n${item.searchHit.excerpt}`
          : item.title || t('uiConversationNavigationRowUntitledConversation')
      "
      @click="$emit('select')"
    >
      <span
        v-if="status"
        class="navigation-run-dot"
        :class="status"
        :title="statusLabel(status)"
        :aria-label="statusLabel(status)"
        :aria-hidden="status === 'awaiting_input' || status === 'awaiting_approval' ? true : undefined"
      ></span>
      <span
        v-else-if="hasDraft"
        class="navigation-draft-dot"
        :title="t('uiConversationNavigationRowHasUnsentDraft')"
        :aria-label="t('uiConversationNavigationRowHasUnsentDraft')"
      ></span>
      <span class="navigation-labels">
        <span class="navigation-title">{{ item.title || t('uiConversationNavigationRowUntitledConversation') }}</span>
        <span v-if="item.searchHit" class="navigation-excerpt">{{ item.searchHit.excerpt }}</span>
      </span>
      <span v-if="status === 'awaiting_input' || status === 'awaiting_approval'" class="navigation-waiting-status" :class="status">
        {{ statusLabel(status) }}
      </span>
    </button>
    <button
      class="navigation-more"
      :title="t('uiConversationSidebarConversationActions')"
      :aria-label="t('uiConversationSidebarConversationActions')"
      aria-haspopup="menu"
      @click="$emit('menu', $event)"
    >
      <NavigationIcon name="more" />
    </button>
  </div>
</template>
<style scoped>
.navigation-row {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 35px;
  margin: 2px 0;
  border-radius: var(--gc-radius-sm);
}
.navigation-row:hover {
  background: var(--gc-surface-chrome-hover);
}
.navigation-row.active {
  background: var(--gc-surface-chrome-hover);
}
.navigation-row.active::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  border-radius: 0;
  background: var(--gc-accent);
  pointer-events: none;
}
button {
  border: 0;
  background: transparent;
  padding: 8px;
  min-width: 0;
}
.navigation-select {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  text-align: left;
  min-height: 35px;
}
.navigation-labels {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 2px;
}
.navigation-title,
.navigation-excerpt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.navigation-excerpt {
  color: var(--gc-text-muted);
  font-size: 11px;
}
.navigation-more {
  display: flex;
  padding: 6px;
  flex-shrink: 0;
  opacity: 0;
}
.navigation-row:hover .navigation-more,
.navigation-row:focus-within .navigation-more {
  opacity: 1;
}
.navigation-more:hover {
  background: var(--gc-surface-hover);
}
.navigation-run-dot,
.navigation-draft-dot {
  width: 6px;
  height: 6px;
  background: var(--gc-accent);
  flex-shrink: 0;
}
.navigation-run-dot.awaiting_input {
  background: var(--gc-accent);
}
.navigation-run-dot.awaiting_approval {
  background: var(--gc-warning);
  transform: rotate(45deg);
}
.navigation-draft-dot {
  background: var(--gc-text-muted);
  width: 4px;
  height: 4px;
}
.navigation-waiting-status {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--gc-accent);
}
.navigation-waiting-status.awaiting_approval {
  color: var(--gc-warning);
}
@media (hover: none) {
  .navigation-more {
    opacity: 1;
  }
}
</style>
