<script setup lang="ts">
/**
 * UpdateModal - 发现新版本弹窗
 *
 * 后端启动检查（24h 节流）发现 GitHub Releases 有新版时弹出：
 * - 显示新版本号 + Release 说明
 * - 用户确认后自动下载安装包并交给系统打开（installUpdate 消息，后端下载完成提示安装）
 * - 安装失败可一键前往 GitHub 下载页兜底
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from '@/i18n'
import { sendToExtension, onExtensionCommand } from '@/utils/vscode'
import { escapeHtml } from './markdownUtils'

const { t } = useI18n()

const visible = ref(false)
const phase = ref<'prompt' | 'downloading' | 'installed' | 'failed'>('prompt')
const update = ref<{ version: string; name: string; body: string; installerAssetUrl?: string } | null>(null)
const errorMsg = ref('')
/** 用户最近一次关闭弹窗时的版本：相同版本的后端推送不再弹出（避免用户关掉后
 *  路过设置页点一次「立即检查」弹窗又回来；新版本仍会弹出） */
let lastDismissedVersion = ''

onMounted(async () => {
  // 后端启动检查延迟 10s 才完成，且挂载时内存状态恒为 idle——仅靠挂载查询弹窗
  // 永远不会出现；订阅后端 update.checkAvailable 推送（BackendHost 检查完成发现
  // 新版本时主动下发），挂载查询只作为兜底（如 webview 重载后状态仍在内存中）。
  const unsubscribe = onExtensionCommand<{ update?: typeof update.value }>('update.checkAvailable', (data) => {
    if (data?.update && data.update.version !== lastDismissedVersion) {
      update.value = data.update
      phase.value = 'prompt'
      visible.value = true
    }
  })
  onBeforeUnmount(unsubscribe)

  try {
    const res = await sendToExtension<{ status: { state: string; update?: typeof update.value } }>(MESSAGE_NAMES.getUpdateStatus, {})
    if (res?.status?.state === 'updateAvailable' && res.status.update && !visible.value
      && res.status.update.version !== lastDismissedVersion) {
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
    // 后端错误码 → 本地化文案（后端兜底 message 为中文，en/ja 用户不能直接看到）
    const codeText: Record<string, string> = {
      INSTALL_UPDATE_NO_ASSET: t('components.update.noAsset'),
      UPDATE_NO_ASSET: t('components.update.noAsset'),
      UPDATE_LAUNCH_FAILED: t('components.update.launchFailed')
    }
    errorMsg.value = (e?.code && codeText[e.code]) || e?.message || String(e)
  }
}

function close() {
  if (update.value) {
    lastDismissedVersion = update.value.version
  }
  visible.value = false
}

function openReleasePage() {
  // 打开 GitHub 页面失败不能产生 unhandled rejection（设置页/弹窗已有兜底文案）
  void sendToExtension(MESSAGE_NAMES.openUpdatePage, {}).catch(() => undefined)
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
