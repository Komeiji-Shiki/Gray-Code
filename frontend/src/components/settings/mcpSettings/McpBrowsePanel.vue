<script setup lang="ts">
/**
 * McpBrowsePanel - MCP 资源与提示模板只读浏览
 *
 * 从 McpSettings.vue 拆出的子组件（与 McpServerList/McpServerEditForm/McpJsonEditor 同风格）：
 * - 纯展示 + 交互状态由本组件持有；RPC 与数据整形全部委托 mcpBrowse.ts（.vue 保持薄）；
 * - 只读：不触碰服务器增删改与连接逻辑，不改设置草稿协议；
 * - 失败显示具体错误原文，不假装成功；VSCode 宿主缺处理器时提示仅桌面版可用。
 */

import { computed, onUnmounted, ref, watch } from 'vue'
import { useChatStore } from '../../../stores/chatStore'
import { createContextNode, createTextNode } from '../../../types/editorNode'
import { selectMcpResource, selectMcpPrompt } from './mcpSelection'
import { useI18n } from '@/i18n'
import type { McpServerInfo } from '@/types'
import {
  extractRpcErrorMessage,
  isMissingHandlerError,
  isBrowsableStatus,
  findMissingRequiredArg,
  fetchMcpResources,
  fetchMcpPrompts,
  fetchMcpResourceContent,
  fetchMcpPromptMessages,
  type McpBrowsePrompt,
  type McpResourcesServerEntry,
  type McpPromptsServerEntry,
  type ResourceView,
  type McpResourceContent,
  type McpPromptMessage,
  type PromptMessageView
} from './mcpBrowse'

const { t } = useI18n()
const chat = useChatStore()
const selectionNotice = ref('')
let listRequest = 0
let resourceRequest = 0
let promptRequest = 0

const props = defineProps<{
  servers: McpServerInfo[]
}>()

type BrowseTab = 'resources' | 'prompts'

const activeTab = ref<BrowseTab>('resources')
const selectedServerId = ref('')

const connectedServers = computed(() =>
  props.servers.filter(server => server.status === 'connected')
)

const selectedServer = computed(() =>
  props.servers.find(server => server.config.id === selectedServerId.value) ?? null
)

const selectedBrowsable = computed(() =>
  selectedServer.value ? isBrowsableStatus(selectedServer.value.status) : false
)

// ---- 列表态 ----
const resourcesEntries = ref<McpResourcesServerEntry[]>([])
const promptsEntries = ref<McpPromptsServerEntry[]>([])
const listLoading = ref(false)
const listError = ref('')
const listDesktopOnly = ref(false)

function currentResources(): McpResourcesServerEntry | null {
  return resourcesEntries.value.find(entry => entry.serverId === selectedServerId.value) ?? null
}

function currentPrompts(): McpPromptsServerEntry | null {
  return promptsEntries.value.find(entry => entry.serverId === selectedServerId.value) ?? null
}

const visibleResources = computed(() => currentResources()?.resources ?? [])
const visiblePrompts = computed(() => currentPrompts()?.prompts ?? [])

// ---- 资源详情态 ----
const expandedUri = ref('')
const resourceViews = ref<ResourceView[]>([])
const resourceRaw = ref<McpResourceContent | null>(null)
const resourceLoading = ref(false)
const resourceError = ref('')
const resourceDesktopOnly = ref(false)

// ---- 提示详情态 ----
const expandedPrompt = ref('')
const promptArgs = ref<Record<string, string>>({})
const promptViews = ref<PromptMessageView[]>([])
const promptRaw = ref<McpPromptMessage[]>([])
const promptLoading = ref(false)
const promptError = ref('')
const promptDesktopOnly = ref(false)

function resetDetailState() {
  resourceRequest++; promptRequest++; resourceLoading.value = false; promptLoading.value = false; selectionNotice.value = ''
  expandedUri.value = ''
  resourceViews.value = []; resourceRaw.value = null
  resourceError.value = ''
  resourceDesktopOnly.value = false
  expandedPrompt.value = ''
  promptArgs.value = {}
  promptViews.value = []; promptRaw.value = []
  promptError.value = ''
  promptDesktopOnly.value = false
}

function handleListFailure(error: unknown) {
  const raw = extractRpcErrorMessage(error)
  listError.value = raw
  listDesktopOnly.value = isMissingHandlerError(error)
}

