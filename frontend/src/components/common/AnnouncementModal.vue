<script setup lang="ts">
/**
 * AnnouncementModal - 版本更新公告弹窗。
 * 当用户更新版本后首次打开时显示更新内容。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, onMounted, computed } from 'vue'
import { useI18n } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'
import { escapeHtml } from './markdownUtils'
import Modal from './Modal.vue'

const { t } = useI18n()
const visible = ref(false)
const currentVersion = ref('')
const changelog = ref('')

onMounted(async () => {
  try {
    const result = await sendToExtension<{
      shouldShow: boolean
      version: string
      changelog: string
    }>(MESSAGE_NAMES.checkAnnouncement, {})

    if (result.shouldShow) {
      currentVersion.value = result.version
      changelog.value = result.changelog
      visible.value = true
    }
  } catch (error) {
    console.error('Failed to check announcement:', error)
  }
})

async function close() {
  visible.value = false
  try {
    await sendToExtension(MESSAGE_NAMES.markAnnouncementRead, {
      version: currentVersion.value
    })
  } catch (error) {
    console.error('Failed to mark announcement as read:', error)
  }
}

const formattedChangelog = computed(() => {
  if (!changelog.value) return ''
  return escapeHtml(changelog.value)
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '')
})
</script>

<template>
  <Modal
    v-model="visible"
    :aria-label="t('components.announcement.title')"
    width="520px"
    @close="close"
  >
    <template #header>
      <div class="announcement-heading">
        <i class="codicon codicon-megaphone" aria-hidden="true"></i>
        <h2>{{ t('components.announcement.title') }}</h2>
        <span class="version-badge gc-badge">v{{ currentVersion }}</span>
      </div>
    </template>

    <div class="changelog-content" v-html="formattedChangelog"></div>

    <template #footer>
      <button type="button" class="gc-button gc-button--primary" @click="close">
        {{ t('components.announcement.gotIt') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.announcement-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.announcement-heading > .codicon {
  flex-shrink: 0;
  color: var(--gc-link);
  font-size: 20px;
}

.announcement-heading h2 {
  min-width: 0;
  margin: 0;
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-semibold);
}

.version-badge {
  flex-shrink: 0;
}

.changelog-content {
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-relaxed);
}

.changelog-content :deep(h3) {
  margin: var(--gc-space-5) 0 var(--gc-space-3);
  padding-top: var(--gc-space-4);
  color: var(--gc-link);
  border-top: 1px solid var(--gc-border-subtle);
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-semibold);
}

.changelog-content :deep(h3):first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

.changelog-content :deep(h4) {
  margin: var(--gc-space-4) 0 var(--gc-space-2);
  color: var(--gc-link);
  font-size: var(--gc-font-size-control);
  font-weight: var(--gc-font-weight-semibold);
}

.changelog-content :deep(h4):first-child {
  margin-top: 0;
}

.changelog-content :deep(ul) {
  margin: 0 0 var(--gc-space-3);
  padding-left: var(--gc-space-5);
}

.changelog-content :deep(li) {
  margin: var(--gc-space-1) 0;
  color: var(--gc-text-muted);
}

.changelog-content :deep(code) {
  padding: 1px var(--gc-space-1);
  background: var(--vscode-textCodeBlock-background, var(--gc-surface-muted));
  border-radius: var(--gc-radius-xs);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--gc-font-size-body);
}

.changelog-content :deep(strong) {
  color: var(--gc-text-primary);
  font-weight: var(--gc-font-weight-semibold);
}
</style>
