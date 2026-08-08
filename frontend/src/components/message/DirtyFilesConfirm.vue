<script setup lang="ts">
/**
 * 未保存文件确认框（BCP-05 / 决策 11）。
 *
 * 普通恢复（checkpoint.restore 四个入口）与分支切换恢复（switchBranchCandidate
 * mode=chat-and-workspace）在后端检测到未保存（dirty）文件时，经
 * pendingDirtyConfirm（stores/chat/dirtyConfirmState）驱动本组件弹出确认框：
 * - 确认「丢弃更改并继续」→ 按 kind 分发续作（带 confirmedDiscardDirty=true 重试）；
 * - 取消 → 清空待确认动作（后端未执行任何写入，零副作用）。
 *
 * 挂载位置：MessageList.vue 常驻组件，无分支图时仍渲染。
 */
import { computed } from 'vue'
import { useChatStore } from '../../stores/chatStore'
import { useI18n } from '../../i18n'
import { ConfirmDialog } from '../common'
import { pendingDirtyConfirm, clearPendingDirtyConfirm } from '../../stores/chat/dirtyConfirmState'

const { t } = useI18n()
const chatStore = useChatStore()

const visible = computed({
  get: () => pendingDirtyConfirm.value !== null,
  set: (value: boolean) => {
    if (!value) clearPendingDirtyConfirm()
  }
})

const files = computed(() => pendingDirtyConfirm.value?.files ?? [])
const shownFiles = computed(() => files.value.slice(0, 10))
const hiddenCount = computed(() => Math.max(0, files.value.length - 10))

const title = computed(() => t('components.message.checkpoint.dirtyConfirmTitle'))
const message = computed(() =>
  t('components.message.checkpoint.dirtyConfirmMessage', { count: files.value.length })
)

async function runDirtyContinuation(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    console.error('[DirtyFilesConfirm] Failed to continue operation:', error)
  }
}

/** 确认丢弃未保存更改：按待确认动作的 kind 分发续作（confirmedDiscardDirty=true） */
function confirmDiscard(): void {
  const pending = pendingDirtyConfirm.value
  clearPendingDirtyConfirm()
  if (!pending) return

  if (pending.kind === 'switch' && pending.switch) {
    void runDirtyContinuation(() => chatStore.switchBranchCandidate(pending.switch!.nodeId, {
      mode: 'chat-and-workspace',
      confirmedDiscardDirty: true
    }))
    return
  }

  if (pending.kind === 'restore' && pending.restore) {
    const r = pending.restore
    if (r.entry === 'restore') {
      void runDirtyContinuation(() => chatStore.restoreCheckpoint(r.checkpointId, r.deleteUntrackedFiles, true))
      return
    }
    const index = r.messageId ? chatStore.allMessages.findIndex(m => m.id === r.messageId) : -1
    if (index === -1) return
    if (r.entry === 'retry') {
      void runDirtyContinuation(() => chatStore.restoreAndRetry(index, r.checkpointId, r.deleteUntrackedFiles, true))
    } else if (r.entry === 'delete') {
      void runDirtyContinuation(() => chatStore.restoreAndDelete(index, r.checkpointId, r.deleteUntrackedFiles, true))
    } else if (r.entry === 'edit') {
      void runDirtyContinuation(() => chatStore.restoreAndEdit(index, r.newContent || '', r.attachments, r.checkpointId, r.deleteUntrackedFiles, true))
    }
  }
}
</script>

<template>
  <ConfirmDialog
    v-model="visible"
    :title="title"
    :message="message"
    :confirm-text="t('components.message.checkpoint.dirtyConfirmDiscard')"
    :cancel-text="t('components.message.checkpoint.dirtyConfirmCancel')"
    is-danger
    @confirm="confirmDiscard"
    @cancel="clearPendingDirtyConfirm"
  >
    <div v-if="shownFiles.length > 0" class="dirty-files-list">
      <div v-for="file in shownFiles" :key="file" class="dirty-file-item">
        <i class="codicon codicon-warning"></i>
        <span class="dirty-file-path">{{ file }}</span>
      </div>
      <div v-if="hiddenCount > 0" class="dirty-file-more">
        {{ t('components.message.checkpoint.dirtyConfirmMore', { count: hiddenCount }) }}
      </div>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.dirty-files-list {
  margin-top: 8px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 4px 8px;
}

.dirty-file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.dirty-file-item .codicon {
  flex-shrink: 0;
  color: var(--vscode-editorWarning-foreground);
  font-size: 12px;
}

.dirty-file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: var(--vscode-editor-font-family, monospace);
}

.dirty-file-more {
  padding: 2px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>