async function loadLists() {
  const request = ++listRequest
  const serverId = selectedServerId.value
  if (!serverId) return
  listLoading.value = true
  listError.value = ''
  listDesktopOnly.value = false
  resetDetailState()
  try {
    const [resources, prompts] = await Promise.all([
      fetchMcpResources(serverId),
      fetchMcpPrompts(serverId)
    ])
    if (request !== listRequest) return
    resourcesEntries.value = resources
    promptsEntries.value = prompts
  } catch (error) {
    if (request === listRequest) handleListFailure(error)
  } finally {
    if (request === listRequest) listLoading.value = false
  }
}

function selectTab(tab: BrowseTab) {
  activeTab.value = tab
}

async function toggleResource(uri: string) {
  const request = ++resourceRequest
  const serverId = selectedServerId.value
  selectionNotice.value = ''
  if (expandedUri.value === uri) {
    resourceLoading.value = false
    expandedUri.value = ''
    resourceViews.value = []; resourceRaw.value = null
    resourceError.value = ''
    resourceDesktopOnly.value = false
    return
  }
  expandedUri.value = uri
  resourceViews.value = []; resourceRaw.value = null
  resourceError.value = ''
  resourceDesktopOnly.value = false
  resourceLoading.value = true
  try {
    const result = await fetchMcpResourceContent(serverId, uri)
    // 展开期间切换了目标：丢弃过期响应
    if (request !== resourceRequest || selectedServerId.value !== serverId) return
    resourceViews.value = result.views; resourceRaw.value = result.raw
  } catch (error) {
    if (request !== resourceRequest || selectedServerId.value !== serverId) return
    resourceError.value = extractRpcErrorMessage(error)
    resourceDesktopOnly.value = isMissingHandlerError(error)
  } finally {
    if (request === resourceRequest) resourceLoading.value = false
  }
}

function togglePrompt(prompt: McpBrowsePrompt) {
  promptRequest++; promptLoading.value = false; selectionNotice.value = ''
  if (expandedPrompt.value === prompt.name) {
    expandedPrompt.value = ''
    promptArgs.value = {}
    promptViews.value = []; promptRaw.value = []
    promptError.value = ''
    promptDesktopOnly.value = false
    return
  }
  expandedPrompt.value = prompt.name
  const initial: Record<string, string> = {}
  for (const arg of prompt.arguments ?? []) initial[arg.name] = ''
  promptArgs.value = initial
  promptViews.value = []; promptRaw.value = []
  promptError.value = ''
  promptDesktopOnly.value = false
}

async function previewPrompt(prompt: McpBrowsePrompt) {
  const request = ++promptRequest
  const serverId = selectedServerId.value
  selectionNotice.value = ''
  promptLoading.value = true
  promptError.value = ''
  promptDesktopOnly.value = false
  promptViews.value = []; promptRaw.value = []
  try {
    const missing = findMissingRequiredArg(prompt, promptArgs.value)
    if (missing) throw new Error(`缺少提示参数：${missing}`)
    const result = await fetchMcpPromptMessages(serverId, prompt.name, promptArgs.value)
    if (request !== promptRequest || selectedServerId.value !== serverId) return
    promptViews.value = result.views; promptRaw.value = result.raw
  } catch (error) {
    if (request !== promptRequest || selectedServerId.value !== serverId) return
    promptError.value = extractRpcErrorMessage(error)
    promptDesktopOnly.value = isMissingHandlerError(error)
  } finally {
    if (request === promptRequest) promptLoading.value = false
  }
}

// 默认选中首个已连接服务器；服务器列表变化（连接/断开/导入刷新）时跟随
watch(
  connectedServers,
  servers => {
    if (!servers.some(server => server.config.id === selectedServerId.value)) {
      selectedServerId.value = servers[0]?.config.id ?? ''
      if (!selectedServerId.value) {
        resourcesEntries.value = []
        promptsEntries.value = []
        listError.value = ''
        listDesktopOnly.value = false
        resetDetailState()
      }
    }
  },
  { immediate: true }
)

watch(selectedServerId, () => { void loadLists() }, { immediate: true })

