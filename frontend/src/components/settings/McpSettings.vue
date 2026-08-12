<script setup lang="ts">
/**
 * MCP 设置组件
 * 用于配置 Model Context Protocol 服务器
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { CustomCheckbox, ConfirmDialog } from '../common'
import { useI18n } from '@/i18n'
import { formatMcpArgsInput, parseMcpArgsInput } from '@/utils/mcpArgs'
import type {
  McpServerInfo,
  McpServerConfig,
  McpTransportConfig,
  CreateMcpServerInput,
  McpServerStatus
} from '@/types'

const { t } = useI18n()

// ============ 状态 ============

// 服务器列表
const servers = ref<McpServerInfo[]>([])

// 是否正在加载
const isLoading = ref(false)

// 当前视图模式
type ViewMode = 'list' | 'edit'
const viewMode = ref<ViewMode>('list')

// 正在编辑的服务器
const editingServer = ref<McpServerConfig | null>(null)
const isCreating = ref(false)

// 表单状态
const formData = reactive<{
  customId: string
  name: string
  description: string
  transportType: 'stdio' | 'sse' | 'streamable-http'
  // stdio
  command: string
  args: string
  env: string
  // sse/streamable-http
  url: string
  headers: string
  // 通用
  enabled: boolean
  autoConnect: boolean
  timeout: number
  cleanSchema: boolean
}>({
  customId: '',
  name: '',
  description: '',
  transportType: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  enabled: true,
  autoConnect: false,
  timeout: 30000,
  cleanSchema: true
})

// ID 验证状态
const idValidation = reactive<{
  checking: boolean
  valid: boolean | null
  error: string
}>({
  checking: false,
  valid: null,
  error: ''
})

// 防抖计时器
let idCheckTimer: ReturnType<typeof setTimeout> | null = null
// ID 校验请求序号：仅最新请求可写校验状态，慢响应（过期响应）不覆盖新结果
let idCheckRequestSeq = 0

// 连接/断开操作错误消息（列表页顶部展示）
const connectionError = ref('')

// 重置 ID 校验状态并清理在途防抖检查
function resetIdValidation() {
  if (idCheckTimer) {
    clearTimeout(idCheckTimer)
    idCheckTimer = null
  }
  // 使在途校验响应失效：取消/切换传输类型/重置表单后，旧请求不得回写校验状态
  idCheckRequestSeq++
  idValidation.checking = false
  idValidation.valid = null
  idValidation.error = ''
}

// 保存状态
const isSaving = ref(false)
const saveError = ref('')

// 删除确认对话框
const showDeleteConfirm = ref(false)
const deleteTargetServer = ref<McpServerInfo | null>(null)

// 正在连接的服务器 ID 集合（用于显示连接中状态）
const connectingServers = ref<Set<string>>(new Set())

// ============ 计算属性 ============

const hasServers = computed(() => servers.value.length > 0)

const statusColor = (status: McpServerStatus) => {
  switch (status) {
    case 'connected': return 'var(--vscode-terminal-ansiGreen)'
    case 'connecting': return 'var(--vscode-terminal-ansiYellow)'
    case 'error': return 'var(--vscode-terminal-ansiRed)'
    default: return 'var(--vscode-descriptionForeground)'
  }
}

const statusText = (status: McpServerStatus) => {
  switch (status) {
    case 'connected': return t('components.settings.mcpSettings.status.connected')
    case 'connecting': return t('components.settings.mcpSettings.status.connecting')
    case 'error': return t('components.settings.mcpSettings.status.error')
    default: return t('components.settings.mcpSettings.status.disconnected')
  }
}

// ============ 方法 ============

// 加载服务器列表
async function loadServers() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ success: boolean; servers?: McpServerInfo[]; error?: any }>(MESSAGE_NAMES.getMcpServers, {})
    if (response?.success && response.servers) {
      servers.value = response.servers
    }
  } catch (error) {
    console.error('Failed to load MCP servers:', error)
  } finally {
    isLoading.value = false
  }
}

// 尝试自动连接单个服务器
async function tryAutoConnect(server: McpServerInfo) {
  const serverId = server.config.id
  
  // 如果已经在连接中，跳过
  if (connectingServers.value.has(serverId)) {
    return
  }
  
  connectingServers.value.add(serverId)
  
  try {
    await sendToExtension(MESSAGE_NAMES.connectMcpServer, { serverId })
    await loadServers()  // 刷新状态
  } catch (error) {
    console.error(`Auto-connect ${serverId} failed:`, error)
  } finally {
    connectingServers.value.delete(serverId)
  }
}

// 开始创建新服务器
function startCreate() {
  isCreating.value = true
  editingServer.value = null
  resetForm()
  viewMode.value = 'edit'
}

// 开始编辑服务器
function startEdit(server: McpServerInfo) {
  isCreating.value = false
  editingServer.value = server.config
  loadFormFromConfig(server.config)
  viewMode.value = 'edit'
}

// 从配置加载表单
function loadFormFromConfig(config: McpServerConfig) {
  formData.name = config.name
  formData.description = config.description || ''
  formData.enabled = config.enabled
  formData.autoConnect = config.autoConnect
  formData.timeout = config.timeout ?? 30000
  formData.cleanSchema = config.cleanSchema !== false  // 默认为 true
  
  const transport = config.transport
  formData.transportType = transport.type
  
  if (transport.type === 'stdio') {
    formData.command = transport.command
    formData.args = formatMcpArgsInput(transport.args)
    formData.env = transport.env ? JSON.stringify(transport.env, null, 2) : ''
  } else {
    formData.url = transport.url
    formData.headers = transport.headers ? JSON.stringify(transport.headers, null, 2) : ''
  }
}

// 重置表单
function resetForm() {
  formData.customId = ''
  formData.name = ''
  formData.description = ''
  formData.transportType = 'stdio'
  formData.command = ''
  formData.args = ''
  formData.env = ''
  formData.url = ''
  formData.headers = ''
  formData.enabled = true
  formData.autoConnect = false
  formData.timeout = 30000
  formData.cleanSchema = true
  saveError.value = ''
  resetIdValidation()
}

// 检查 ID 是否可用
async function checkIdAvailability(id: string) {
  // 请求序号：仅最新请求可写校验状态，慢响应（过期响应）不覆盖新结果
  const requestSeq = ++idCheckRequestSeq
  if (!id.trim()) {
    idValidation.valid = null
    idValidation.error = ''
    return
  }
  
  // 验证格式
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    idValidation.valid = false
    idValidation.error = t('components.settings.mcpSettings.form.serverIdError')
    return
  }
  
  idValidation.checking = true
  
  try {
    const response = await sendToExtension<{ success: boolean; valid?: boolean; error?: string }>(MESSAGE_NAMES.validateMcpServerId, {
      id: id.trim(),
      excludeId: editingServer.value?.id
    })
    
    // 过期响应（期间有新输入/新请求/重置）：丢弃，不覆盖新结果
    if (requestSeq !== idCheckRequestSeq) return
    
    if (response?.success) {
      idValidation.valid = response.valid ?? true
      idValidation.error = response.error || ''
    } else {
      idValidation.valid = null
      idValidation.error = ''
    }
  } catch (error) {
    if (requestSeq !== idCheckRequestSeq) return
    idValidation.valid = null
    idValidation.error = ''
  } finally {
    // 仅最新请求复位 checking（旧请求的 finally 不干扰新请求的校验中状态）
    if (requestSeq === idCheckRequestSeq) {
      idValidation.checking = false
    }
  }
}

// ID 输入时防抖检查
function onIdInput() {
  // 输入新内容立即重置校验结果：避免防抖等待期（300ms）内点保存沿用上一个 ID 的校验状态
  idValidation.checking = false
  idValidation.valid = null
  idValidation.error = ''
  // 使上一次输入触发的在途校验响应失效（其响应返回时序号不匹配，不会回写状态）
  idCheckRequestSeq++
  if (idCheckTimer) {
    clearTimeout(idCheckTimer)
  }
  idCheckTimer = setTimeout(() => {
    checkIdAvailability(formData.customId)
  }, 300)
}

// 取消编辑
function cancelEdit() {
  viewMode.value = 'list'
  editingServer.value = null
  isCreating.value = false
  resetIdValidation()
  resetForm()
}

// 切换传输类型：重置 ID 校验状态（校验与传输类型无关，避免残留状态误判）
function selectTransportType(type: 'stdio' | 'sse' | 'streamable-http') {
  formData.transportType = type
  resetIdValidation()
}

// 构建传输配置；JSON 字段无效时抛错并阻止保存。
function parseJsonObject(value: string, fieldName: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${fieldName}: ${t('components.settings.mcpSettings.validation.invalidJson')}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName}: ${t('components.settings.mcpSettings.validation.invalidJson')}`)
  }
  return parsed as Record<string, string>
}

function buildTransportConfig(): McpTransportConfig {
  if (formData.transportType === 'stdio') {
    const config: any = {
      type: 'stdio',
      command: formData.command.trim()
    }
    if (formData.args.trim()) {
      try {
        config.args = parseMcpArgsInput(formData.args)
      } catch {
        throw new Error(`args: ${t('components.settings.mcpSettings.validation.invalidArgsJsonArray')}`)
      }
    }
    if (formData.env.trim()) {
      config.env = parseJsonObject(formData.env, 'env')
    }
    return config
  } else {
    const config: any = {
      type: formData.transportType,
      url: formData.url.trim()
    }
    if (formData.headers.trim()) {
      config.headers = parseJsonObject(formData.headers, 'headers')
    }
    return config
  }
}

// 超时阈值（毫秒），与模板 input 的 min/max 对齐
const TIMEOUT_MIN_MS = 1000
const TIMEOUT_MAX_MS = 300000
const TIMEOUT_DEFAULT_MS = 30000

/**
 * 超时阈值钳制：v-model.number 在清空/非法输入时会把 formData.timeout 置为 ''（字符串），
 * 直接透传会污染后端配置；统一钳制到 [min, max]，非法输入回退默认值。
 */
