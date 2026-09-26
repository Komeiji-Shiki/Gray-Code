<script setup lang="ts">
/**
 * InputArea - 输入区容器
 * 负责把编辑器(InputBox)与外部能力(配置/模型/文件读取/VSCode预览)编排在一起。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted, watch, nextTick, onBeforeUnmount } from 'vue'
import InputBox from './InputBox.vue'
import FilePickerPanel from './FilePickerPanel.vue'
import SendButton from './SendButton.vue'
import MessageQueue from './MessageQueue.vue'
import InputAttachments from './InputAttachments.vue'
import PinnedFilesWidget from './PinnedFilesWidget.vue'
import SkillsWidget from './SkillsWidget.vue'
import TpsBar from './TpsBar.vue'
import BranchTreePanel from '../message/BranchTreePanel.vue'
import InputSelectorBar from './InputSelectorBar.vue'
import ChannelSetupNotice, { type ChannelSetupStatus } from './ChannelSetupNotice.vue'
import ContextDetailDialog from './ContextDetailDialog.vue'
import PromptPreviewDialog from './PromptPreviewDialog.vue'
import type { ChannelOption, PromptMode } from './types'

import { IconButton, Tooltip } from '../common'
import { useChatStore, useSettingsStore } from '../../stores'
import { sendToExtension, showNotification, onExtensionCommand } from '../../utils/vscode'
import * as configService from '../../services/config'
import * as contextService from '../../services/context'
import { formatNumber, generateId } from '../../utils/format'
import { languageFromPath } from '../../utils/languageFromPath'
import { resolveWorkspaceItems } from '../../utils/resolveWorkspaceItems'
import { getFileType } from '../../utils/file'
import type { Attachment, ChannelConfig } from '../../types'
import type { PromptContextItem } from '../../types/promptContext'
import type { EditorNode } from '../../types/editorNode'
import { createTextNode, getPlainText, getContexts, serializeNodes } from '../../types/editorNode'
import { useI18n } from '../../i18n'
import { isAgentMessageRoundPending } from '../../stores/chat/agentMessageClaimGate'
import type { ProviderDefinition } from '../../../../packages/contracts/src/providers'
import { reasoningLevelsForModel } from '../../../../shared/reasoningEffort'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()

const props = defineProps<{
  uploading?: boolean
  placeholder?: string
  attachments?: Attachment[]
}>()

const emit = defineEmits<{
  send: [content: string, attachments: Attachment[], options?: { dynamicContextStrategyOverride?: 'single' | 'preserve'; deepSeekVisionTileSplit?: boolean }, onResult?: (ok: boolean) => void]
  cancel: []
  clearAttachments: []
  attachFile: []
  removeAttachment: [id: string]
  pasteFiles: [files: File[]]
}>()

const isComposing = ref(false)

// 编辑器节点数组（从 store 读写，实现对话级隔离）
const editorNodes = computed({
  get: () => chatStore.editorNodes,
  set: (nodes: EditorNode[]) => chatStore.setEditorNodes(nodes)
})

// 同一 InputBox DOM 会承载多个标签页/对话；撤销历史必须随编辑会话切换边界。
const editorUndoScope = computed(() =>
  `${chatStore.activeTabId ?? 'unbound-tab'}:${chatStore.currentConversationId ?? 'draft'}`
)

// 当 store 中的 inputValue 被外部设置（如恢复快照）但 editorNodes 为空时，从文本创建节点
watch(() => chatStore.inputValue, (val) => {
  if (val && chatStore.editorNodes.length === 0) {
    chatStore.setEditorNodes([createTextNode(val)])
  }
}, { immediate: true })

// 反向同步：editorNodes 变化时更新纯文本 inputValue
// 浅比较：store 的 setEditorNodes 每次整体替换数组引用（每键击换新数组），
// 深 watch 会逐节点递归遍历，纯属浪费
watch(() => chatStore.editorNodes, (nodes) => {
  chatStore.setInputValue(getPlainText(nodes))
})

// ========== Configs / Modes ==========

const configs = ref<ChannelConfig[]>([])
const reasoningProfiles = ref<ProviderDefinition[]>([])
const isLoadingConfigs = ref(true)
const configsLoadError = ref('')
let configLoadGeneration = 0

const promptModes = ref<PromptMode[]>([])

const channelOptions = computed<ChannelOption[]>(() =>
  configs.value
    .filter(config => config.enabled !== false)
    .map(config => ({
      id: config.id,
      name: config.name,
      model: config.model || '',
      type: config.type
    }))
)

const modeOptions = computed<PromptMode[]>(() => promptModes.value)

const currentConfig = computed(() => configs.value.find(c => c.id === chatStore.configId))
const currentModel = computed(() => chatStore.selectedModelId || currentConfig.value?.model || '')
const currentModels = computed(() => currentConfig.value?.models || [])
const currentReasoningLevels = computed(() => {
  const profile = reasoningProfiles.value.find(item => item.id === chatStore.configId)
  return profile ? reasoningLevelsForModel(profile, currentModel.value) : []
})
const channelSetupStatus = computed<ChannelSetupStatus>(() => {
  if (isLoadingConfigs.value && !configs.value.length) return 'loading'
  if (configsLoadError.value) return 'error'
  if (!configs.value.length) return 'empty'
  if (!channelOptions.value.length) return 'disabled'
  if (!currentConfig.value) return 'channel'
  if (!currentModel.value) return currentModels.value.length ? 'model' : 'models'
  return 'ready'
})

async function loadConfigs() {
  const generation = ++configLoadGeneration
  isLoadingConfigs.value = true
  configsLoadError.value = ''
  try {
    const [ids, platformSettings] = await Promise.all([
      configService.listConfigIds(),
      window.__GRAYCODE_HOST ? sendToExtension<{ providers: ProviderDefinition[] }>('platform.settings.get', {}) : Promise.resolve(undefined)
    ])
    // 并行拉取全部渠道配置（原为串行 N 次 IPC，渠道多时首屏线性变慢）；
    // 单条失败仅跳过该条并告警，不拖垮整批（保留单条失败容忍语义）
    let firstError = ''
    const results = await Promise.all(ids.map(async (id) => {
      try {
        return await configService.getConfig(id)
      } catch (error) {
        console.warn(`Failed to load config ${id}:`, error)
        firstError ||= error instanceof Error ? error.message : String(error)
        return null
      }
    }))
    if (generation !== configLoadGeneration) return
    reasoningProfiles.value = platformSettings?.providers ?? []
    configs.value = results.filter((c): c is ChannelConfig => !!c)
    configsLoadError.value = firstError
  } catch (error) {
    console.error('Failed to load configs:', error)
    if (generation === configLoadGeneration) configsLoadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (generation === configLoadGeneration) isLoadingConfigs.value = false
  }
}

async function loadPromptModes() {
  try {
    const result = await configService.getPromptModes()
    if (result) {
      promptModes.value = result.modes
      // 动态上下文策略由后端按当前模式/全局配置解析；普通发送不从这里下发覆盖值。
    }
  } catch (error) {
    console.error('Failed to load prompt modes:', error)
  }
}

async function handleModeChange(modeId: string) {
  try {
    await chatStore.setCurrentPromptModeId(modeId)
  } catch (error) {
    console.error('Failed to change mode:', error)
  }
}

function openModeSettings() {
  settingsStore.showSettings('prompt')
}

async function handleChannelChange(channelId: string) {
  try {
    await chatStore.setConfigId(channelId)
  } catch (error) {
    console.error('Failed to change channel:', error)
    await showNotification(error instanceof Error ? error.message : t('common.error'), 'error')
  }
}

async function handleModelChange(modelId: string) {
  if (!chatStore.configId) return
  try {
    await chatStore.setSelectedModelId(modelId)
  } catch (error) {
    console.error('Failed to change model:', error)
    await showNotification(error instanceof Error ? error.message : t('common.error'), 'error')
  }
}

async function handleReasoningChange(effort: string) {
  try { await chatStore.setSelectedReasoningEffort(effort) }
  catch (error) { await showNotification(error instanceof Error ? error.message : t('common.error'), 'error') }
}

// ========== Send / Cancel ==========

const hasAttachments = computed(() => (props.attachments?.length || 0) > 0)

const canSend = computed(() => {
  if (!currentModel.value) return false

  const plainText = getPlainText(editorNodes.value).trim()
  const hasContexts = getContexts(editorNodes.value).length > 0
  const hasContent = plainText.length > 0 || hasContexts || (props.attachments?.length || 0) > 0

  // 允许在 AI 响应期间输入（会入队）；有待确认工具时同样允许发送（发送即中断当前回合）。
  // 注意：上传中（props.uploading）一律禁用，含待确认工具场景。
  return hasContent && !props.uploading
})

function handleSend(options?: { dynamicContextStrategyOverride?: 'single' | 'preserve' }) {
  if (!canSend.value) return

  const content = serializeNodes(editorNodes.value).trim()
  const currentAttachments = props.attachments || []
  const sendOptions = options?.dynamicContextStrategyOverride ? { dynamicContextStrategyOverride: options.dynamicContextStrategyOverride } : undefined

  // 备份本次发送的正文节点：直接发送是异步的（父组件 await sendMessage 后才回报结果），
  // 发送失败（忙时投递拒绝带附件消息 / IPC 异常）时用备份恢复输入，避免正文静默丢失。
  const pendingNodes = editorNodes.value
  const originTabId = chatStore.activeTabId

  // 发送结果回调：仅处理失败恢复。成功/清空仍走下方同步路径（点击即清空，
  // 避免发送窗口内重复点击双发）；失败且用户尚未开始输入新内容时把正文节点恢复回输入框
  // （附件由父组件在失败分支恢复；inputValue 由下方 editorNodes 反向同步 watch 自动更新）。
  const onSendResult = (ok: boolean) => {
    if (ok) return
    if (chatStore.activeTabId === originTabId) {
      if (editorNodes.value.length === 0) editorNodes.value = pendingNodes
    } else if (originTabId) {
      const snapshot = chatStore.sessionSnapshots.get(originTabId)
      if (snapshot && snapshot.editorNodes.length === 0) {
        snapshot.editorNodes = pendingNodes
        snapshot.inputValue = getPlainText(pendingNodes)
      }
    }
  }

  // 智能决策：AI 空闲且队列为空时直接发送，否则入队。
  // A-COMM 接管窗口（后台结果领取后内部回流流即将启动）：视为忙碌入队——
  // 窗口内的插话会被内部回流流误消费且不落历史，用户消息应走正常回合排队。
  const agentMessageRoundPending = isAgentMessageRoundPending(chatStore.currentConversationId)
  if (!chatStore.isWaitingForResponse && chatStore.messageQueue.length === 0 && !agentMessageRoundPending) {
    // 直接发送
    emit('send', content, currentAttachments, sendOptions, onSendResult)
  } else {
    // 加入候选区队列
    // 如果有工具待确认，仍走直接发送路径（发送即中断当前回合，不入队滞留）
    if (chatStore.hasPendingToolConfirmation) {
      emit('send', content, currentAttachments, sendOptions, onSendResult)
    } else {
      chatStore.enqueueMessage(content, currentAttachments, sendOptions)
      // 入队后清空附件（通知父组件）
      emit('clearAttachments')
    }
  }

  editorNodes.value = []
  chatStore.clearInputValue()
}

function handlePreserveDynamicContextSend() {
  handleSend({ dynamicContextStrategyOverride: 'preserve' })
}


function handleCancel() {
  emit('cancel')
}

function handleNodesUpdate(nodes: EditorNode[]) {
  editorNodes.value = nodes
}

function handleAttachFile() {
  emit('attachFile')
}

function handleRemoveAttachment(id: string) {
  emit('removeAttachment', id)
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  isComposing.value = false
}

function handlePasteFiles(files: File[]) {
  emit('pasteFiles', files)
}

async function previewAttachment(attachment: Attachment) {
  if (!attachment.data) return

  try {
    await contextService.previewAttachment(attachment, props.attachments || [])
  } catch (error) {
    console.error('预览附件失败:', error)
  }
}

// ========== @ file picker ==========

const showFilePicker = ref(false)
const filePickerQuery = ref('')
const inputBoxRef = ref<InstanceType<typeof InputBox> | null>(null)
const filePickerRef = ref<InstanceType<typeof FilePickerPanel> | null>(null)

let unsubscribeAddContext: (() => void) | null = null
let unsubscribeConfigChanged: (() => void) | null = null

function handleTriggerAtPicker(query: string, _triggerPosition: number) {
  filePickerQuery.value = query
  showFilePicker.value = true
}

function handleAtQueryChange(query: string) {
  filePickerQuery.value = query
}

function handleCloseAtPicker() {
  showFilePicker.value = false
  filePickerQuery.value = ''
  inputBoxRef.value?.closeAtPicker()
}

function normalizeDirectoryPath(path: string): string {
  const normalized = (path || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '')
  if (!normalized) return ''
  return `${normalized}/`
}

type InputDraftTarget = { tabId: string | null; conversationId: string | null }

function captureInputDraft(): InputDraftTarget {
  return { tabId: chatStore.activeTabId, conversationId: chatStore.currentConversationId }
}

function resolveInputDraft(target: InputDraftTarget) {
  if (chatStore.activeTabId === target.tabId && chatStore.currentConversationId === target.conversationId) return chatStore
  const snapshot = target.tabId ? chatStore.sessionSnapshots.get(target.tabId) : undefined
  return snapshot?.conversationId === target.conversationId ? snapshot : undefined
}

function insertDraftContext(context: PromptContextItem, target: InputDraftTarget) {
  const draft = resolveInputDraft(target)
  if (!draft || getContexts(draft.editorNodes).some(item => item.filePath === context.filePath)) return
  if (draft === chatStore) inputBoxRef.value?.insertContextAtCaret(context)
  else {
    draft.editorNodes = [...draft.editorNodes, { type: 'context', context }]
    draft.inputValue = getPlainText(draft.editorNodes)
  }
}

function hasContextWithPath(path: string, target: InputDraftTarget): boolean {
  const key = (path || '').replace(/\/+$/g, '')
  if (!key) return false
  const draft = resolveInputDraft(target)
  return !!draft && getContexts(draft.editorNodes).some(item => ((item.filePath || '').replace(/\/+$/g, '') === key))
}

function addDirectoryContextByPath(path: string, target: InputDraftTarget) {
  const dirPath = normalizeDirectoryPath(path)
  if (!dirPath) return
  if (hasContextWithPath(dirPath, target)) return

  const contextItem: PromptContextItem = {
    id: `dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'file',
    title: dirPath,
    content: '',
    filePath: dirPath,
    isTextContent: false,
    enabled: true,
    addedAt: Date.now()
  }

  insertDraftContext(contextItem, target)
}

const AUTO_UPLOAD_NON_TEXT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf'
])

function shouldAutoUploadBinaryAttachment(payload?: contextService.WorkspaceInputFileAttachmentPayload): boolean {
  if (!payload?.data) return false
  const mime = (payload.mimeType || '').toLowerCase()
  if (AUTO_UPLOAD_NON_TEXT_MIME_TYPES.has(mime)) return true
  if (mime.startsWith('audio/')) return true
  if (mime.startsWith('video/')) return true
  return false
}

async function addFileContextByPath(path: string, options?: { autoUploadBinaryAttachment?: boolean }, target = captureInputDraft()) {
  // Skip directories
  if (path.endsWith('/')) return

  const draft = resolveInputDraft(target)
  if (!draft || hasContextWithPath(path, target)) return
  // 已保存会话由后端按其工作区读取；空白草稿切走后没有会话标识可定位工作区。
  if (!target.conversationId && draft !== chatStore) return

  const addWorkspaceAttachment = (relativePath: string, payload?: contextService.WorkspaceInputFileAttachmentPayload) => {
    if (!payload?.data) return

    const draft = resolveInputDraft(target)
    if (!draft) return
    const attachments = 'storeAttachments' in draft ? draft.storeAttachments : draft.attachments
    const existsAttachment = attachments.some(att => att.metadata?.sourcePath === relativePath)
    if (existsAttachment) return

    const attachment: Attachment = {
      id: generateId(),
      name: payload.name || relativePath.split('/').pop() || relativePath,
      type: getFileType(payload.mimeType || 'application/octet-stream'),
      size: payload.size || 0,
      mimeType: payload.mimeType || 'application/octet-stream',
      data: payload.data,
      metadata: {
        sourcePath: relativePath
      }
    }

    attachments.push(attachment)
  }

  try {
    const result = await contextService.readWorkspaceFileForInput(path, target.conversationId)
    if (!resolveInputDraft(target)) return

    if (!result?.success) {
      await showNotification(result?.error || t('components.input.promptContext.readFailed'), 'error')
      return
    }

    const isTextContent = result.isText !== false
    if (!isTextContent) {
      if (options?.autoUploadBinaryAttachment && shouldAutoUploadBinaryAttachment(result.attachment)) {
        addWorkspaceAttachment(result.path || path, result.attachment)
      }
    }


    const contextItem: PromptContextItem = {
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'file',
      title: result.path || path,
      content: isTextContent ? (result.content || '') : '',
      filePath: result.path || path,
      isTextContent,
      enabled: true,
      addedAt: Date.now()
    }

    insertDraftContext(contextItem, target)
  } catch (error: any) {
    console.error('Failed to add file context:', error)
    await showNotification(t('components.input.promptContext.addFailed', { error: error.message || t('common.unknownError') }), 'error')
  }
}

async function handleSelectFile(path: string, asText: boolean = false) {
  const target = captureInputDraft()
  showFilePicker.value = false
  filePickerQuery.value = ''

  if (asText || path.endsWith('/')) {
    inputBoxRef.value?.replaceAtTriggerWithText(` @${path} `)
    nextTick(() => inputBoxRef.value?.focus())
    return
  }

  inputBoxRef.value?.replaceAtTriggerWithText('')
  await addFileContextByPath(path, undefined, target)

  nextTick(() => { if (resolveInputDraft(target) === chatStore) inputBoxRef.value?.focus() })
}

function handleAtPickerKeydown(key: string) {
  if (!showFilePicker.value || !filePickerRef.value) return

  // 直接调用面板暴露的语义化 API（moveHighlight/confirmSelection），
  // 不再构造假 KeyboardEvent 传给子组件
  if (key === 'ArrowUp') {
    filePickerRef.value.moveHighlight(-1)
  } else if (key === 'ArrowDown') {
    filePickerRef.value.moveHighlight(1)
  } else if (key === 'Enter') {
    filePickerRef.value.confirmSelection()
  }
}

// ========== contexts from editor ==========

function handleRemovePromptContextItem(id: string) {
  editorNodes.value = editorNodes.value.filter(node => !(node.type === 'context' && node.context.id === id))
}

async function handleAddFileContexts(files: { path: string; isDirectory: boolean }[], options: { allowDirectoryBadge?: boolean }, target: InputDraftTarget) {
  const inserted = new Set<string>()

  for (const file of files) {
    if (!resolveInputDraft(target)) return
    const key = file.isDirectory ? normalizeDirectoryPath(file.path) : file.path
    if (!key) continue
    if (inserted.has(key)) continue
    inserted.add(key)

    if (file.isDirectory) {
      if (options?.allowDirectoryBadge) {
        addDirectoryContextByPath(file.path, target)
      }
      continue
    }

    await addFileContextByPath(file.path, { autoUploadBinaryAttachment: true }, target)
  }

  nextTick(() => { if (resolveInputDraft(target) === chatStore) inputBoxRef.value?.focus() })
}

async function handleDropFileItems(
  items: string[],
  insertAsTextPath: boolean,
  dragMeta?: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }
) {
  const target = captureInputDraft()
  const resolved = await resolveWorkspaceItems(items, target.conversationId)
  if (resolved.length === 0) return
  const draft = resolveInputDraft(target)
  if (!draft) return

  if (insertAsTextPath) {
    if (draft === chatStore) {
      inputBoxRef.value?.insertPathsAsAtText(resolved)
      nextTick(() => { if (resolveInputDraft(target) === chatStore) inputBoxRef.value?.focus() })
    } else {
      const text = resolved.map(file => ` @${file.isDirectory ? normalizeDirectoryPath(file.path) : file.path} `).join('')
      draft.editorNodes = [...draft.editorNodes, createTextNode(text)]
      draft.inputValue = getPlainText(draft.editorNodes)
    }
    return
  }

  const allowDirectoryBadge = !!dragMeta?.shiftKey && !insertAsTextPath
  await handleAddFileContexts(resolved, { allowDirectoryBadge }, target)
}

async function handleOpenContext(ctx: PromptContextItem) {
  if (ctx.isTextContent === false && ctx.filePath) {
    try {
      await sendToExtension(MESSAGE_NAMES.openWorkspaceFile, { path: ctx.filePath })
    } catch (error) {
      console.error('Failed to open workspace file:', error)
    }
    return
  }

  try {
    await contextService.showContextContent({
      title: ctx.title,
      content: ctx.content,
      language: ctx.language || languageFromPath(ctx.filePath) || 'plaintext'
    })
  } catch (error) {
    console.error('Failed to show context content:', error)
  }
}

// ========== summarize + token ring ==========

const isSummarizing = computed(() => !!chatStore.autoSummaryStatus?.isSummarizing)

async function handleSummarize() {
  if (isSummarizing.value || chatStore.isWaitingForResponse) return

  try {
    const result = await chatStore.summarizeContext()

    if (!result.success && result.errorCode !== 'ABORTED') {
      await showNotification(
        t('components.input.notifications.summarizeFailed', { error: result.error || t('common.unknownError') }),
        'warning'
      )
    } else if (result.summarizedMessageCount && result.summarizedMessageCount > 0) {
      await showNotification(
        t('components.input.notifications.summarizeSuccess', { count: result.summarizedMessageCount }),
        'info'
      )
    }
  } catch (error: any) {
    console.error('Summarize error:', error)
    await showNotification(
      t('components.input.notifications.summarizeError', { error: error.message || t('common.unknownError') }),
      'error'
    )
  }
}

// ========== 手动创建存档点 ==========

/** 手动存档进行中（按钮 loading 态，防重复点击） */
const isCreatingCheckpoint = ref(false)