function addSelection(value: ReturnType<typeof selectMcpResource>) {
  const nodes = chat.editorNodes.length ? [...chat.editorNodes] : chat.inputValue ? [createTextNode(chat.inputValue)] : []
  chat.setEditorNodes([...nodes, createContextNode(value.context)])
  for (const attachment of value.attachments) chat.addStoreAttachment(attachment)
  selectionNotice.value = '已加入当前输入，可以返回对话查看或编辑。'
}
function useResource() {
  if (!resourceRaw.value) return
  try { addSelection(selectMcpResource(selectedServer.value?.config.name ?? selectedServerId.value, resourceRaw.value)) }
  catch (error) { resourceError.value = extractRpcErrorMessage(error) }
}
function usePrompt() {
  try { addSelection(selectMcpPrompt(selectedServer.value?.config.name ?? selectedServerId.value, expandedPrompt.value, promptRaw.value)) }
  catch (error) { promptError.value = extractRpcErrorMessage(error) }
}
watch(promptArgs, () => { promptRequest++; promptLoading.value = false; promptRaw.value = []; promptViews.value = [] }, { deep: true })
onUnmounted(() => { listRequest++; resourceRequest++; promptRequest++ })
</script>

<template>
  <section class="mcp-browse-panel" data-preference-transient :aria-label="t('components.settings.mcpSettings.browse.title')">
    <div class="browse-header">
      <h4 class="browse-title">{{ t('components.settings.mcpSettings.browse.title') }}</h4>
      <p class="browse-description">{{ t('components.settings.mcpSettings.browse.description') }}</p>
    </div>

    <div v-if="connectedServers.length === 0" class="browse-empty">
      {{ t('components.settings.mcpSettings.browse.noConnected') }}
    </div>

    <template v-else>
      <div class="browse-toolbar">
        <label class="server-select-label" for="mcp-browse-server">
          {{ t('components.settings.mcpSettings.browse.serverLabel') }}
        </label>
        <select
          id="mcp-browse-server"
          v-model="selectedServerId"
          class="gc-input server-select"
        >
          <option
            v-for="server in connectedServers"
            :key="server.config.id"
            :value="server.config.id"
          >
            {{ server.config.name }}
          </option>
        </select>
        <button class="toolbar-btn" :disabled="listLoading || !selectedServerId" @click="loadLists">
          <i class="codicon" :class="listLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'"></i>
          <span>{{ t('components.settings.mcpSettings.browse.refresh') }}</span>
        </button>
      </div>

      <div v-if="selectedServer && !selectedBrowsable" class="form-error">
        <i class="codicon codicon-error"></i>
        {{ t('components.settings.mcpSettings.browse.disconnectedHint') }}
        <span v-if="selectedServer.lastError">（{{ selectedServer.lastError }}）</span>
      </div>

      <div v-if="listError" class="form-error" role="alert">
        <i class="codicon codicon-error"></i>
        <span>
          <template v-if="listDesktopOnly">
            {{ t('components.settings.mcpSettings.browse.desktopOnly') }}：{{ listError }}
          </template>
          <template v-else>{{ listError }}</template>
        </span>
      </div>

      <div class="browse-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'resources'"
          class="browse-tab"
          :class="{ active: activeTab === 'resources' }"
          @click="selectTab('resources')"
        >
          {{ t('components.settings.mcpSettings.browse.resourcesTab') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'prompts'"
          class="browse-tab"
          :class="{ active: activeTab === 'prompts' }"
          @click="selectTab('prompts')"
        >
          {{ t('components.settings.mcpSettings.browse.promptsTab') }}
        </button>
      </div>

      <div v-if="listLoading" class="loading-state">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        <span>{{ t('components.settings.mcpSettings.browse.loading') }}</span>
      </div>

      <!-- 资源列表 -->
      <div v-else-if="activeTab === 'resources'" class="browse-list">
        <div v-if="visibleResources.length === 0" class="browse-empty">
          {{ t('components.settings.mcpSettings.browse.emptyResources') }}
        </div>
        <div
          v-for="resource in visibleResources"
          :key="resource.uri"
          class="browse-card"
        >
          <button type="button" class="browse-card-header" @click="toggleResource(resource.uri)">
            <i
              class="codicon"
              :class="expandedUri === resource.uri ? 'codicon-chevron-down' : 'codicon-chevron-right'"
              aria-hidden="true"
            ></i>
            <span class="browse-card-title">{{ resource.name }}</span>
            <code class="browse-card-uri">{{ resource.uri }}</code>
          </button>
          <div v-if="resource.description" class="browse-card-desc">{{ resource.description }}</div>

          <div v-if="expandedUri === resource.uri" class="browse-detail">
            <div v-if="resourceLoading" class="loading-state">
              <i class="codicon codicon-loading codicon-modifier-spin"></i>
              <span>{{ t('components.settings.mcpSettings.browse.reading') }}</span>
            </div>
            <div v-else-if="resourceError" class="form-error" role="alert">
              <i class="codicon codicon-error"></i>
              <span>
                <template v-if="resourceDesktopOnly">
                  {{ t('components.settings.mcpSettings.browse.desktopOnly') }}：{{ resourceError }}
                </template>
                <template v-else>{{ resourceError }}</template>
              </span>
            </div>
            <template v-else-if="resourceViews.length">
              <div class="browse-detail-title">{{ t('components.settings.mcpSettings.browse.resourceContentTitle') }}</div>
              <div v-for="(view, index) in resourceViews" :key="index">
                <code>{{ view.uri }}</code>
                <pre v-if="view.kind === 'text'" class="browse-text">{{ view.text }}</pre>
                <figure v-else-if="view.kind === 'image'" class="browse-image-box"><img :src="view.imageUrl" :alt="view.uri" /></figure>
                <p v-else-if="view.kind === 'file'">二进制附件 · {{ view.mimeType || '未知文件类型' }}</p>
                <div v-else class="browse-empty">{{ t('components.settings.mcpSettings.browse.contentEmpty') }}</div>
              </div>
              <button type="button" class="toolbar-btn primary" @click="useResource">加入当前输入</button>
            </template>
          </div>

          <div v-else class="browse-card-actions">
            <button type="button" class="toolbar-btn" @click="toggleResource(resource.uri)">
              {{ t('components.settings.mcpSettings.browse.read') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 提示模板列表 -->
      <div v-else class="browse-list">
        <div v-if="visiblePrompts.length === 0" class="browse-empty">
          {{ t('components.settings.mcpSettings.browse.emptyPrompts') }}
        </div>
        <div
          v-for="prompt in visiblePrompts"
          :key="prompt.name"
          class="browse-card"
        >
          <button type="button" class="browse-card-header" @click="togglePrompt(prompt)">
            <i
              class="codicon"
              :class="expandedPrompt === prompt.name ? 'codicon-chevron-down' : 'codicon-chevron-right'"
              aria-hidden="true"
            ></i>
            <span class="browse-card-title">{{ prompt.name }}</span>
          </button>
          <div v-if="prompt.description" class="browse-card-desc">{{ prompt.description }}</div>

          <div v-if="expandedPrompt === prompt.name" class="browse-detail">
            <div v-if="(prompt.arguments ?? []).length > 0" class="prompt-args">
              <div class="browse-detail-title">{{ t('components.settings.mcpSettings.browse.argsTitle') }}</div>
              <label
                v-for="arg in prompt.arguments"
                :key="arg.name"
                class="prompt-arg-row"
              >
                <span class="prompt-arg-name">
                  {{ arg.name }}
                  <span v-if="arg.required" class="prompt-required">*{{ t('components.settings.mcpSettings.browse.required') }}</span>
                </span>
                <input
                  v-model="promptArgs[arg.name]"
                  type="text"
                  class="gc-input prompt-arg-input"
                  :placeholder="arg.description || arg.name"
                  :aria-label="arg.name"
                />
              </label>
            </div>
            <div class="browse-card-actions">
              <button
                type="button"
                class="toolbar-btn primary"
                :disabled="promptLoading"
                @click="previewPrompt(prompt)"
              >
                <i
                  v-if="promptLoading"
                  class="codicon codicon-loading codicon-modifier-spin"
                  aria-hidden="true"
                ></i>
                <span>{{ promptLoading ? t('components.settings.mcpSettings.browse.previewing') : t('components.settings.mcpSettings.browse.preview') }}</span>
              </button>
              <button type="button" class="toolbar-btn" @click="togglePrompt(prompt)">
                {{ t('components.settings.mcpSettings.browse.closeDetail') }}
              </button>
            </div>

            <div v-if="promptError" class="form-error" role="alert">
              <i class="codicon codicon-error"></i>
              <span>
                <template v-if="promptDesktopOnly">
                  {{ t('components.settings.mcpSettings.browse.desktopOnly') }}：{{ promptError }}
                </template>
                <template v-else>{{ promptError }}</template>
              </span>
            </div>

            <div v-if="promptViews.length > 0" class="prompt-messages">
              <button type="button" class="toolbar-btn primary" @click="usePrompt">加入当前输入</button>
              <div class="browse-detail-title">{{ t('components.settings.mcpSettings.browse.promptMessagesTitle') }}</div>
              <div
                v-for="(message, index) in promptViews"
                :key="`${message.role}-${index}`"
                class="prompt-message"
                :class="`role-${message.role}`"
              >
                <span class="prompt-role">{{ message.role }}</span>
                <p v-if="message.kind === 'text' || message.kind === 'resource'" class="browse-text">{{ message.text }}</p>
                <figure v-else-if="message.kind === 'image'" class="browse-image-box">
                  <img :src="message.imageUrl" :alt="`${message.role} image`" />
                </figure>
                <span v-else-if="message.kind === 'file'">二进制附件 · {{ message.mimeType }}</span>
                <span v-else class="browse-empty">{{ t('components.settings.mcpSettings.browse.contentEmpty') }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
    <p v-if="selectionNotice" role="status">{{ selectionNotice }}</p>
  </section>
</template>

<style scoped>
.mcp-browse-panel {
  margin-top: var(--gc-space-4);
  padding: var(--gc-space-4);
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 0;
}

.browse-header {
  margin-bottom: var(--gc-space-3);
}

.browse-title {
  margin: 0 0 var(--gc-space-1) 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.browse-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.browse-toolbar {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  margin-bottom: var(--gc-space-3);
}

.server-select-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.server-select {
  flex: 1;
  min-width: 0;
}

.gc-input {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--gc-radius-sm);
  padding: 6px 8px;
  font-size: 12px;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}

.toolbar-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.toolbar-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.browse-tabs {
  display: flex;
  gap: var(--gc-space-1);
  margin-bottom: var(--gc-space-3);
}

.browse-tab {
  padding: 6px 12px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  cursor: pointer;
}

.browse-tab.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
}

.browse-list {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
}

.browse-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--gc-radius-sm);
  padding: var(--gc-space-3);
  background: var(--vscode-editor-background);
}

.browse-card-header {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  width: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.browse-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.browse-card-uri {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browse-card-desc {
  margin-top: var(--gc-space-1);
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.browse-card-actions {
  display: flex;
  gap: var(--gc-space-2);
  margin-top: var(--gc-space-2);
}

.browse-detail {
  margin-top: var(--gc-space-2);
  padding-top: var(--gc-space-2);
  border-top: 1px solid var(--vscode-panel-border);
}

.browse-detail-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
  margin-bottom: var(--gc-space-2);
}

.browse-text {
  margin: 0;
  padding: var(--gc-space-3);
  background: var(--vscode-textBlockQuote-background);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-foreground);
  max-height: 320px;
  overflow: auto;
}

.browse-image-box {
  margin: 0;
  padding: var(--gc-space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--gc-radius-sm);
  background: var(--vscode-textBlockQuote-background);
}

.browse-image-box img {
  display: block;
  max-width: 100%;
  border-radius: var(--gc-radius-sm);
}

.browse-image-box figcaption {
  margin-top: var(--gc-space-1);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
}

.prompt-args {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
  margin-bottom: var(--gc-space-2);
}

.prompt-arg-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prompt-arg-name {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.prompt-required {
  color: var(--vscode-errorForeground);
  font-size: 11px;
  margin-left: 4px;
}

.prompt-messages {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-2);
  margin-top: var(--gc-space-2);
}

.prompt-message {
  border-left: 2px solid var(--vscode-panel-border);
  padding: 0 var(--gc-space-3);
}

.prompt-message.role-assistant {
  border-left-color: var(--vscode-charts-blue, var(--vscode-focusBorder));
}

.prompt-role {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
}

.browse-empty {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: var(--gc-space-3);
  text-align: center;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--gc-space-4);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.form-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: var(--gc-space-2);
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: var(--gc-radius-sm);
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