function normalizeTimeout(value: unknown): number {
  if (value === '' || value === null || value === undefined) return TIMEOUT_DEFAULT_MS
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return TIMEOUT_DEFAULT_MS
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(n)))
}

// 保存服务器
async function saveServer() {
  if (!formData.name.trim()) {
    saveError.value = t('components.settings.mcpSettings.validation.nameRequired')
    return
  }
  
  // 验证自定义 ID
  if (isCreating.value && formData.customId.trim()) {
    if (idValidation.valid === false) {
      saveError.value = idValidation.error || t('components.settings.mcpSettings.validation.idInvalid')
      return
    }
    if (idValidation.checking) {
      saveError.value = t('components.settings.mcpSettings.validation.idChecking')
      return
    }
  }
  
  if (formData.transportType === 'stdio' && !formData.command.trim()) {
    saveError.value = t('components.settings.mcpSettings.validation.commandRequired')
    return
  }
  
  if ((formData.transportType === 'sse' || formData.transportType === 'streamable-http') && !formData.url.trim()) {
    saveError.value = t('components.settings.mcpSettings.validation.urlRequired')
    return
  }
  
  isSaving.value = true
  saveError.value = ''
  
  // 超时阈值钳制（见 normalizeTimeout）：脏输入（清空/非法）回退默认值并回写 UI，
  // 避免 ''（字符串）/越界值直接透传到后端配置。
  formData.timeout = normalizeTimeout(formData.timeout)

  try {
    const transport = buildTransportConfig()
    
    if (isCreating.value) {
      // 创建新服务器
      const input: CreateMcpServerInput = {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        transport,
        enabled: formData.enabled,
        autoConnect: formData.autoConnect,
        timeout: formData.timeout,
        cleanSchema: formData.cleanSchema
      }
      
      const customId = formData.customId.trim() || undefined
      
      const response = await sendToExtension<{ success: boolean; error?: any }>(MESSAGE_NAMES.createMcpServer, { input, customId })
      if (!response?.success) {
        throw new Error(response?.error?.message || t('components.settings.mcpSettings.validation.createFailed'))
      }
    } else if (editingServer.value) {
      // 更新服务器
      const updates = {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        transport,
        enabled: formData.enabled,
        autoConnect: formData.autoConnect,
        timeout: formData.timeout,
        cleanSchema: formData.cleanSchema
      }
      
      const response = await sendToExtension<{ success: boolean; error?: any }>(MESSAGE_NAMES.updateMcpServer, {
        serverId: editingServer.value.id,
        updates
      })
      if (!response?.success) {
        throw new Error(response?.error?.message || t('components.settings.mcpSettings.validation.updateFailed'))
      }
    }
    
    // 返回列表并刷新
    viewMode.value = 'list'
    await loadServers()
  } catch (error: any) {
    saveError.value = error.message || '保存失败'
  } finally {
    isSaving.value = false
  }
}