async function handleCreateCheckpoint() {
  if (isCreatingCheckpoint.value || chatStore.isWaitingForResponse) return
  if (!chatStore.currentConversationId) return

  isCreatingCheckpoint.value = true
  try {
    const checkpoint = await chatStore.createManualCheckpoint()
    if (checkpoint) {
      await showNotification(t('components.input.notifications.checkpointCreated'), 'info')
    } else {
      await showNotification(t('components.input.notifications.checkpointCreateFailed'), 'warning')
    }
  } catch (error: any) {
    console.error('Create checkpoint error:', error)
    await showNotification(
      t('components.input.notifications.checkpointCreateError', { error: error.message || t('common.unknownError') }),
      'error'
    )
  } finally {
    isCreatingCheckpoint.value = false
  }
}

const tokenRingColor = computed(() => {
  const percent = chatStore.tokenUsagePercent
  if (percent >= 90) return 'var(--gc-danger)'
  if (percent >= 75) return 'var(--gc-warning)'
  return 'var(--gc-success)'
})

const tokenUsageAriaLabel = computed(() => [
  `${t('components.input.tokenUsage')}: ${chatStore.tokenUsagePercent.toFixed(1)}%`,
  `${t('components.input.context')}: ${formatNumber(chatStore.usedTokens)} / ${formatNumber(chatStore.maxContextTokens)}`
].join('; '))

