<script setup lang="ts">
/**
 * UpdateModal - 发现新版本弹窗
 *
 * 后端启动检查（24h 节流）发现 GitHub Releases 有新版时弹出：
 * - 显示新版本号 + Release 说明
 * - 用户确认后自动下载 vsix 并安装（installUpdate 消息，后端安装完成后提示 reload）
 * - 安装失败可一键前往 GitHub 下载页兜底
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'
import { escapeHtml } from './markdownUtils'

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
  } catch (e: any) {
    phase.value = 'failed'
    errorMsg.value = e?.message || String(e)
  }
}

function close() {
  visible.value = false
}

function openReleasePage() {
  void sendToExtension(MESSAGE_NAMES.openUpdatePage, {})
}

// Release 说明渲染：先整体转义再替换 markdown 标记（防注入，与 AnnouncementModal 同策略）
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
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="modal-overlay" @click.self="close">
        <div class="modal-container">
          <!-- 标题栏 -->
          <div class="modal-header">
            <div class="header-content">
              <i class="codicon codicon-cloud-download"></i>
              <h2>{{ t('components.update.title') }}</h2>
              <span class="version-badge">v{{ update?.version }}</span>
              <span v-if="update?.channel === 'nightly'" class="channel-badge">{{ t('components.update.nightlyBadge') }}</span>
            </div>
            <button class="close-btn" @click="close" :title="t('common.close')">
              <i class="codicon codicon-close"></i>
            </button>
          </div>

          <!-- 内容区域 -->
          <div class="modal-body">
            <!-- 下载中 -->
            <div v-if="phase === 'downloading'" class="status-center">
              <i class="codicon codicon-loading spin"></i>
              <span>{{ t('components.update.downloading') }}</span>
            </div>

            <!-- 安装完成 -->
            <div v-else-if="phase === 'installed'" class="status-center success">
              <i class="codicon codicon-check"></i>
              <span>{{ t('components.update.installed') }}</span>
            </div>

            <!-- 失败 -->
            <div v-else-if="phase === 'failed'" class="status-center failed">
              <i class="codicon codicon-error"></i>
              <span>{{ t('components.update.failed') }}</span>
              <p class="error-detail">{{ errorMsg }}</p>
            </div>

            <!-- 提示安装 -->
            <template v-else>
              <p class="update-intro">{{ t('components.update.intro', { version: update?.version || '' }) }}</p>
              <template v-if="formattedBody">
                <p class="release-title">{{ t('components.update.releaseNotes') }}</p>
                <div class="changelog-content" v-html="formattedBody"></div>
              </template>
            </template>
          </div>

          <!-- 底部按钮 -->
          <div class="modal-footer">
            <template v-if="phase === 'prompt'">
              <button class="ghost-btn" @click="openReleasePage">{{ t('components.update.viewPage') }}</button>
              <button class="ghost-btn" @click="close">{{ t('components.update.later') }}</button>
              <button class="primary-btn" @click="install">{{ t('components.update.install') }}</button>
            </template>
            <template v-else-if="phase === 'failed'">
              <button class="primary-btn" @click="openReleasePage">{{ t('components.update.viewPage') }}</button>
              <button class="ghost-btn" @click="close">{{ t('common.close') }}</button>
            </template>
            <template v-else>
              <button class="primary-btn" @click="close">{{ t('common.close') }}</button>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
}

.modal-container {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  max-width: 520px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-content .codicon {
  font-size: 20px;
  color: var(--vscode-textLink-foreground);
}

.header-content h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.version-badge {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.channel-badge {
  background: var(--vscode-inputValidation-warningBackground, rgba(255, 193, 7, 0.2));
  color: var(--vscode-inputValidation-warningForeground, #d4a72c);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  transition: opacity 0.15s, background 0.15s;
}

.close-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-height: 0;
}

.update-intro {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--vscode-foreground);
}

.release-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
}

.changelog-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--vscode-foreground);
}

.changelog-content :deep(h3) {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vscode-textLink-foreground);
}

.changelog-content :deep(h3):first-child {
  margin-top: 0;
}

.changelog-content :deep(h4) {
  margin: 12px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-textLink-foreground);
}

.changelog-content :deep(ul) {
  margin: 0 0 12px;
  padding-left: 20px;
}

.changelog-content :deep(li) {
  margin: 4px 0;
  color: var(--vscode-descriptionForeground);
}

.changelog-content :deep(code) {
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
}

.changelog-content :deep(strong) {
  color: var(--vscode-foreground);
  font-weight: 600;
}

.status-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 0;
  font-size: 13px;
  color: var(--vscode-foreground);
}

.status-center .codicon {
  font-size: 28px;
}

.status-center.success .codicon {
  color: var(--vscode-testing-iconPassed, #89d185);
}

.status-center.failed .codicon {
  color: var(--vscode-testing-iconFailed, #f48771);
}

.error-detail {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
  text-align: center;
  max-width: 100%;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--vscode-panel-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.primary-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 8px 20px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.primary-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.ghost-btn {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.ghost-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 动画 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .modal-container,
.modal-leave-active .modal-container {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  transform: scale(0.95);
  opacity: 0;
}
</style>