// 显示删除确认对话框
function showDeleteDialog(server: McpServerInfo) {
  deleteTargetServer.value = server
  showDeleteConfirm.value = true
}

// 确认删除服务器
async function confirmDeleteServer() {
  if (!deleteTargetServer.value) return
  
  try {
    const response = await sendToExtension<{ success: boolean; error?: any }>(MESSAGE_NAMES.deleteMcpServer, {
      serverId: deleteTargetServer.value.config.id
    })
    if (response?.success) {
      await loadServers()
    }
  } catch (error) {
    console.error('Failed to delete server:', error)
  }
}

// 获取服务器的显示状态（考虑本地 connecting 状态）
function getDisplayStatus(server: McpServerInfo): McpServerStatus {
  if (connectingServers.value.has(server.config.id)) {
    return 'connecting'
  }
  return server.status
}

// 连接/断开服务器
async function toggleConnection(server: McpServerInfo) {
  const serverId = server.config.id
  try {
    connectionError.value = ''
    if (server.status === 'connected') {
      await sendToExtension(MESSAGE_NAMES.disconnectMcpServer, { serverId })
    } else {
      // 立即显示连接中状态
      connectingServers.value.add(serverId)
      await sendToExtension(MESSAGE_NAMES.connectMcpServer, { serverId })
    }
    await loadServers()
  } catch (error: any) {
    console.error('Failed to toggle connection:', error)
    // 失败时展示错误消息（不再仅 console.error）
    connectionError.value = t('errors.connectionFailed') + (error?.message ? `: ${error.message}` : '')
  } finally {
    // 移除连接中状态
    connectingServers.value.delete(serverId)
  }
}