const ringRadius = 8
const ringCircumference = 2 * Math.PI * ringRadius
const ringDashOffset = computed(() => ringCircumference * (1 - chatStore.tokenUsagePercent / 100))

// ========== 上下文统计详情入口（只读，不触发总结） ==========
const showContextDetail = ref(false)
const promptPreviewAvailable = !!window.__GRAYCODE_HOST
const showPromptPreview = ref(false)
const promptPreviewRequest = computed(() => ({
  conversationId: chatStore.currentConversationId, configId: chatStore.configId,
  message: serializeNodes(editorNodes.value).trim(), attachments: (props.attachments ?? []).map(attachment => ({
    id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size,
    mimeType: attachment.mimeType, data: attachment.data || '', thumbnail: attachment.thumbnail
  })), modelOverride: chatStore.selectedModelId || undefined,
  reasoningEffort: chatStore.selectedReasoningEffort || undefined, promptModeId: chatStore.currentPromptModeId
}))
function openContextDetail() {
  showContextDetail.value = true
}

// ========== lifecycle ==========

onMounted(() => {
  // Receive context chips pushed from the extension (e.g. editor selection hover/lightbulb).
  unsubscribeAddContext = onExtensionCommand('input.addContext', (payload: any) => {
    const contextItem = payload?.contextItem as PromptContextItem | undefined
    if (!contextItem) return

    // Best-effort: insert at caret if possible; otherwise fall back to append.
    const inserted = inputBoxRef.value?.insertContextAtCaret(contextItem)
    if (!inserted) {
      editorNodes.value = [...editorNodes.value, { type: 'context', context: contextItem }]
    }

    // Keep the input ready for typing.
    nextTick(() => inputBoxRef.value?.focus())
  })

  // 渠道/模型设置在设置面板变更后（新增/移除模型、改渠道参数、增删渠道），
  // 后端推送刷新命令，输入区重新拉取配置，让渠道/模型下拉框立即同步（无需重启扩展）。
  unsubscribeConfigChanged = onExtensionCommand('channels.configChanged', () => {
    loadConfigs()
  })

  loadConfigs()
  loadPromptModes()
})

