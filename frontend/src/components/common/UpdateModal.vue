<script setup lang="ts">
/**
 * UpdateModal - 发现新版本弹窗。
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/i18n'
import { sendToExtension, showNotification } from '@/utils/vscode'
import { escapeHtml } from './markdownUtils'
import Modal from './Modal.vue'

const { t } = useI18n()

const visible = ref(false)
const phase = ref<'prompt' | 'downloading' | 'installed' | 'failed'>('prompt')
const update = ref<{ version: string; name: string; body: string; vsixAssetUrl?: string; channel?: string } | null>(null)
const errorMsg = ref('')

onMounted(async () => {
  try {
    const res = await sendToExtension<{ status: { state: string; update?: typeof update.value } }>(MESSAGE_NAMES.getUpdateStatus, {})
    if (res?.status?.state === 'updateAvailable' && res.status.update) {
      update.value = res.status.update
      phase.value = 'prompt'
      visible.value = true
    }
  } catch {
    // 查询失败静默：不打扰用户（后端已记录 error 状态，设置页可查看）
  }
})

async function install() {
  if (!update.value) return
  phase.value = 'downloading'
  try {
    await sendToExtension(MESSAGE_NAMES.installUpdate, { update: update.value })
    phase.value = 'installed'
  } catch (error: unknown) {
    phase.value = 'failed'
    errorMsg.value = error instanceof Error ? error.message : String(error)
  }
}

function close() {
  visible.value = false
}

async function openReleasePage() {
  try {
    await sendToExtension(MESSAGE_NAMES.openUpdatePage, {})
  } catch (error) {
    console.error('Failed to open update page:', error)
    await showNotification(error instanceof Error ? error.message : t('components.update.failed'), 'error')
  }
}

const formattedBody = computed(() => {
  if (!update.value?.body) return ''
  return escapeHtml(update.value.body)
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
    :aria-label="t('components.update.title')"
    width="540px"
    :closable="phase !== 'downloading'"
    :mask-closable="phase !== 'downloading'"
    :close-on-escape="phase !== 'downloading'"
    @close="close"
  >
    <template #header>
      <div class="update-heading">
        <i class="codicon codicon-cloud-download" aria-hidden="true"></i>
        <h2>{{ t('components.update.title') }}</h2>
        <span class="version-badge gc-badge">v{{ update?.version }}</span>
        <span v-if="update?.channel === 'nightly'" class="channel-badge gc-badge gc-badge--warning">
          {{ t('components.update.nightlyBadge') }}
        </span>
      </div>
    </template>

    <div v-if="phase === 'downloading'" class="status-center" role="status" aria-live="polite">
      <i class="codicon codicon-loading gc-spin" aria-hidden="true"></i>
      <span>{{ t('components.update.downloading') }}</span>
    </div>

    <div v-else-if="phase === 'installed'" class="status-center success" role="status">
      <i class="codicon codicon-check" aria-hidden="true"></i>
      <span>{{ t('components.update.installed') }}</span>
    </div>

    <div v-else-if="phase === 'failed'" class="status-center failed" role="alert">
      <i class="codicon codicon-error" aria-hidden="true"></i>
      <span>{{ t('components.update.failed') }}</span>
      <p class="error-detail">{{ errorMsg }}</p>
    </div>

    <template v-else>
      <p class="update-intro">{{ t('components.update.intro', { version: update?.version || '' }) }}</p>
      <template v-if="formattedBody">
        <p class="release-title">{{ t('components.update.releaseNotes') }}</p>
        <div class="changelog-content" v-html="formattedBody"></div>
      </template>
    </template>

    <template #footer>
      <template v-if="phase === 'prompt'">
        <button type="button" class="gc-button gc-button--ghost" @click="openReleasePage">
          {{ t('components.update.viewPage') }}
        </button>
        <button type="button" class="gc-button" @click="close">
          {{ t('components.update.later') }}
        </button>
        <button type="button" class="gc-button gc-button--primary" @click="install">
          {{ t('components.update.install') }}
        </button>
      </template>
      <template v-else-if="phase === 'failed'">
        <button type="button" class="gc-button gc-button--primary" @click="openReleasePage">
          {{ t('components.update.viewPage') }}
        </button>
        <button type="button" class="gc-button" @click="close">{{ t('common.close') }}</button>
      </template>
      <template v-else-if="phase !== 'downloading'">
        <button type="button" class="gc-button gc-button--primary" @click="close">
          {{ t('common.close') }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.update-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.update-heading > .codicon {
  flex-shrink: 0;
  color: var(--gc-link);
  font-size: 20px;
}

.update-heading h2 {
  min-width: 0;
  margin: 0;
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-semibold);
}

.version-badge,
.channel-badge {
  flex-shrink: 0;
}

.update-intro,
.release-title,
.error-detail {
  margin: 0;
}

.update-intro {
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-control);
}

.release-title {
  margin-top: var(--gc-space-3);
  margin-bottom: var(--gc-space-2);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
  font-weight: var(--gc-font-weight-semibold);
}

.changelog-content {
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-relaxed);
}

.changelog-content :deep(h3) {
  margin: var(--gc-space-4) 0 var(--gc-space-2);
  color: var(--gc-link);
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-semibold);
}

.changelog-content :deep(h3):first-child {
  margin-top: 0;
}

.changelog-content :deep(h4) {
  margin: var(--gc-space-3) 0 6px;
  color: var(--gc-link);
  font-size: var(--gc-font-size-control);
  font-weight: var(--gc-font-weight-semibold);
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
  font-weight: var(--gc-font-weight-semibold);
}

.status-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gc-space-3);
  padding: var(--gc-space-8) 0;
  color: var(--gc-text-primary);
  font-size: var(--gc-font-size-control);
  text-align: center;
}

.status-center .codicon {
  font-size: 28px;
}

.status-center.success .codicon {
  color: var(--gc-success);
}

.status-center.failed .codicon {
  color: var(--gc-danger);
}

.error-detail {
  max-width: 100%;
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
  overflow-wrap: anywhere;
}
</style>