// 切换启用状态
async function toggleEnabled(server: McpServerInfo) {
  const serverId = server.config.id
  const newEnabled = !server.config.enabled
  
  try {
    await sendToExtension(MESSAGE_NAMES.setMcpServerEnabled, {
      serverId,
      enabled: newEnabled
    })
    
    await loadServers()
    
    if (newEnabled && server.config.autoConnect) {
      const updatedServer = servers.value.find(s => s.config.id === serverId)
      if (updatedServer && updatedServer.status === 'disconnected') {
        tryAutoConnect(updatedServer)
      }
    }
    
  } catch (error) {
    console.error('Failed to toggle enabled:', error)
  }
}

// 打开 JSON 配置文件（在 VSCode 编辑器中）
async function openConfigFile() {
  try {
    await sendToExtension(MESSAGE_NAMES.openMcpConfigFile, {})
  } catch (error) {
    console.error('Failed to open config file:', error)
  }
}

// 初始化
onMounted(() => {
  loadServers()
})

onUnmounted(() => {
  // 清理在途的 ID 校验防抖计时器
  resetIdValidation()
})
</script>

<template>
  <div class="mcp-settings">
    <!-- 列表视图 -->
    <div v-if="viewMode === 'list'" class="mcp-list-view">
      <!-- 工具栏 -->
      <div class="mcp-toolbar" data-search-anchor="mcp-toolbar">
        <button class="toolbar-btn primary" @click="startCreate">
          <i class="codicon codicon-add"></i>
          <span>{{ t('components.settings.mcpSettings.toolbar.addServer') }}</span>
        </button>
        <button class="toolbar-btn" @click="openConfigFile">
          <i class="codicon codicon-json"></i>
          <span>{{ t('components.settings.mcpSettings.toolbar.editJson') }}</span>
        </button>
        <button class="toolbar-btn" @click="loadServers()" :disabled="isLoading" :title="t('components.settings.mcpSettings.toolbar.refresh')">
          <i class="codicon" :class="isLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'"></i>
        </button>
      </div>
      
      <!-- 连接/断开操作错误提示 -->
      <div v-if="connectionError" class="form-error" style="margin-bottom: 8px;">
        <i class="codicon codicon-error"></i>
        {{ connectionError }}
      </div>
      
      <!-- 服务器列表 -->
      <div v-if="isLoading && !hasServers" class="loading-state">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        <span>{{ t('components.settings.mcpSettings.loading') }}</span>
      </div>
      
      <div v-else-if="!hasServers" class="empty-state">
        <div class="empty-icon">
          <i class="codicon codicon-plug"></i>
        </div>
        <h4>{{ t('components.settings.mcpSettings.empty.title') }}</h4>
        <p>{{ t('components.settings.mcpSettings.empty.description') }}</p>
      </div>
      
      <div v-else class="server-list" data-search-anchor="mcp-server-list">
        <div
          v-for="server in servers"
          :key="server.config.id"
          class="server-card"
          :class="{ disabled: !server.config.enabled }"
        >
          <div class="server-checkbox">
            <CustomCheckbox
              :model-value="server.config.enabled"
              @update:model-value="toggleEnabled(server)"
            />
          </div>
          <div class="server-content">
            <div class="server-header">
              <div class="server-info">
                <div class="server-name">{{ server.config.name }}</div>
                <div class="server-type">
                  <span class="transport-badge">{{ server.config.transport.type.toUpperCase() }}</span>
                  <span class="status-dot" :style="{ backgroundColor: statusColor(getDisplayStatus(server)) }"></span>
                  <span class="status-text">{{ statusText(getDisplayStatus(server)) }}</span>
                </div>
              </div>
              <div class="server-actions">
                <button
                  class="action-btn"
                  :title="getDisplayStatus(server) === 'connected' ? t('components.settings.mcpSettings.serverCard.disconnect') : getDisplayStatus(server) === 'connecting' ? t('components.settings.mcpSettings.serverCard.connecting') : t('components.settings.mcpSettings.serverCard.connect')"
                  @click="toggleConnection(server)"
                  :disabled="!server.config.enabled || getDisplayStatus(server) === 'connecting'"
                >
                  <i class="codicon" :class="getDisplayStatus(server) === 'connected' ? 'codicon-debug-disconnect' : getDisplayStatus(server) === 'connecting' ? 'codicon-loading codicon-modifier-spin' : 'codicon-plug'"></i>
                </button>
                <button class="action-btn" :title="t('components.settings.mcpSettings.serverCard.edit')" @click="startEdit(server)">
                  <i class="codicon codicon-edit"></i>
                </button>
                <button class="action-btn danger" :title="t('components.settings.mcpSettings.serverCard.delete')" @click="showDeleteDialog(server)">
                  <i class="codicon codicon-trash"></i>
                </button>
              </div>
            </div>
            
            <div v-if="server.config.description" class="server-description">
              {{ server.config.description }}
            </div>
            
            <div class="server-details">
              <template v-if="server.config.transport.type === 'stdio'">
                <code class="transport-detail">{{ server.config.transport.command }}</code>
              </template>
              <template v-else>
                <code class="transport-detail">{{ server.config.transport.url }}</code>
              </template>
            </div>
            
            <!-- 能力显示 -->
            <div v-if="server.capabilities && server.status === 'connected'" class="server-capabilities">
              <span v-if="server.capabilities.tools?.length" class="capability-badge">
                <i class="codicon codicon-tools"></i>
                {{ server.capabilities.tools.length }} {{ t('components.settings.mcpSettings.serverCard.tools') }}
              </span>
              <span v-if="server.capabilities.resources?.length" class="capability-badge">
                <i class="codicon codicon-file"></i>
                {{ server.capabilities.resources.length }} {{ t('components.settings.mcpSettings.serverCard.resources') }}
              </span>
              <span v-if="server.capabilities.prompts?.length" class="capability-badge">
                <i class="codicon codicon-comment"></i>
                {{ server.capabilities.prompts.length }} {{ t('components.settings.mcpSettings.serverCard.prompts') }}
              </span>
            </div>
            
            <div v-if="server.lastError" class="server-error">
              <i class="codicon codicon-error"></i>
              {{ server.lastError }}
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 编辑视图 -->
    <div v-else-if="viewMode === 'edit'" class="mcp-edit-view">
      <div class="edit-header">
        <h4>{{ isCreating ? t('components.settings.mcpSettings.form.addTitle') : t('components.settings.mcpSettings.form.editTitle') }}</h4>
        <button class="close-btn" @click="cancelEdit">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
      
      <div class="edit-form">
        <!-- 基本信息 -->
        <div class="form-section" data-search-anchor="mcp-basic-info">
          <!-- 自定义 ID（仅创建时显示） -->
          <div v-if="isCreating" class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.serverId') }}</label>
            <div class="id-input-wrapper">
              <input
                type="text"
                v-model="formData.customId"
                :placeholder="t('components.settings.mcpSettings.form.serverIdPlaceholder')"
                class="form-input"
                :class="{
                  'input-error': idValidation.valid === false,
                  'input-success': idValidation.valid === true
                }"
                @input="onIdInput"
              />
              <span v-if="idValidation.checking" class="id-status checking">
                <i class="codicon codicon-loading codicon-modifier-spin"></i>
              </span>
              <span v-else-if="idValidation.valid === true" class="id-status valid">
                <i class="codicon codicon-check"></i>
              </span>
              <span v-else-if="idValidation.valid === false" class="id-status invalid">
                <i class="codicon codicon-error"></i>
              </span>
            </div>
            <div v-if="idValidation.error" class="id-error">{{ idValidation.error }}</div>
            <div class="form-hint">{{ t('components.settings.mcpSettings.form.serverIdHint') }}</div>
          </div>
          
          <!-- 显示当前 ID（编辑时） -->
          <div v-else class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.serverId') }}</label>
            <div class="id-display">{{ editingServer?.id }}</div>
          </div>
          
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.serverName') }} <span class="required">{{ t('components.settings.mcpSettings.form.required') }}</span></label>
            <input
              type="text"
              v-model="formData.name"
              :placeholder="t('components.settings.mcpSettings.form.serverNamePlaceholder')"
              class="form-input"
            />
          </div>
          
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.description') }}</label>
            <input
              type="text"
              v-model="formData.description"
              :placeholder="t('components.settings.mcpSettings.form.descriptionPlaceholder')"
              class="form-input"
            />
          </div>
        </div>
        
        <!-- 传输类型 -->
        <div class="form-section" data-search-anchor="mcp-transport-type">
          <label class="section-label">{{ t('components.settings.mcpSettings.form.transportType') }}</label>
          <div class="transport-tabs">
            <button
              :class="['transport-tab', { active: formData.transportType === 'stdio' }]"
              @click="selectTransportType('stdio')"
            >
              <i class="codicon codicon-terminal"></i>
              Stdio
            </button>
            <button
              :class="['transport-tab', { active: formData.transportType === 'sse' }]"
              @click="selectTransportType('sse')"
            >
              <i class="codicon codicon-radio-tower"></i>
              SSE
            </button>
            <button
              :class="['transport-tab', { active: formData.transportType === 'streamable-http' }]"
              @click="selectTransportType('streamable-http')"
            >
              <i class="codicon codicon-globe"></i>
              Streamable HTTP
            </button>
          </div>
        </div>
        
        <!-- Stdio 配置 -->
        <div v-if="formData.transportType === 'stdio'" class="form-section" data-search-anchor="mcp-stdio-config">
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.command') }} <span class="required">{{ t('components.settings.mcpSettings.form.required') }}</span></label>
            <input
              type="text"
              v-model="formData.command"
              :placeholder="t('components.settings.mcpSettings.form.commandPlaceholder')"
              class="form-input"
            />
          </div>
          
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.args') }}</label>
            <input
              type="text"
              v-model="formData.args"
              :placeholder="t('components.settings.mcpSettings.form.argsPlaceholder')"
              class="form-input"
            />
          </div>
          
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.env') }}</label>
            <textarea
              v-model="formData.env"
              :placeholder="t('components.settings.mcpSettings.form.envPlaceholder')"
              class="form-textarea"
              rows="3"
            ></textarea>
          </div>
        </div>
        
        <!-- SSE/WebSocket 配置 -->
        <div v-else class="form-section" data-search-anchor="mcp-url-config">
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.url') }} <span class="required">{{ t('components.settings.mcpSettings.form.required') }}</span></label>
            <input
              type="text"
              v-model="formData.url"
              :placeholder="formData.transportType === 'sse' ? t('components.settings.mcpSettings.form.urlPlaceholderSse') : t('components.settings.mcpSettings.form.urlPlaceholderHttp')"
              class="form-input"
            />
          </div>
          
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.headers') }}</label>
            <textarea
              v-model="formData.headers"
              :placeholder="t('components.settings.mcpSettings.form.headersPlaceholder')"
              class="form-textarea"
              rows="3"
            ></textarea>
          </div>
        </div>
        
        <!-- 选项 -->
        <div class="form-section" data-search-anchor="mcp-options">
          <label class="section-label">{{ t('components.settings.mcpSettings.form.options') }}</label>
          
          <div class="form-row">
            <CustomCheckbox
              v-model="formData.enabled"
              :label="t('components.settings.mcpSettings.form.enabled')"
            />
            
            <CustomCheckbox
              v-model="formData.autoConnect"
              :label="t('components.settings.mcpSettings.form.autoConnect')"
            />
          </div>
          
          <div class="form-row">
            <CustomCheckbox
              v-model="formData.cleanSchema"
              :label="t('components.settings.mcpSettings.form.cleanSchema')"
            />
          </div>
          <div class="form-hint" style="margin-top: -8px; margin-bottom: 12px;">
            {{ t('components.settings.mcpSettings.form.cleanSchemaHint') }}
          </div>
          
          <div class="form-group">
            <label>{{ t('components.settings.mcpSettings.form.timeout') }}</label>
            <input
              type="number"
              v-model.number="formData.timeout"
              class="form-input"
              min="1000"
              max="300000"
            />
          </div>
        </div>
        
        <!-- 错误信息 -->
        <div v-if="saveError" class="form-error">
          <i class="codicon codicon-error"></i>
          {{ saveError }}
        </div>
        
        <!-- 操作按钮 -->
        <div class="form-actions">
          <button class="action-button secondary" @click="cancelEdit">
            {{ t('components.settings.mcpSettings.form.cancel') }}
          </button>
          <button
            class="action-button primary"
            @click="saveServer"
            :disabled="isSaving"
          >
            <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
            <span v-else>{{ isCreating ? t('components.settings.mcpSettings.form.create') : t('components.settings.mcpSettings.form.save') }}</span>
          </button>
        </div>
      </div>
    </div>
    
    <!-- 删除确认对话框 -->
    <ConfirmDialog
      v-model="showDeleteConfirm"
      :title="t('components.settings.mcpSettings.delete.title')"
      :message="t('components.settings.mcpSettings.delete.message', { name: deleteTargetServer?.config.name || '' })"
      :confirm-text="t('components.settings.mcpSettings.delete.confirm')"
      :cancel-text="t('components.settings.mcpSettings.delete.cancel')"
      :is-danger="true"
      @confirm="confirmDeleteServer"
    />
  </div>