onBeforeUnmount(() => {
  configLoadGeneration++
  if (unsubscribeAddContext) unsubscribeAddContext()
  if (unsubscribeConfigChanged) unsubscribeConfigChanged()
})

watch(() => chatStore.configId, () => {
  if (chatStore.configId && !configs.value.some(c => c.id === chatStore.configId)) {
    loadConfigs()
  }
})

watch(() => settingsStore.promptModesVersion, () => {
  loadPromptModes()
})
</script>

<template>
  <div class="input-area">
    <InputAttachments
      v-if="hasAttachments"
      :attachments="props.attachments || []"
      :uploading="props.uploading"
      @remove="handleRemoveAttachment"
      @preview="previewAttachment"
    />

    <!-- 消息候选区（排队队列） -->
    <MessageQueue />

    <div class="input-box-container">
      <FilePickerPanel
        ref="filePickerRef"
        :visible="showFilePicker"
        :query="filePickerQuery"
        @select="handleSelectFile"
        @close="handleCloseAtPicker"
        @update:query="(q) => filePickerQuery = q"
      />

      <InputBox
        ref="inputBoxRef"
        :nodes="editorNodes"
        :undo-scope="editorUndoScope"
        :disabled="false"
        :placeholder="props.placeholder"
        :popup-expanded="showFilePicker"
        popup-controls="gc-file-picker-listbox"
        @update:nodes="handleNodesUpdate"
        @remove-context="handleRemovePromptContextItem"
        @send="handleSend"
        @composition-start="handleCompositionStart"
        @composition-end="handleCompositionEnd"
        @paste="handlePasteFiles"
        @drop-files="handlePasteFiles"
        @drop-file-items="handleDropFileItems"
        @open-context="handleOpenContext"
        @trigger-at-picker="handleTriggerAtPicker"
        @close-at-picker="handleCloseAtPicker"
        @at-query-change="handleAtQueryChange"
        @at-picker-keydown="handleAtPickerKeydown"
      />

    </div>

    <div class="bottom-toolbar">
      <div class="toolbar-left">
        <Tooltip :content="t('components.input.attachFile')" placement="top-left">
          <IconButton
            icon="codicon-attach"
            size="small"
            :aria-label="t('components.input.attachFile')"
            :disabled="props.uploading"
            class="attach-button"
            @click="handleAttachFile"
          />
        </Tooltip>

        <PinnedFilesWidget />
        <SkillsWidget />
        <BranchTreePanel />

        <Tooltip :content="t('components.input.createCheckpoint')" placement="top-left">
          <IconButton
            icon="codicon-save"
            size="small"
            :aria-label="t('components.input.createCheckpoint')"
            :loading="isCreatingCheckpoint"
            :disabled="!chatStore.currentConversationId || isCreatingCheckpoint || chatStore.isWaitingForResponse"
            class="checkpoint-button"
            @click="handleCreateCheckpoint"
          />
        </Tooltip>
      </div>

      <!-- TPS 实时可视化：总结上下文按钮左侧（最底部一行）；可在外观设置中关闭 -->
      <TpsBar v-if="settingsStore.tpsBarEnabled" class="tps-slot" />

      <div class="toolbar-right">
        <Tooltip v-if="promptPreviewAvailable" content="预览当前完整提示词" placement="top">
          <IconButton icon="codicon-open-preview" size="small" aria-label="预览当前完整提示词" class="prompt-preview-button"
            :disabled="!currentModel || props.uploading" @click="showPromptPreview = true" />
        </Tooltip>
        <Tooltip :content="t('components.input.summarizeContext')" placement="top">
          <IconButton
            icon="codicon-fold"
            size="small"
            :aria-label="t('components.input.summarizeContext')"
            :disabled="chatStore.isWaitingForResponse || chatStore.usedTokens === 0 || isSummarizing"
            :loading="isSummarizing"
            class="summarize-button"
            @click="handleSummarize"
          />
        </Tooltip>

        <!-- 上下文统计详情入口：用量区域旁，只读展示 describeConversation -->
        <Tooltip :content="t('components.input.contextDetail.open')" placement="top">
          <IconButton
            icon="codicon-info"
            size="small"
            :aria-label="t('components.input.contextDetail.open')"
            :disabled="!chatStore.currentConversationId"
            class="context-detail-button"
            @click="openContextDetail"
          />
        </Tooltip>

        <div
          class="token-ring-wrapper"
          role="img"
          tabindex="0"
          :aria-label="tokenUsageAriaLabel"
          aria-describedby="token-usage-tooltip"
        >
          <svg class="token-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
            <circle
              cx="11"
              cy="11"
              :r="ringRadius"
              fill="none"
              stroke="var(--vscode-panel-border)"
              stroke-width="2"
            />
            <circle
              cx="11"
              cy="11"
              :r="ringRadius"
              fill="none"
              :stroke="tokenRingColor"
              stroke-width="2"
              stroke-linecap="round"
              :stroke-dasharray="ringCircumference"
              :stroke-dashoffset="ringDashOffset"
              transform="rotate(-90 11 11)"
            />
          </svg>
          <div id="token-usage-tooltip" class="token-tooltip" role="tooltip">
            <div class="token-tooltip-row">
              <span class="token-tooltip-label">{{ t('components.input.tokenUsage') }}</span>
              <span class="token-tooltip-value">{{ chatStore.tokenUsagePercent.toFixed(1) }}%</span>
            </div>
            <div class="token-tooltip-row">
              <span class="token-tooltip-label">{{ t('components.input.context') }}</span>
              <span class="token-tooltip-value">{{ formatNumber(chatStore.usedTokens) }} / {{ formatNumber(chatStore.maxContextTokens) }}</span>
            </div>
          </div>
        </div>

        <SendButton
          :disabled="!canSend"
          :loading="chatStore.isWaitingForResponse"
          @click="handleSend"
          @preserve-dynamic-context-click="handlePreserveDynamicContextSend"
          @cancel="handleCancel"
        />
      </div>
    </div>

    <ChannelSetupNotice :status="channelSetupStatus" :error="configsLoadError"
      @configure="settingsStore.showSettings('channel')" @retry="loadConfigs" />

    <InputSelectorBar
      :current-mode-id="chatStore.currentPromptModeId"
      :mode-options="modeOptions"
      :is-loading-configs="isLoadingConfigs"
      :config-id="chatStore.configId"
      :channel-options="channelOptions"
      :current-model-id="currentModel"
      :model-options="currentModels"
      :model-disabled="!chatStore.configId || isLoadingConfigs"
      :reasoning-effort="chatStore.selectedReasoningEffort"
      :reasoning-levels="currentReasoningLevels"
      @mode-change="handleModeChange"
      @open-mode-settings="openModeSettings"
      @channel-change="handleChannelChange"
      @model-change="handleModelChange"
      @reasoning-change="handleReasoningChange"
    />

    <ContextDetailDialog
      v-model="showContextDetail"
      :conversation-id="chatStore.currentConversationId"
      :provider-id="chatStore.configId"
      :model-override="chatStore.selectedModelId || undefined"
      :fallback-max-tokens="chatStore.maxContextTokens"
    />
    <PromptPreviewDialog v-if="promptPreviewAvailable" v-model="showPromptPreview" :request="promptPreviewRequest" :running="chatStore.isWaitingForResponse" />
  </div>