</template>

<style scoped>
.mcp-settings {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 工具栏 */
.mcp-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.toolbar-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.toolbar-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.toolbar-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.toolbar-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

/* 加载和空状态 */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

.loading-state {
  flex-direction: row;
  gap: 8px;
}

.empty-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-button-background);
  border-radius: 50%;
  margin-bottom: 16px;
}

.empty-icon .codicon {
  font-size: 28px;
  color: var(--vscode-button-foreground);
}

.empty-state h4 {
  margin: 0 0 8px 0;
  color: var(--vscode-foreground);
}

.empty-state p {
  margin: 0;
  font-size: 13px;
}

/* 服务器列表 */
.server-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-card {
  display: flex;
  align-items: center;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  padding: 12px 16px;
  transition: border-color 0.15s;
}

.server-card:hover {
  border-color: var(--vscode-focusBorder);
}

.server-card.disabled {
  opacity: 0.6;
}

.server-checkbox {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-right: 12px;
}

.server-content {
  flex: 1;
  min-width: 0;
}

.server-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
}

.server-type {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.transport-badge {
  padding: 2px 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-text {
  color: var(--vscode-descriptionForeground);
}

.server-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s, background-color 0.15s;
}

.action-btn:hover:not(:disabled) {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.action-btn.danger:hover:not(:disabled) {
  color: var(--vscode-errorForeground);
}

.server-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 8px;
}

.server-details {
  margin-bottom: 8px;
}

.transport-detail {
  font-size: 11px;
  padding: 4px 8px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  color: var(--vscode-foreground);
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-capabilities {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.capability-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
}

.capability-badge .codicon {
  font-size: 12px;
}

.server-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 8px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

/* 编辑视图 */
.mcp-edit-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.edit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.edit-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-foreground);
  cursor: pointer;
}

.close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.edit-form {
  flex: 1;
  overflow-y: auto;
}

.form-section {
  margin-bottom: 20px;
}

.section-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
  margin-bottom: 8px;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
}

.form-group label .required {
  color: var(--vscode-errorForeground);
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus,
.form-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.form-textarea {
  resize: vertical;
  font-family: var(--vscode-editor-font-family), monospace;
}

/* ID 输入相关样式 */
.id-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.id-input-wrapper .form-input {
  padding-right: 32px;
}

.id-status {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.id-status.checking {
  color: var(--vscode-descriptionForeground);
}

.id-status.valid {
  color: var(--vscode-terminal-ansiGreen);
}

.id-status.invalid {
  color: var(--vscode-errorForeground);
}

.id-error {
  font-size: 11px;
  color: var(--vscode-errorForeground);
  margin-top: 4px;
}

.id-display {
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
}

.form-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
}

.form-input.input-error {
  border-color: var(--vscode-inputValidation-errorBorder);
}

.form-input.input-success {
  border-color: var(--vscode-terminal-ansiGreen);
}

/* 隐藏数字输入框的上下箭头 */
input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.transport-tabs {
  display: flex;
  gap: 4px;
}

.transport-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.transport-tab:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.transport-tab.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.form-row {
  display: flex;
  gap: 24px;
  margin-bottom: 12px;
}

.form-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.action-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 80px;
  padding: 8px 16px;
  font-size: 13px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.action-button.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.action-button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.action-button.secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.action-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