</template>

<style scoped>
.input-area {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--gc-space-2);
  margin: var(--gc-space-2);
  padding: var(--gc-space-2);
  background: var(--vscode-input-background, var(--gc-surface-raised));
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-lg);
  transition: border-color var(--gc-duration-fast) var(--gc-ease-standard);
}

.input-area:focus-within {
  border-color: var(--gc-focus-border);
}

.input-box-container {
  position: relative;
}

/* 输入区共用外框；保留编辑器自身的尺寸、拖拽和滚动行为。 */
.input-box-container :deep(.input-editor) {
  background: transparent;
  border-color: transparent;
  border-radius: var(--gc-radius-sm);
}

.bottom-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gc-space-2);
  min-width: 0;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: var(--gc-space-1);
}

/* TPS 实时可视化条：占据底部行中间弹性区，总结上下文按钮左侧 */
.tps-slot {
  justify-content: center;
  padding: 0 8px;
}

/* 窄面板：压缩底部行间距与中间弹性区，避免右侧按钮被挤出（TpsBar 在窄屏隐藏 canvas） */
@media (max-width: 520px) {
  .bottom-toolbar {
    gap: 4px;
  }

  .tps-slot {
    padding: 0 4px;
  }
}

@media (max-width: 360px) {
  .bottom-toolbar {
    flex-wrap: wrap;
  }

  .toolbar-right {
    margin-left: auto;
  }

  .tps-slot {
    order: 1;
    flex-basis: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .input-area {
    transition: none;
  }
}

.attach-button :deep(i.codicon) {
  font-size: 17px !important;
}

.summarize-button :deep(i.codicon) {
  font-size: 15px !important;
}

.context-detail-button :deep(i.codicon) {
  font-size: 15px !important;
}

.token-ring-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: var(--gc-control-height-sm);
  min-height: var(--gc-control-height-sm);
}

.token-ring {
  display: block;
}

.token-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  padding: 4px 8px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: var(--gc-radius-sm);
  box-shadow: var(--gc-shadow-sm);
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--gc-duration-fast) var(--gc-ease-standard),
    visibility var(--gc-duration-fast) var(--gc-ease-standard);
  z-index: var(--gc-layer-popover);
  pointer-events: none;
}

.token-ring-wrapper:hover .token-tooltip,
.token-ring-wrapper:focus-visible .token-tooltip {
  opacity: 1;
  visibility: visible;
}

.token-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  right: 8px;
  border: 4px solid transparent;
  border-top-color: var(--vscode-editorWidget-border);
}

.token-tooltip::before {
  content: '';
  position: absolute;
  top: 100%;
  right: 9px;
  border: 3px solid transparent;
  border-top-color: var(--vscode-editorWidget-background);
  z-index: 1;
}

.token-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: var(--gc-font-size-caption);
  line-height: 1.5;
}

.token-tooltip-label {
  color: var(--vscode-descriptionForeground);
}

.token-tooltip-value {
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--gc-font-size-caption);
}
</style>
