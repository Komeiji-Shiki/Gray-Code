<script setup lang="ts">
/**
 * SettingsPanel - 设置面板主容器
 *
 * 模板拆分说明（T12 批次，纯结构性拆分，行为零变化）：
 * - SettingsSidebar：左侧页签栏（折叠/搜索高亮）
 * - SettingsSearchBox：设置项搜索框 + 结果下拉
 * - GeneralSettingsSection：通用页签（代理/语言/更新/存储路径/导入导出/应用信息）
 * - UsageSummaryCard：用量统计 Token 摘要卡片
 * - StorageMigrateDialog：存储路径迁移确认对话框
 * 所有响应式状态仍由本组件持有，子组件仅通过 props/emits 通信。
 * 注意：SEARCH_INDEX 必须留在本文件（settingsSearchAnchorConsistency.test.ts 直接解析本文件源码做 L-3 校验）。
 */
import { ref, reactive, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { useSettingsStore, type SettingsTab } from '@/stores/settingsStore'
import { MESSAGE_NAMES } from '@shared/protocol'
import ChannelSettings from './ChannelSettings.vue'
import ToolsSettings from './ToolsSettings.vue'
import AutoExecSettings from './AutoExecSettings.vue'
import McpSettings from './McpSettings.vue'
import CheckpointSettings from './CheckpointSettings.vue'
import SummarizeSettings from './SummarizeSettings.vue'
import GenerateImageSettings from './GenerateImageSettings.vue'
import DependencySettings from './DependencySettings.vue'
import ContextSettings from './ContextSettings.vue'
import PromptSettings from './PromptSettings.vue'
import TokenCountSettings from './TokenCountSettings.vue'
import SubAgentsSettings from './SubAgentsSettings.vue'
import MemorySettings from './MemorySettings.vue'
import SandboxSettings from './SandboxSettings.vue'
import RemoteControlSettings from './RemoteControlSettings.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import SoundSettings from './SoundSettings.vue'
import UsageTimeSection from '../usage/UsageTimeSection.vue'
import type { UsageStatsResult, UsageTimeRange } from '@/types/usage'
import { CustomScrollbar, CustomSelect, type SelectOption } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { pendingToolConfigExpand } from './tools/toolConfigFocus'
import SettingsSidebar from './panel/SettingsSidebar.vue'
import SettingsSearchBox from './panel/SettingsSearchBox.vue'
import GeneralSettingsSection from './panel/GeneralSettingsSection.vue'
import UsageSummaryCard from './panel/UsageSummaryCard.vue'
import StorageMigrateDialog from './panel/StorageMigrateDialog.vue'
import type { TabItem, SearchIndexEntry } from './panel/types'

const settingsStore = useSettingsStore()
const { t, setLanguage } = useI18n()

// 侧边栏折叠状态（展开时显示图标+文字，折叠时仅图标）
const sidebarCollapsed = ref(false)

// 页签列表（使用 computed 以便语言切换时自动更新）
const tabs = computed<TabItem[]>(() => [
  { id: 'channel', label: t('components.settings.tabs.channel'), icon: 'codicon-plug' },
  { id: 'tools', label: t('components.settings.tabs.tools'), icon: 'codicon-tools' },
  { id: 'autoExec', label: t('components.settings.tabs.autoExec'), icon: 'codicon-shield' },
  { id: 'mcp', label: t('components.settings.tabs.mcp'), icon: 'codicon-server' },
  { id: 'subagents', label: t('components.settings.tabs.subagents'), icon: 'codicon-hubot' },
  { id: 'checkpoint', label: t('components.settings.tabs.checkpoint'), icon: 'codicon-history' },
  { id: 'summarize', label: t('components.settings.tabs.summarize'), icon: 'codicon-fold' },
  { id: 'imageGen', label: t('components.settings.tabs.imageGen'), icon: 'codicon-symbol-color' },
  { id: 'dependencies', label: t('components.settings.tabs.dependencies'), icon: 'codicon-package' },
  { id: 'context', label: t('components.settings.tabs.context'), icon: 'codicon-symbol-namespace' },
  { id: 'prompt', label: t('components.settings.tabs.prompt'), icon: 'codicon-note' },
  { id: 'tokenCount', label: t('components.settings.tabs.tokenCount'), icon: 'codicon-symbol-numeric' },
  { id: 'sound', label: t('components.settings.tabs.sound'), icon: 'codicon-bell' },
  { id: 'appearance', label: t('components.settings.tabs.appearance'), icon: 'codicon-paintcan' },
  { id: 'memory', label: t('components.settings.tabs.memory'), icon: 'codicon-database' },
  { id: 'sandbox', label: t('components.settings.tabs.sandbox'), icon: 'codicon-terminal' },
  { id: 'remoteControl', label: t('components.settings.tabs.remoteControl'), icon: 'codicon-remote' },
  { id: 'general', label: t('components.settings.tabs.general'), icon: 'codicon-settings-gear' },
  { id: 'usage', label: t('components.settings.tabs.usage'), icon: 'codicon-graph' },
])

// ========== 设置项搜索 ==========

// 静态搜索索引：设置项为硬编码组件，无统一注册表，用关键词索引覆盖各页签主要设置项。
// 每个页签级条目作为兜底；每个设置块都有 data-search-anchor 锚点条目。
// 关键词同时包含中/英/日，任意界面语言下都能搜到（匹配时统一去空白）。
const SEARCH_INDEX: SearchIndexEntry[] = [
  {
    key: 'channel', tab: 'channel',
    labelKey: 'components.settings.settingsPanel.sections.channel.title',
    keywords: ['渠道', 'channel', 'チャンネル', '配置渠道', 'api key', 'api密钥', 'apiキー', '密钥', '模型', 'model', 'モデル', 'gemini', 'openai', 'claude', 'deepseek', 'glm', '自定义模型']
  },
  {
    key: 'channel-api-url', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.apiUrl.label',
    keywords: ['api url', 'url', '接口地址', '地址', 'endpoint', 'エンドポイント', 'api地址'],
    anchor: '[data-search-anchor="api-url"]'
  },
  {
    key: 'channel-api-key', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.apiKey.label',
    keywords: ['api key', 'api密钥', 'apiキー', '密钥', 'key', '认证', 'authorization'],
    anchor: '[data-search-anchor="api-key"]'
  },
  {
    key: 'channel-model-list', tab: 'channel',
    labelKey: 'components.settings.modelManager.title',
    keywords: ['模型', 'model', 'モデル', '模型列表', '获取模型', '清除全部'],
    anchor: '[data-search-anchor="model-list"]'
  },
  {
    key: 'channel-stream', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.stream.label',
    keywords: ['流式', 'stream', 'ストリーム', '流式输出', '打字机'],
    anchor: '[data-search-anchor="stream-output"]'
  },
  {
    key: 'channel-type', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.channelType.label',
    keywords: ['渠道类型', 'channel type', 'タイプ', 'gemini', 'openai', 'anthropic', 'claude', 'openai responses'],
    anchor: '[data-search-anchor="channel-type"]'
  },
  {
    key: 'channel-tool-mode', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.toolMode.label',
    keywords: ['工具调用格式', 'tool mode', 'function call', 'xml', 'json', '工具调用'],
    anchor: '[data-search-anchor="tool-mode"]'
  },
  {
    key: 'channel-multimodal', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.multimodal.label',
    keywords: ['多模态', 'multimodal', 'マルチモーダル', '图片', '图像', '文档', '附件', '读取图片'],
    anchor: '[data-search-anchor="multimodal"]'
  },
  {
    key: 'channel-strict-tools', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.strictTools.label',
    keywords: ['strict tool use', '严格工具', '强制工具', '工具调用'],
    anchor: '[data-search-anchor="strict-tools"]'
  },
  {
    key: 'channel-timeout', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.timeout.label',
    keywords: ['超时', 'timeout', 'タイムアウト', '请求超时', '毫秒'],
    anchor: '[data-search-anchor="timeout"]'
  },
  {
    key: 'channel-max-context-tokens', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.maxContextTokens.label',
    keywords: ['上下文', 'context', 'コンテキスト', 'token', 'トークン', '最大', 'max', '限制'],
    anchor: '[data-search-anchor="max-context-tokens"]'
  },
  {
    key: 'channel-context-management', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.contextManagement.title',
    keywords: ['上下文管理', 'context management', '阈值', 'threshold', 'しきい値', '自动总结', '裁剪'],
    anchor: '[data-search-anchor="context-management"]'
  },
  {
    key: 'channel-tool-options', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.toolOptions.title',
    keywords: ['工具配置', 'tool options', '裁切', 'crop', '坐标'],
    anchor: '[data-search-anchor="tool-options"]'
  },
  {
    key: 'channel-token-count-method', tab: 'channel',
    labelKey: 'components.channels.tokenCountMethod.title',
    keywords: ['token 计数', 'token count', '计数方式', '计算方法'],
    anchor: '[data-search-anchor="token-count-method"]'
  },
  {
    key: 'channel-advanced-options', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.advancedOptions.title',
    keywords: ['高级选项', 'advanced options', '高度な設定', 'gemini', 'openai', 'anthropic', '扩展'],
    anchor: '[data-search-anchor="advanced-options"]'
  },
  {
    key: 'channel-custom-body', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.customBody.title',
    keywords: ['自定义 body', 'custom body', '请求体', '请求内容', 'json'],
    anchor: '[data-search-anchor="custom-body"]'
  },
  {
    key: 'channel-custom-headers', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.customHeaders.title',
    keywords: ['自定义标头', 'custom headers', 'header', 'ヘッダー', '请求头'],
    anchor: '[data-search-anchor="custom-headers"]'
  },
  {
    key: 'channel-auto-retry', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.autoRetry.title',
    keywords: ['重试', 'retry', 'リトライ', '自动重试', '重试次数', '重试间隔'],
    anchor: '[data-search-anchor="auto-retry"]'
  },
  {
    key: 'channel-enabled', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.enabled.label',
    keywords: ['启用', 'enabled', '有効', '渠道开关', '启用渠道'],
    anchor: '[data-search-anchor="channel-enabled"]'
  },
  {
    key: 'tools', tab: 'tools',
    labelKey: 'components.settings.settingsPanel.sections.tools.title',
    keywords: ['工具', 'tools', 'ツール', 'apply_diff', 'insert_code', 'delete_code', '文件编辑', '终端', 'terminal', 'ターミナル', '浏览器', 'browser', '搜索', 'search', '网页抓取', '图片', '图像', 'image', '生成', 'generate', '诊断', 'diagnostics', '自动应用', '自动批准', '应用diff']
  },
  {
    key: 'tools-max-iterations', tab: 'tools',
    labelKey: 'components.settings.toolsSettings.maxIterations.label',
    keywords: ['最大工具调用次数', 'max iterations', '工具调用', 'iteration', '反復', '无限制', '循环'],
    anchor: '[data-search-anchor="max-tool-iterations"]'
  },
  {
    key: 'tools-list', tab: 'tools',
    labelKey: 'components.settings.settingsPanel.sections.tools.title',
    keywords: ['工具列表', 'tool list', 'ツール一覧', '全部启用', '全部禁用', '启用', '禁用', '依赖', '自动应用', '自动批准', '应用diff', 'auto apply'],
    anchor: '[data-search-anchor="tool-list"]'
  },
  {
    key: 'apply-diff-config', tab: 'tools',
    labelKey: 'components.settings.toolSettings.files.applyDiff.autoApply',
    keywords: ['自动应用', '自动批准', 'auto apply', 'auto approve', '自动保存', '应用diff', 'apply diff', '差异审阅', '跳过差异视图', '警戒值', 'diff guard', '自动执行 diff'],
    anchor: '[data-search-anchor="apply-diff-config"]'
  },
  {
    key: 'autoExec', tab: 'autoExec',
    labelKey: 'components.settings.settingsPanel.sections.autoExec.title',
    keywords: ['自动执行', 'auto exec', '自動実行', '确认', 'confirmation', '確認', '批准', '执行模式', '手动', '工具确认', 'diff 审阅', '自动批准', 'auto approve', '自动应用']
  },
  {
    key: 'autoExec-intro', tab: 'autoExec',
    labelKey: 'components.settings.autoExec.intro.title',
    keywords: ['自动执行', 'auto exec', '自動実行', '说明', '确认'],
    anchor: '[data-search-anchor="auto-exec-intro"]'
  },
  {
    key: 'autoExec-list', tab: 'autoExec',
    labelKey: 'components.settings.settingsPanel.sections.autoExec.title',
    keywords: ['工具列表', '自动执行', '需要确认', '危险工具', 'mcp 工具'],
    anchor: '[data-search-anchor="auto-exec-list"]'
  },
  {
    key: 'autoExec-tips', tab: 'autoExec',
    labelKey: 'components.settings.autoExec.tips.diffReviewNote',
    keywords: ['提示', 'tips', 'ヒント', 'diff 审阅', '自动应用', '危险', '警告'],
    anchor: '[data-search-anchor="auto-exec-tips"]'
  },
  {
    key: 'mcp', tab: 'mcp',
    labelKey: 'components.settings.settingsPanel.sections.mcp.title',
    keywords: ['mcp', 'server', '服务器', 'サーバー', '模型上下文协议', 'model context protocol', '工具']
  },
  {
    key: 'mcp-toolbar', tab: 'mcp',
    labelKey: 'components.settings.mcpSettings.toolbar.addServer',
    keywords: ['添加服务器', 'add server', 'サーバー追加', '编辑 json', '刷新'],
    anchor: '[data-search-anchor="mcp-toolbar"]'
  },
  {
    key: 'mcp-server-list', tab: 'mcp',
    labelKey: 'components.settings.settingsPanel.sections.mcp.title',
    keywords: ['服务器列表', 'server list', '连接', 'connect', '切断', '状态', '启用'],
    anchor: '[data-search-anchor="mcp-server-list"]'
  },
  {
    key: 'mcp-basic-info', tab: 'mcp',
    labelKey: 'components.settings.mcpSettings.form.serverName',
    keywords: ['服务器名称', 'server name', '描述', 'description', 'id', '标识'],
    anchor: '[data-search-anchor="mcp-basic-info"]'
  },
  {
    key: 'mcp-transport-type', tab: 'mcp',
    labelKey: 'components.settings.mcpSettings.form.transportType',
    keywords: ['传输类型', 'transport', '転送', 'stdio', 'sse', 'streamable http', '传输方式'],
    anchor: '[data-search-anchor="mcp-transport-type"]'
  },
  {
    key: 'mcp-stdio-config', tab: 'mcp',
    labelKey: 'components.settings.mcpSettings.form.command',
    keywords: ['命令', 'command', 'コマンド', '参数', 'args', '环境变量', 'env'],
    anchor: '[data-search-anchor="mcp-stdio-config"]'
  },
  {
    key: 'mcp-url-config', tab: 'mcp',
    labelKey: 'components.settings.mcpSettings.form.url',
    keywords: ['url', '地址', 'エンドポイント', 'headers', '标头'],
    anchor: '[data-search-anchor="mcp-url-config"]'
  },
  {
    key: 'mcp-options', tab: 'mcp',
    labelKey: 'components.settings.mcpSettings.form.options',
    keywords: ['选项', 'options', 'オプション', '启用', '自动连接', 'auto connect', '超时', 'timeout', 'schema'],
    anchor: '[data-search-anchor="mcp-options"]'
  },
  {
    key: 'subagents', tab: 'subagents',
    labelKey: 'components.settings.settingsPanel.sections.subagents.title',
    keywords: ['子代理', 'subagent', 'サブエージェント', '迭代', 'iteration', '反復', '次数', '专业代理', '模型', 'worker']
  },
  {
    key: 'subagents-global', tab: 'subagents',
    labelKey: 'components.settings.subagents.globalConfig',
    keywords: ['全局配置', 'global', '並行', '并发', 'concurrent', '默认迭代', 'worker', '通用'],
    anchor: '[data-search-anchor="subagents-global"]'
  },
  {
    key: 'subagents-selector', tab: 'subagents',
    labelKey: 'components.settings.subagents.selectAgent',
    keywords: ['选择子代理', 'select agent', '新建', '重命名', '删除'],
    anchor: '[data-search-anchor="subagents-selector"]'
  },
  {
    key: 'subagents-basic-info', tab: 'subagents',
    labelKey: 'components.settings.subagents.basicInfo',
    keywords: ['基本信息', 'basic', '描述', 'description', '迭代次数', '最大运行时间', '启用'],
    anchor: '[data-search-anchor="subagents-basic-info"]'
  },
  {
    key: 'subagents-system-prompt', tab: 'subagents',
    labelKey: 'components.settings.subagents.systemPrompt',
    keywords: ['系统提示词', 'system prompt', 'システムプロンプト', '提示词'],
    anchor: '[data-search-anchor="subagents-system-prompt"]'
  },
  {
    key: 'subagents-channel-model', tab: 'subagents',
    labelKey: 'components.settings.subagents.channelModel',
    keywords: ['渠道', 'channel', 'モデル', '模型', 'model', '选择渠道', '选择模型'],
    anchor: '[data-search-anchor="subagents-channel-model"]'
  },
  {
    key: 'subagents-tools', tab: 'subagents',
    labelKey: 'components.settings.subagents.tools',
    keywords: ['工具', 'tools', 'ツール', '白名单', 'whitelist', 'ブラックリスト', '黑名单', 'blacklist', '工具模式'],
    anchor: '[data-search-anchor="subagents-tools"]'
  },
  {
    key: 'checkpoint', tab: 'checkpoint',
    labelKey: 'components.settings.settingsPanel.sections.checkpoint.title',
    keywords: ['存档', 'checkpoint', 'チェックポイント', '快照', 'snapshot', 'スナップショット', '备份', 'backup', 'バックアップ', '回退', 'restore', '復元', '分支', 'branch', 'ブランチ', '工作区', 'workspace']
  },
  {
    key: 'checkpoint-enable', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.enable.label',
    keywords: ['启用', 'enable', '有効', '存档点', 'checkpoint', '总开关'],
    anchor: '[data-search-anchor="checkpoint-enable"]'
  },
  {
    key: 'checkpoint-messages', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.messages.title',
    keywords: ['消息', 'message', 'メッセージ', '模型', 'model', '存档', '外层'],
    anchor: '[data-search-anchor="checkpoint-messages"]'
  },
  {
    key: 'checkpoint-tools', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.tools.title',
    keywords: ['工具', 'tools', 'ツール', '备份', '存档', 'before', 'after', '之前', '之后'],
    anchor: '[data-search-anchor="checkpoint-tools"]'
  },
  {
    key: 'checkpoint-other', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.other.title',
    keywords: ['最大存档点数量', 'max checkpoints', '数量', '上限', '保留'],
    anchor: '[data-search-anchor="checkpoint-other"]'
  },
  {
    key: 'checkpoint-exclusions', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.exclusion.title',
    keywords: ['排除', 'exclusion', '除外', '模式', 'pattern', '自定义', '预览', '大小', 'max file size'],
    anchor: '[data-search-anchor="checkpoint-exclusions"]'
  },
  {
    key: 'checkpoint-cleanup', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.cleanup.title',
    keywords: ['清理', 'cleanup', 'クリーンアップ', '删除', 'delete', '批量', '对话', '存储'],
    anchor: '[data-search-anchor="checkpoint-cleanup"]'
  },
  {
    key: 'checkpoint-branch-cleanup', tab: 'checkpoint',
    labelKey: 'components.settings.checkpoint.sections.branchCleanup.title',
    keywords: ['分支清理', 'branch cleanup', 'ブランチ', '软删', '保留期', 'retention', '清理'],
    anchor: '[data-search-anchor="branch-cleanup"]'
  },
  {
    key: 'summarize', tab: 'summarize',
    labelKey: 'components.settings.settingsPanel.sections.summarize.title',
    keywords: ['总结', 'summarize', '要約', '自动总结', '上下文压缩', '压缩', '对话历史', 'token']
  },
  {
    key: 'summarize-manual', tab: 'summarize',
    labelKey: 'components.settings.summarizeSettings.manualSection.title',
    keywords: ['手动总结', 'manual', 'マニュアル', '总结'],
    anchor: '[data-search-anchor="summarize-manual"]'
  },
  {
    key: 'summarize-options', tab: 'summarize',
    labelKey: 'components.settings.summarizeSettings.optionsSection.title',
    keywords: ['保留轮数', 'keep rounds', '保留', 'token', '提示词', 'prompt', '最大尝试', '输入占比', '预算'],
    anchor: '[data-search-anchor="summarize-options"]'
  },
  {
    key: 'summarize-model', tab: 'summarize',
    labelKey: 'components.settings.summarizeSettings.modelSection.title',
    keywords: ['专用模型', 'separate model', 'モデル', '渠道', 'channel', '选择模型'],
    anchor: '[data-search-anchor="summarize-model"]'
  },
  {
    key: 'imageGen', tab: 'imageGen',
    labelKey: 'components.settings.settingsPanel.sections.imageGen.title',
    keywords: ['图像生成', 'image generation', '画像生成', '图片', 'image', '绘图', '生成模型']
  },
  {
    key: 'imageGen-api', tab: 'imageGen',
    labelKey: 'components.settings.generateImageSettings.api.title',
    keywords: ['api', 'url', '接口地址', 'api key', '密钥', '模型', 'model', 'gemini'],
    anchor: '[data-search-anchor="image-api-config"]'
  },
  {
    key: 'imageGen-aspect-ratio', tab: 'imageGen',
    labelKey: 'components.settings.generateImageSettings.aspectRatio.title',
    keywords: ['宽高比', 'aspect ratio', 'アスペクト比', '比例', '横屏', '竖屏', '16:9', '1:1'],
    anchor: '[data-search-anchor="aspect-ratio"]'
  },
  {
    key: 'imageGen-image-size', tab: 'imageGen',
    labelKey: 'components.settings.generateImageSettings.imageSize.title',
    keywords: ['图片尺寸', 'image size', 'サイズ', '1k', '2k', '4k', '分辨率'],
    anchor: '[data-search-anchor="image-size"]'
  },
  {
    key: 'imageGen-batch', tab: 'imageGen',
    labelKey: 'components.settings.generateImageSettings.batch.title',
    keywords: ['批量', 'batch', 'バッチ', '上限', '任务数', '图片数', '最大'],
    anchor: '[data-search-anchor="batch-limits"]'
  },
  {
    key: 'imageGen-usage', tab: 'imageGen',
    labelKey: 'components.settings.generateImageSettings.usage.title',
    keywords: ['使用说明', 'usage', '使い方', '步骤', '说明', '教程'],
    anchor: '[data-search-anchor="image-usage"]'
  },
  {
    key: 'dependencies', tab: 'dependencies',
    labelKey: 'components.settings.settingsPanel.sections.dependencies.title',
    keywords: ['依赖', 'dependencies', '依存', '安装', 'install', 'インストール', 'python', 'node', 'ffmpeg', '检查']
  },
  {
    key: 'dependencies-install-path', tab: 'dependencies',
    labelKey: 'components.settings.dependencySettings.installPath',
    keywords: ['安装路径', 'install path', 'インストール先', '路径', '目录'],
    anchor: '[data-search-anchor="install-path"]'
  },
  {
    key: 'dependencies-tools', tab: 'dependencies',
    labelKey: 'components.settings.dependencySettings.title',
    keywords: ['依赖', 'dependencies', '依存', '安装', 'install', 'インストール', '卸载', 'uninstall', 'python', 'node', 'ffmpeg'],
    anchor: '[data-search-anchor="dependency-tools"]'
  },
  {
    key: 'context', tab: 'context',
    labelKey: 'components.settings.settingsPanel.sections.context.title',
    keywords: ['上下文', 'context', 'コンテキスト', '文件树', 'file tree', 'ファイルツリー', '目录', '深度', 'depth', '忽略', 'ignore', '無視', '诊断', '错误', '警告', '环境信息']
  },
  {
    key: 'context-file-tree', tab: 'context',
    labelKey: 'components.settings.contextSettings.workspaceFiles.title',
    keywords: ['文件树', 'file tree', 'ファイルツリー', '工作区', 'workspace', '深度', 'depth', '发送'],
    anchor: '[data-search-anchor="file-tree"]'
  },
  {
    key: 'context-open-tabs', tab: 'context',
    labelKey: 'components.settings.contextSettings.openTabs.title',
    keywords: ['打开的标签页', 'open tabs', 'タブ', '标签页', 'tabs'],
    anchor: '[data-search-anchor="open-tabs"]'
  },
  {
    key: 'context-active-editor', tab: 'context',
    labelKey: 'components.settings.contextSettings.activeEditor.title',
    keywords: ['活动编辑器', 'active editor', 'エディタ', '当前文件', '正在编辑'],
    anchor: '[data-search-anchor="active-editor"]'
  },
  {
    key: 'context-diagnostics', tab: 'context',
    labelKey: 'components.settings.contextSettings.diagnostics.title',
    keywords: ['诊断', 'diagnostics', '診断', '错误', '警告', 'error', 'warning', '严重程度', 'severity'],
    anchor: '[data-search-anchor="diagnostics"]'
  },
  {
    key: 'context-ignore-patterns', tab: 'context',
    labelKey: 'components.settings.contextSettings.ignorePatterns.title',
    keywords: ['忽略', 'ignore', '無視', '模式', 'pattern', '通配符', 'wildcard', '排除'],
    anchor: '[data-search-anchor="ignore-patterns"]'
  },
  {
    key: 'context-preview', tab: 'context',
    labelKey: 'components.settings.contextSettings.preview.title',
    keywords: ['预览', 'preview', 'プレビュー', '效果', '自动刷新'],
    anchor: '[data-search-anchor="context-preview"]'
  },
  {
    key: 'prompt', tab: 'prompt',
    labelKey: 'components.settings.settingsPanel.sections.prompt.title',
    keywords: ['提示词', 'prompt', 'プロンプト', '系统提示词', 'system prompt', '预设', 'preset', '结构']
  },
  {
    key: 'prompt-mode-selector', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.modes.label',
    keywords: ['提示词模式', 'prompt mode', 'プロンプトモード', '模式', '添加', '重命名', '删除', '复制', '导入', '导出'],
    anchor: '[data-search-anchor="prompt-mode-selector"]'
  },
  {
    key: 'prompt-assembly', tab: 'prompt',
    labelKey: 'components.settings.settingsPanel.sections.prompt.title',
    keywords: ['组装方式', 'assembly', '伝統的なテンプレート', '传统模板', '预设条目', 'entries', 'legacy'],
    anchor: '[data-search-anchor="prompt-assembly"]'
  },
  {
    key: 'prompt-dynamic-strategy', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.dynamicSection.strategyTitle',
    keywords: ['动态上下文', 'dynamic context', '保留策略', 'strategy', 'preserve', 'single'],
    anchor: '[data-search-anchor="prompt-dynamic-strategy"]'
  },
  {
    key: 'prompt-entries', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.staticSection.title',
    keywords: ['预设条目', 'entries', '条目', 'role', 'chat history', '排序'],
    anchor: '[data-search-anchor="prompt-entries"]'
  },
  {
    key: 'prompt-static', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.staticSection.title',
    keywords: ['静态模板', 'static', 'スタティック', '系统提示词', 'system prompt', '缓存'],
    anchor: '[data-search-anchor="static-prompt"]'
  },
  {
    key: 'prompt-dynamic', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.dynamicSection.title',
    keywords: ['动态上下文', 'dynamic context', 'ダイナミック', '模板', 'template', '变量', 'variables'],
    anchor: '[data-search-anchor="dynamic-context"]'
  },
  {
    key: 'prompt-tool-policy', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.toolPolicy.title',
    keywords: ['工具策略', 'tool policy', 'ツールポリシー', '继承', 'inherit', 'custom', '自定义', '工具列表'],
    anchor: '[data-search-anchor="tool-policy"]'
  },
  {
    key: 'prompt-token-count', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.tokenCount.label',
    keywords: ['token 计数', 'token count', 'トークン数', '静态', '动态', '刷新'],
    anchor: '[data-search-anchor="prompt-token-count"]'
  },
  {
    key: 'prompt-modules', tab: 'prompt',
    labelKey: 'components.settings.promptSettings.modulesReference.title',
    keywords: ['变量参考', 'modules', 'モジュール', '变量', 'variables', '引用', '占位符', 'environment', 'tools'],
    anchor: '[data-search-anchor="prompt-modules"]'
  },
  {
    key: 'tokenCount', tab: 'tokenCount',
    labelKey: 'components.settings.settingsPanel.sections.tokenCount.title',
    keywords: ['token', '计数', 'count', 'カウント', '计算', 'tiktoken', '字符']
  },
  {
    key: 'tokenCount-gemini', tab: 'tokenCount',
    labelKey: 'components.settings.tokenCountSettings.enableChannel',
    keywords: ['gemini', '计数 api', 'count tokens', 'google'],
    anchor: '[data-search-anchor="token-count-gemini"]'
  },
  {
    key: 'tokenCount-openai', tab: 'tokenCount',
    labelKey: 'components.settings.tokenCountSettings.customApi',
    keywords: ['openai', '自定义 api', 'custom api', '兼容', '接口规范'],
    anchor: '[data-search-anchor="token-count-openai"]'
  },
  {
    key: 'tokenCount-anthropic', tab: 'tokenCount',
    labelKey: 'components.settings.tokenCountSettings.enableChannel',
    keywords: ['anthropic', 'claude', 'count tokens', '计数 api'],
    anchor: '[data-search-anchor="token-count-anthropic"]'
  },
  {
    key: 'tokenCount-openai-responses', tab: 'tokenCount',
    labelKey: 'components.settings.tokenCountSettings.enableChannel',
    keywords: ['openai responses', 'responses', 'input tokens'],
    anchor: '[data-search-anchor="token-count-openai-responses"]'
  },
  {
    key: 'sound', tab: 'sound',
    labelKey: 'components.settings.settingsPanel.sections.sound.title',
    keywords: ['通知', 'notification', '通知', '声音', 'sound', 'サウンド', '提示音', 'windows']
  },
  {
    key: 'sound-enabled', tab: 'sound',
    labelKey: 'components.settings.soundSettings.enabled.title',
    keywords: ['启用', 'enabled', '有効', '声音提醒', '开关'],
    anchor: '[data-search-anchor="sound-enabled"]'
  },
  {
    key: 'sound-volume', tab: 'sound',
    labelKey: 'components.settings.soundSettings.volume.title',
    keywords: ['音量', 'volume', 'ボリューム', '大小', '声音'],
    anchor: '[data-search-anchor="volume"]'
  },
  {
    key: 'sound-cooldown', tab: 'sound',
    labelKey: 'components.settings.soundSettings.cooldown.title',
    keywords: ['最小间隔', 'cooldown', 'インターバル', '间隔', '冷却', '频率'],
    anchor: '[data-search-anchor="min-interval"]'
  },
  {
    key: 'sound-cues', tab: 'sound',
    labelKey: 'components.settings.soundSettings.cues.title',
    keywords: ['事件类型', 'cues', 'イベント', '事件', '警告', '错误', '任务完成', '任务失败'],
    anchor: '[data-search-anchor="event-types"]'
  },
  {
    key: 'sound-assets', tab: 'sound',
    labelKey: 'components.settings.soundSettings.assets.title',
    keywords: ['自定义音效', 'assets', '音效文件', '音频', 'audio', '导入'],
    anchor: '[data-search-anchor="custom-sounds"]'
  },
  {
    key: 'sound-test', tab: 'sound',
    labelKey: 'components.settings.soundSettings.test.title',
    keywords: ['测试播放', 'test', 'テスト', '试听', '播放'],
    anchor: '[data-search-anchor="test-play"]'
  },
  {
    key: 'sound-windows-notify', tab: 'sound',
    labelKey: 'components.settings.soundSettings.windowsAgentStopNotification.optionsTitle',
    keywords: ['windows 通知', 'agent 停止', '系统通知', '模板', 'template', '预览', '横幅'],
    anchor: '[data-search-anchor="win-agent-notify"]'
  },
  {
    key: 'appearance', tab: 'appearance',
    labelKey: 'components.settings.settingsPanel.sections.appearance.title',
    keywords: ['外观', 'appearance', '外観', '加载', 'loading', '流式', '平滑', '选中', 'tps', '启动画面']
  },
  {
    key: 'appearance-loading-text', tab: 'appearance',
    labelKey: 'components.settings.appearanceSettings.loadingText.title',
    keywords: ['加载', 'loading', 'ローディング', '加载文字', '提示文字'],
    anchor: '[data-search-anchor="loading-text"]'
  },
  {
    key: 'appearance-smooth-streaming', tab: 'appearance',
    labelKey: 'components.settings.appearanceSettings.smoothStreaming.title',
    keywords: ['流式输出', 'smooth', 'スムーズ', '平滑', 'silky', 'balanced', '模式'],
    anchor: '[data-search-anchor="smooth-output"]'
  },
  {
    key: 'appearance-selection-context', tab: 'appearance',
    labelKey: 'components.settings.appearanceSettings.selectionContext.title',
    keywords: ['选中内容', 'selection', 'セレクション', '选中上下文', '悬停'],
    anchor: '[data-search-anchor="selection-entry"]'
  },
  {
    key: 'appearance-tps-bar', tab: 'appearance',
    labelKey: 'components.settings.appearanceSettings.tpsBar.title',
    keywords: ['tps', '速度', '速率', '显示', 'bar'],
    anchor: '[data-search-anchor="tps-bar"]'
  },
  {
    key: 'appearance-splash', tab: 'appearance',
    labelKey: 'components.settings.appearanceSettings.splash.title',
    keywords: ['启动画面', 'splash', 'スプラッシュ', '启动动画', '开机'],
    anchor: '[data-search-anchor="splash-animation"]'
  },
  {
    key: 'appearance-wallpaper', tab: 'appearance',
    labelKey: 'components.settings.appearanceSettings.wallpaper.title',
    keywords: ['背景图', 'wallpaper', '壁纸', '背景', 'background', '图片', '透明度', 'opacity', '画像', '背景画像', '不透明度'],
    anchor: '[data-search-anchor="wallpaper"]'
  },
  {
    key: 'memory', tab: 'memory',
    labelKey: 'components.settings.settingsPanel.sections.memory.title',
    keywords: ['记忆', 'memory', 'メモリ', '长期记忆', '向量', '检索', 'retrieval', '知识', '条目']
  },
  {
    key: 'memory-toggle', tab: 'memory',
    labelKey: 'components.settings.settingsPanel.memory.enabled.label',
    keywords: ['启用', 'enabled', '有効', '长期记忆', '总开关'],
    anchor: '[data-search-anchor="memory-toggle"]'
  },
  {
    key: 'memory-custom-prompt', tab: 'memory',
    labelKey: 'components.settings.settingsPanel.memory.systemPrompt.title',
    keywords: ['自定义提示词', 'system prompt', 'プロンプト', '提示词', '记忆'],
    anchor: '[data-search-anchor="memory-custom-prompt"]'
  },
  {
    key: 'memory-runtime', tab: 'memory',
    labelKey: 'components.settings.settingsPanel.memory.runtime.title',
    keywords: ['运行时参数', 'runtime', '実行時', '唤醒', 'wake', '字节', '分页', '行数'],
    anchor: '[data-search-anchor="memory-runtime"]'
  },
  {
    key: 'memory-raw-entries', tab: 'memory',
    labelKey: 'components.settings.settingsPanel.memory.rawEntries.title',
    keywords: ['原始记忆', 'entries', '条目', '编辑', '删除', '记忆记录', '添加记忆', 'add memory', '手動', '追加', '记住', 'remember'],
    anchor: '[data-search-anchor="memory-raw-entries"]'
  },
  {
    key: 'sandbox', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sections.sandbox.title',
    keywords: ['沙箱', 'sandbox', 'サンドボックス', '运行代码', 'run code', '隔离', '代码执行', '安全运行', '安全', 'security', 'セキュリティ', '代码隔离']
  },
  {
    key: 'sandbox-toggle', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sandbox.enabled.label',
    keywords: ['启用', 'enabled', '有効', '沙箱开关', '总开关'],
    anchor: '[data-search-anchor="sandbox-toggle"]'
  },
  {
    key: 'sandbox-languages', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sandbox.languages.title',
    keywords: ['语言', 'language', '言語', 'python', 'javascript', 'bash', 'powershell', 'sh', '白名单'],
    anchor: '[data-search-anchor="sandbox-languages"]'
  },
  {
    key: 'sandbox-timeout', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sandbox.timeout.title',
    keywords: ['超时', 'timeout', 'タイムアウト', '时间限制'],
    anchor: '[data-search-anchor="sandbox-timeout"]'
  },
  {
    key: 'sandbox-output', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sandbox.output.title',
    keywords: ['输出', 'output', '出力', '行数', '截断', 'lines'],
    anchor: '[data-search-anchor="sandbox-output"]'
  },
  {
    key: 'sandbox-cleanup', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sandbox.cleanup.title',
    keywords: ['清理', 'cleanup', 'クリーンアップ', '临时目录', 'temp', '删除'],
    anchor: '[data-search-anchor="sandbox-cleanup"]'
  },
  {
    key: 'sandbox-info', tab: 'sandbox',
    labelKey: 'components.settings.settingsPanel.sandbox.info.title',
    keywords: ['安全', 'security', 'セキュリティ', '隔离', '隔离级别', 'isolation', '限制', '沙箱安全'],
    anchor: '[data-search-anchor="sandbox-info"]'
  },
  {
    key: 'remoteControl', tab: 'remoteControl',
    labelKey: 'components.settings.settingsPanel.sections.remoteControl.title',
    keywords: ['远程控制', 'remote control', 'リモートコントロール', '局域网', 'lan', '手机', 'mobile', '移动端', '端口', 'port', 'ポート', '控制']
  },
  {
    key: 'remoteControl-enable', tab: 'remoteControl',
    labelKey: 'components.settings.settingsPanel.remoteControlSettings.enabled.label',
    keywords: ['启用', 'enabled', '有効', '远程控制开关', '总开关', '开启'],
    anchor: '[data-search-anchor="remote-control-enable"]'
  },
  {
    key: 'remoteControl-port', tab: 'remoteControl',
    labelKey: 'components.settings.settingsPanel.remoteControlSettings.port.label',
    keywords: ['端口', 'port', 'ポート', '端口号', '监听端口', '自定义端口'],
    anchor: '[data-search-anchor="remote-control-port"]'
  },
  {
    key: 'remoteControl-urls', tab: 'remoteControl',
    labelKey: 'components.settings.settingsPanel.remoteControlSettings.urls.title',
    keywords: ['访问地址', 'url', '地址', '局域网地址', 'lan', 'ip', '手机访问', '扫码'],
    anchor: '[data-search-anchor="remote-control-urls"]'
  },
  {
    key: 'remoteControl-info', tab: 'remoteControl',
    labelKey: 'components.settings.settingsPanel.remoteControlSettings.info.title',
    keywords: ['安全', 'security', 'セキュリティ', '局域网', '仅内网', '提示', '风险'],
    anchor: '[data-search-anchor="remote-control-info"]'
  },
  {
    key: 'general', tab: 'general',
    labelKey: 'components.settings.settingsPanel.sections.general.title',
    keywords: ['通用', 'general', '一般', '代理', 'proxy', 'プロキシ', '语言', 'language', '言語', '存储路径', 'storage', '保存先', '导入', 'import', 'インポート', '导出', 'export', 'エクスポート', '应用信息', 'about', 'バージョン', '版本', '工作区', 'workspace', 'github']
  },
  {
    key: 'general-proxy', tab: 'general',
    labelKey: 'components.settings.settingsPanel.proxy.title',
    keywords: ['代理', 'proxy', 'プロキシ', '代理地址', 'proxy url'],
    anchor: '[data-search-anchor="proxy"]'
  },
  {
    key: 'general-language', tab: 'general',
    labelKey: 'components.settings.settingsPanel.language.title',
    keywords: ['语言', 'language', '言語', '界面语言', '简体中文', 'english', '日本語'],
    anchor: '[data-search-anchor="language"]'
  },
  {
    key: 'general-workspaceBehavior', tab: 'general',
    labelKey: 'components.settings.settingsPanel.workspaceBehavior.title',
    keywords: ['工作区', 'workspace', 'ワークスペース', '工作区行为', '上次', '恢复', '记住', '记忆', 'restore'],
    anchor: '[data-search-anchor="workspace-behavior"]'
  },
  {
    key: 'general-storage', tab: 'general',
    labelKey: 'components.settings.storageSettings.title',
    keywords: ['存储路径', 'storage', '保存先', '数据目录', '自定义路径', '迁移'],
    anchor: '[data-search-anchor="storage"]'
  },
  {
    key: 'general-importExport', tab: 'general',
    labelKey: 'components.settings.settingsPanel.exportImport.title',
    keywords: ['导入', 'import', 'インポート', '导出', 'export', 'エクスポート', '备份设置', '配置转移'],
    anchor: '[data-search-anchor="importExport"]'
  },
  {
    key: 'general-appInfo', tab: 'general',
    labelKey: 'components.settings.settingsPanel.appInfo.title',
    keywords: ['应用信息', 'about', 'バージョン', '版本', '版本号', '仓库', 'repository'],
    anchor: '[data-search-anchor="appInfo"]'
  },
  {
    key: 'general-update', tab: 'general',
    labelKey: 'components.settings.settingsPanel.update.title',
    keywords: ['更新', 'update', 'アップデート', '自动更新', '自动检查', '版本检查', 'github', 'release', 'リリース'],
    anchor: '[data-search-anchor="update"]'
  },
  {
    key: 'usage', tab: 'usage',
    labelKey: 'components.settings.settingsPanel.sections.usage.title',
    keywords: ['用量', 'usage', '使用量', '统计', 'stats', '統計', 'token用量', '使用时间', 'activity', 'アクティビティ', '热力图']
  }
]

const searchQuery = ref('')
const searchFocused = ref(false)
const activeSearchIndex = ref(0)
const scrollbarRef = ref<InstanceType<typeof CustomScrollbar>>()

// 关键词变化后重置选中项，避免旧索引落到不存在的条目上
watch(searchQuery, () => {
  activeSearchIndex.value = 0
})

// 归一化：小写 + 去掉所有空白（'token 用量' 与 'token用量' 可互相匹配）
const normalizedQuery = computed(() => searchQuery.value.trim().toLowerCase().replace(/\s+/g, ''))

/** 搜索是否生效（决定侧边栏高亮/置灰） */
const searchActive = computed(() => normalizedQuery.value.length > 0)

/** 匹配的搜索结果（按页签顺序排序） */
const searchResults = computed(() => {
  const q = normalizedQuery.value
  if (!q) return []
  const tabOrder = new Map(tabs.value.map((tab, i) => [tab.id, i]))
  return SEARCH_INDEX
    .filter((entry) => {
      const label = t(entry.labelKey).toLowerCase().replace(/\s+/g, '')
      return label.includes(q) || entry.keywords.some((k) => k.toLowerCase().replace(/\s+/g, '').includes(q))
    })
    .sort((a, b) => (tabOrder.get(a.tab) ?? 99) - (tabOrder.get(b.tab) ?? 99))
})

/** 含匹配项结果的页签集合（侧边栏高亮用） */
const tabsWithMatches = computed(() => {
  const set = new Set<SettingsTab>()
  for (const entry of searchResults.value) set.add(entry.tab)
  return set
})

function tabIcon(tabId: SettingsTab): string {
  return tabs.value.find((tab) => tab.id === tabId)?.icon || 'codicon-settings-gear'
}

function moveSearchSelection(delta: number) {
  const count = searchResults.value.length
  if (count === 0) return
  activeSearchIndex.value = (activeSearchIndex.value + delta + count) % count
}

/** 跳转到搜索结果：切换页签 → 清空搜索 → 等待渲染 → 滚动定位并闪烁高亮 */
function openSearchResult(entry: SearchIndexEntry) {
  searchFocused.value = false
  // L-2：跳转完成即清空搜索词，侧边栏恢复常态高亮（避免跳转后仍整页置灰/高亮）
  searchQuery.value = ''
  activeSearchIndex.value = 0
  // 工具配置面板内的锚点：先请求 ToolsSettings 展开对应配置面板，锚点才会出现在 DOM 中
  if (entry.key === 'apply-diff-config') {
    pendingToolConfigExpand.value = 'apply_diff'
  }
  settingsStore.setActiveTab(entry.tab)
  nextTick(() => {
    // 卸载守卫（仿 CustomScrollbar.vue）：组件可能在 nextTick 待执行期间已卸载（onUnmounted
    // 已跑完），此时直接跳过——不再新建 rAF / searchFlashTimer，否则没有清理时机（残留 1.6s 定时器）
    if (isUnmounted) return
    const section = document.querySelector('.settings-section')
    if (!section) return
    let target: HTMLElement | null = null
    // 回退链：精确锚点 → h4 → h3 → 页内第一个锚点元素 → 节容器本身
    if (entry.anchor) {
      target = section.querySelector<HTMLElement>(entry.anchor)
    }
    if (!target) {
      target = section.querySelector<HTMLElement>('h4')
    }
    if (!target) {
      target = section.querySelector<HTMLElement>('h3')
    }
    if (!target) {
      target = section.querySelector<HTMLElement>('[data-search-anchor]')
    }
    if (!target) {
      target = section as HTMLElement
    }
    const scrollContainer = scrollbarRef.value?.getContainer()
    // 等 v-if 渲染的节内容布局完成再滚动，避免滚动位置偏移
    requestAnimationFrame(() => {
      // 卸载守卫：rAF 回调可能在组件卸载后才执行，此时直接跳过（不再触碰 DOM / 新建定时器）
      if (isUnmounted) return
      if (scrollContainer) {
        // L-1：直接按目标元素相对滚动容器的偏移计算目标位置（含 12px 顶部间距），
        // 避免「scrollIntoView smooth 未推进时同步读 rect」的时序冲突，也不打断动画
        const containerRect = scrollContainer.getBoundingClientRect()
        const targetRect = target!.getBoundingClientRect()
        const targetTop = scrollContainer.scrollTop + (targetRect.top - containerRect.top) - 12
        scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
      } else {
        target!.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
    })
    target!.classList.add('search-flash')
    searchFlashTimer = setTimeout(() => target!.classList.remove('search-flash'), 1600)
  })
}

onUnmounted(() => {
  // 先置卸载标记：nextTick 回调若在卸载后执行，直接跳过（不再新建 rAF / searchFlashTimer）
  isUnmounted = true
  // 统一清理未触发的定时器，避免卸载后仍修改状态
  if (validateDebounceTimer) {
    clearTimeout(validateDebounceTimer)
    validateDebounceTimer = null
  }
  if (storageMessageTimer) {
    clearTimeout(storageMessageTimer)
    storageMessageTimer = null
  }
  if (proxySaveMessageTimer) {
    clearTimeout(proxySaveMessageTimer)
    proxySaveMessageTimer = null
  }
  if (importExportMessageTimer) {
    clearTimeout(importExportMessageTimer)
    importExportMessageTimer = null
  }
  if (searchFlashTimer) {
    clearTimeout(searchFlashTimer)
    searchFlashTimer = null
  }
})

// 代理设置
const proxySettings = reactive({
  enabled: false,
  url: ''
})

// 语言设置
const languageSetting = ref<string>('auto')

// 工作区行为（启动时如何处理上次打开的工作区）
const workspaceBehavior = ref<'restore' | 'none'>('restore')
const workspaceBehaviorOptions = computed<SelectOption[]>(() => [
  { value: 'restore', label: t('components.settings.settingsPanel.workspaceBehavior.optionRestore') },
  { value: 'none', label: t('components.settings.settingsPanel.workspaceBehavior.optionNone') }
])

// 是否正在保存
const isSaving = ref(false)
// 保存状态消息
const saveMessage = ref('')
// 保存消息类型（避免用文案字符串比较判断样式）
const saveMessageType = ref<'success' | 'error'>('success')

// 消息自动消失定时器（组件卸载时统一清理，避免卸载后仍修改状态）
let storageMessageTimer: ReturnType<typeof setTimeout> | null = null
let proxySaveMessageTimer: ReturnType<typeof setTimeout> | null = null
let importExportMessageTimer: ReturnType<typeof setTimeout> | null = null
// 搜索结果跳转闪烁高亮清除定时器（组件卸载时统一清理）
let searchFlashTimer: ReturnType<typeof setTimeout> | null = null
// 组件卸载标记（仿 CustomScrollbar.vue）：nextTick 回调在卸载后执行时据此跳过
let isUnmounted = false
// 存储路径设置
const storageSettings = reactive({
  currentPath: '',
  defaultPath: '',
  customPath: '',
  isCustom: false
})
const isValidatingPath = ref(false)
const pathValidationResult = ref<{ valid: boolean; message?: string } | null>(null)
const isMigrating = ref(false)
const showMigrateDialog = ref(false)
const storageMessage = ref('')
const storageMessageType = ref<'success' | 'error' | 'info'>('success')
const needsReload = ref(false) // 迁移完成后需要重新加载
let pathValidationRequestId = 0

// 加载设置
async function loadSettings() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getSettings, {})
    if (response?.settings?.proxy) {
      proxySettings.enabled = response.settings.proxy.enabled || false
      proxySettings.url = response.settings.proxy.url || ''
    }
    // 加载语言设置
    if (response?.settings?.ui?.language) {
      languageSetting.value = response.settings.ui.language
      setLanguage(response.settings.ui.language)
    }
    // 加载工作区行为（默认恢复上次打开的工作区）
    workspaceBehavior.value = response?.settings?.ui?.workspaceBehavior === 'none' ? 'none' : 'restore'
    // 加载自动更新检查开关（默认开启）
    checkUpdatesEnabled.value = response?.settings?.checkForUpdates !== false
    
    // 加载存储路径配置
    await loadStorageConfig()
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
}

// 应用信息（名称/版本号来自扩展 package.json）
const appInfo = ref<{ name: string; displayName: string; version: string }>({
  name: '',
  displayName: '',
  version: ''
})

async function loadAppInfo() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getAppInfo, {})
    if (response) {
      appInfo.value = {
        name: response.name || '',
        displayName: response.displayName || '',
        version: response.version || ''
      }
    }
  } catch (error) {
    console.error('Failed to load app info:', error)
  }
}

// 加载存储路径配置
async function loadStorageConfig() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.getConfig'], {})
    if (response) {
      storageSettings.currentPath = response.effectivePath || ''
      storageSettings.defaultPath = response.defaultPath || ''
      storageSettings.customPath = response.config?.customDataPath || ''
      storageSettings.isCustom = !!response.config?.customDataPath
    }
  } catch (error) {
    console.error('Failed to load storage config:', error)
  }
}

// 打开系统文件夹选择器
async function pickStoragePath() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.selectFolder'], {}, { timeoutMs: 120000 })
    if (response?.path) {
      storageSettings.customPath = response.path
    }
  } catch (error: any) {
    storageMessage.value = error?.message || t('components.settings.storageSettings.notifications.validationFailed').replace('{error}', '')
    storageMessageType.value = 'error'
  }
}

// 在文件资源管理器中打开存储目录
async function openStoragePathInExplorer() {
  try {
    await sendToExtension(MESSAGE_NAMES['storagePath.openInExplorer'], {
      path: storageSettings.currentPath
    })
  } catch (error: any) {
    storageMessage.value = error?.message || t('components.settings.storageSettings.notifications.openInExplorerFailed').replace('{error}', '')
    storageMessageType.value = 'error'
  }
}

// 验证路径
async function validateStoragePath(path: string) {
  const normalizedPath = path.trim()
  const requestId = ++pathValidationRequestId

  if (!normalizedPath) {
    pathValidationResult.value = null
    isValidatingPath.value = false
    return
  }

  isValidatingPath.value = true
  pathValidationResult.value = null

  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.validate'], { path: normalizedPath })
    if (requestId === pathValidationRequestId && storageSettings.customPath.trim() === normalizedPath) {
      pathValidationResult.value = {
        valid: response?.valid ?? false,
        message: response?.error
      }
    }
  } catch (error: any) {
    if (requestId === pathValidationRequestId && storageSettings.customPath.trim() === normalizedPath) {
      pathValidationResult.value = {
        valid: false,
        message: error?.message || 'Validation failed'
      }
    }
  } finally {
    if (requestId === pathValidationRequestId) {
      isValidatingPath.value = false
    }
  }
}

// 防抖验证
let validateDebounceTimer: ReturnType<typeof setTimeout> | null = null
function debouncedValidatePath(path: string) {
  if (validateDebounceTimer) {
    clearTimeout(validateDebounceTimer)
  }
  pathValidationRequestId++
  isValidatingPath.value = path.trim() !== ''
  pathValidationResult.value = null
  validateDebounceTimer = setTimeout(() => {
    validateStoragePath(path)
  }, 500)
}

// 监听自定义路径变化
watch(() => storageSettings.customPath, (newPath) => {
  debouncedValidatePath(newPath)
})

// 应用存储路径（迁移数据到新路径）
async function applyStoragePath() {
  if (isMigrating.value) return

  const newPath = storageSettings.customPath.trim()

  if (!newPath) {
    storageMessage.value = t('components.settings.storageSettings.notifications.applyEmptyHint')
    storageMessageType.value = 'info'
    return
  }

  if (!pathValidationResult.value?.valid) {
    // 路径验证未通过
    storageMessage.value = pathValidationResult.value?.message || t('components.settings.storageSettings.notifications.validationFailed').replace('{error}', '')
    storageMessageType.value = 'error'
    return
  }
  
  // 使用迁移接口来应用新路径（迁移到新路径）
  confirmMigrate()
}

// 重置为默认路径
async function resetStoragePath() {
  if (isMigrating.value) return

  if (!storageSettings.isCustom) {
    // 已经是默认路径，无需重置
    storageMessage.value = t('components.settings.storageSettings.notifications.alreadyDefault')
    storageMessageType.value = 'info'
    return
  }
  
  isMigrating.value = true
  needsReload.value = false
  
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.reset'], {})
    
    if (response?.success) {
      storageSettings.customPath = ''
      pathValidationResult.value = null
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationSuccess')
      storageMessageType.value = 'success'
      needsReload.value = true  // 重置也需要重新加载窗口才能生效
      await loadStorageConfig()
    } else {
      storageMessage.value = response?.error || 'Failed to reset storage path'
      storageMessageType.value = 'error'
    }
  } catch (error: any) {
    storageMessage.value = error?.message || 'Failed to reset storage path'
    storageMessageType.value = 'error'
  } finally {
    isMigrating.value = false
  }
  
  // 只有非成功消息才自动消失
  if (!needsReload.value) {
    if (storageMessageTimer) clearTimeout(storageMessageTimer)
    storageMessageTimer = setTimeout(() => {
      storageMessage.value = ''
    }, 5000)
  }
}

// 打开迁移确认对话框
function confirmMigrate() {
  showMigrateDialog.value = true
}

// 执行数据迁移
async function executeMigration() {
  if (isMigrating.value) return

  showMigrateDialog.value = false
  isMigrating.value = true
  needsReload.value = false
  
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.migrate'], {
      path: storageSettings.customPath.trim()
    })
    
    if (response?.success) {
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationSuccess')
      storageMessageType.value = 'success'
      needsReload.value = true  // 迁移成功，需要重新加载
      await loadStorageConfig()
    } else {
      const errorMsg = response?.error || 'Migration failed'
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationFailed').replace('{error}', errorMsg)
      storageMessageType.value = 'error'
    }
  } catch (error: any) {
    storageMessage.value = t('components.settings.storageSettings.notifications.migrationFailed').replace('{error}', error?.message || 'Unknown error')
    storageMessageType.value = 'error'
  } finally {
    isMigrating.value = false
  }
  
  // 只有非成功消息才自动消失
  if (!needsReload.value) {
    if (storageMessageTimer) clearTimeout(storageMessageTimer)
    storageMessageTimer = setTimeout(() => {
      storageMessage.value = ''
    }, 5000)
  }
}

// 重新加载窗口
async function reloadWindow() {
  try {
    await sendToExtension(MESSAGE_NAMES.reloadWindow, {})
  } catch (error) {
    console.error('Failed to reload window:', error)
  }
}

// 保存代理设置
async function saveProxySettings() {
  isSaving.value = true
  saveMessage.value = ''
  
  try {
    await sendToExtension(MESSAGE_NAMES.updateProxySettings, {
      proxySettings: {
        enabled: proxySettings.enabled,
        url: proxySettings.url.trim() || undefined
      }
    })
    saveMessage.value = t('components.settings.settingsPanel.proxy.saveSuccess')
    saveMessageType.value = 'success'
    if (proxySaveMessageTimer) clearTimeout(proxySaveMessageTimer)
    proxySaveMessageTimer = setTimeout(() => {
      saveMessage.value = ''
    }, 2000)
  } catch (error) {
    console.error('Failed to save proxy settings:', error)
    saveMessage.value = t('components.settings.settingsPanel.proxy.saveFailed')
    saveMessageType.value = 'error'
  } finally {
    isSaving.value = false
  }
}

// ========== 自动更新设置 ==========

const checkUpdatesEnabled = ref(true)
const updateChannel = ref<'stable' | 'nightly'>('stable')
const isUpdateChecking = ref(false)
const isUpdating = ref(false)
const updateCheckResult = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

// 保存自动检查开关
async function saveCheckUpdates(value: boolean) {
  const previous = checkUpdatesEnabled.value
  checkUpdatesEnabled.value = value
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.updateSettings, { settings: { checkForUpdates: value } })
    // SettingsHandler.updateSettings 失败时 resolve { success: false }（不抛错），
    // 必须显式检查并回滚 UI 状态，否则界面显示已切换而实际未保存（对比 saveUpdateChannel）
    if (response?.success === false) {
      checkUpdatesEnabled.value = previous
      console.error('Failed to save update check setting:', response?.error?.message || response?.error)
    }
  } catch (error) {
    checkUpdatesEnabled.value = previous
    console.error('Failed to save update check setting:', error)
  }
}

// 保存更新渠道（stable 正式版 / nightly 每日构建）
async function saveUpdateChannel(value: string) {
  const channel = value === 'nightly' ? 'nightly' : 'stable'
  const previous = updateChannel.value
  updateChannel.value = channel
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.updateSettings, { settings: { updateChannel: channel } })
    // SettingsHandler.updateSettings 失败时 resolve { success: false }（不抛错，内部 try/catch 捕获），
    // 必须显式检查并回滚 UI 选择，否则界面显示已切换而实际未保存（静默丢失用户操作）。
    if (response?.success === false) {
      updateChannel.value = previous
      console.error('Failed to save update channel setting:', response?.error?.message || response?.error)
    }
  } catch (error) {
    updateChannel.value = previous
    console.error('Failed to save update channel setting:', error)
  }
}

// 立即检查更新（忽略 24h 节流）
async function checkUpdateNow() {
  if (isUpdateChecking.value) return
  isUpdateChecking.value = true
  updateCheckResult.value = null
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.checkUpdateNow, {})
    const status = response?.status
    if (!status) {
      updateCheckResult.value = { type: 'error', text: t('components.settings.settingsPanel.update.error') }
    } else if (status.state === 'updateAvailable') {
      updateCheckResult.value = {
        type: 'success',
        text: t('components.settings.settingsPanel.update.updateAvailable').replace('{version}', status.update?.version || '')
      }
    } else if (status.state === 'upToDate') {
      updateCheckResult.value = { type: 'success', text: t('components.settings.settingsPanel.update.upToDate') }
    } else if (status.state === 'disabled') {
      updateCheckResult.value = { type: 'info', text: t('components.settings.settingsPanel.update.disabledHint') }
    } else if (status.state === 'error') {
      updateCheckResult.value = { type: 'error', text: t('components.settings.settingsPanel.update.error') }
    }
  } catch (error) {
    console.error('Failed to check update:', error)
    updateCheckResult.value = { type: 'error', text: t('components.settings.settingsPanel.update.error') }
  } finally {
    isUpdateChecking.value = false
  }
}

// 一键更新：立即检查，有新版本自动下载并安装（安装完成后后端提示重启窗口，用户只需重启）
async function updateNow() {
  if (isUpdating.value || isUpdateChecking.value) return
  isUpdating.value = true
  updateCheckResult.value = null
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.updateNow, {})
    if (response?.alreadyUpToDate) {
      updateCheckResult.value = { type: 'success', text: t('components.settings.settingsPanel.update.upToDate') }
    } else if (response?.version) {
      updateCheckResult.value = {
        type: 'success',
        text: t('components.settings.settingsPanel.update.installedHint').replace('{version}', response.version)
      }
    }
  } catch (error: any) {
    console.error('Failed to update now:', error)
    updateCheckResult.value = { type: 'error', text: error?.message || t('components.settings.settingsPanel.update.error') }
  } finally {
    isUpdating.value = false
  }
}

// 更新语言设置
async function updateLanguage(lang: string) {
  const previous = languageSetting.value
  languageSetting.value = lang
  setLanguage(lang as any)

  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.updateUISettings, {
      ui: { language: lang }
    })
    // 失败时 resolve { success: false }（不抛错）：回滚语言选择与运行时语言，
    // 否则界面显示已切换而实际未保存
    if (response?.success === false) {
      languageSetting.value = previous
      setLanguage(previous as any)
      console.error('Failed to save language setting:', response?.error?.message || response?.error)
    }
  } catch (error) {
    languageSetting.value = previous
    setLanguage(previous as any)
    console.error('Failed to save language setting:', error)
  }
}

// 保存工作区行为
async function saveWorkspaceBehavior(value: string) {
  const next = value === 'none' ? 'none' : 'restore'
  workspaceBehavior.value = next
  try {
    await sendToExtension('updateUISettings', {
      ui: { workspaceBehavior: next }
    })
  } catch (error) {
    console.error('Failed to save workspace behavior setting:', error)
  }
}

// ========== 设置导入/导出 ==========
const isExporting = ref(false)
const isImporting = ref(false)
const importExportMessage = ref('')
const importExportMessageType = ref<'success' | 'error'>('success')

async function handleExportSettings() {
  isExporting.value = true
  importExportMessage.value = ''
  
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES['settings.export'], {})
    if (response?.success) {
      importExportMessage.value = t('components.settings.settingsPanel.exportImport.exportSuccess', { path: response.filePath })
      importExportMessageType.value = 'success'
    } else if (response?.cancelled) {
      // 用户取消了，不显示消息
    } else {
      importExportMessage.value = t('components.settings.settingsPanel.exportImport.exportFailed')
      importExportMessageType.value = 'error'
    }
  } catch (error: any) {
    importExportMessage.value = error?.message || t('components.settings.settingsPanel.exportImport.exportFailed')
    importExportMessageType.value = 'error'
  } finally {
    isExporting.value = false
    if (importExportMessage.value) {
      if (importExportMessageTimer) clearTimeout(importExportMessageTimer)
      importExportMessageTimer = setTimeout(() => { importExportMessage.value = '' }, 5000)
    }
  }
}

async function handleImportSettings() {
  isImporting.value = true
  importExportMessage.value = ''
  
  try {
    // 先让用户选择导入方式（弹出确认对话框由扩展端处理）
    // 这里直接调用导入，扩展端会弹出文件选择器和覆盖确认
    const response = await sendToExtension<any>(MESSAGE_NAMES['settings.import'], { overwrite: false })
    if (response?.success) {
      const parts: string[] = []
      if (response.imported?.vscodeSettings) parts.push(t('components.settings.settingsPanel.exportImport.vscodeSettings'))
      if (response.imported?.channelConfigs > 0) parts.push(`${response.imported.channelConfigs} ${t('components.settings.settingsPanel.exportImport.channelConfigs')}`)
      if (response.imported?.mcpServers > 0) parts.push(`${response.imported.mcpServers} ${t('components.settings.settingsPanel.exportImport.mcpServers')}`)
      if (response.imported?.skills > 0) parts.push(`${response.imported.skills} ${t('components.settings.settingsPanel.exportImport.skills')}`)
      importExportMessage.value = parts.length > 0
        ? t('components.settings.settingsPanel.exportImport.importSuccess', { items: parts.join('、') })
        : t('components.settings.settingsPanel.exportImport.importNoItems')
      importExportMessageType.value = 'success'
    } else if (response?.cancelled) {
      // 用户取消了
    } else {
      importExportMessage.value = response?.errors?.join('；') || t('components.settings.settingsPanel.exportImport.importFailed')
      importExportMessageType.value = 'error'
    }
  } catch (error: any) {
    importExportMessage.value = error?.message || t('components.settings.settingsPanel.exportImport.importFailed')
    importExportMessageType.value = 'error'
  } finally {
    isImporting.value = false
    if (importExportMessage.value) {
      if (importExportMessageTimer) clearTimeout(importExportMessageTimer)
      importExportMessageTimer = setTimeout(() => { importExportMessage.value = '' }, 8000)
    }
  }
}

// ========== 用量统计（Token 用量摘要，内嵌于设置面板） ==========
const usageStats = ref<UsageStatsResult | null>(null)
const usageRange = ref<UsageTimeRange>('all')
const usageLoading = ref(false)
const usageLoadError = ref('')
// 用量统计请求序号：慢响应到达时若已被更新的请求取代，直接丢弃（仿 validateStoragePath 的 pathValidationRequestId）
let usageStatsRequestId = 0

/** 快捷范围 → 起始时间（本地 00:00 对齐；'all' 不限制） */
function usageRangeToStartTime(range: UsageTimeRange): number | undefined {
  if (range === 'all') return undefined
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  if (range === 'today') return startOfToday.getTime()
  const days = range === '7d' ? 6 : 29
  return startOfToday.getTime() - days * 24 * 60 * 60 * 1000
}

async function loadUsageStats() {
  const requestId = ++usageStatsRequestId
  usageLoading.value = true
  usageLoadError.value = ''
  try {
    const startTime = usageRangeToStartTime(usageRange.value)
    const query: Record<string, unknown> = startTime !== undefined ? { startTime } : {}
    const result = await sendToExtension<UsageStatsResult>(MESSAGE_NAMES['usage.getStats'], query)
    // 仅采纳最新一次请求的响应：慢响应不得覆盖新范围/新页签触发的加载结果
    if (requestId === usageStatsRequestId) {
      usageStats.value = result
    }
  } catch (error) {
    if (requestId === usageStatsRequestId) {
      usageLoadError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (requestId === usageStatsRequestId) {
      usageLoading.value = false
    }
  }
}

// 切换时间范围时重新聚合
watch(usageRange, () => loadUsageStats())

// 进入“用量统计”页签时刷新数据
watch(() => settingsStore.activeTab, (tab) => {
  if (tab === 'usage') loadUsageStats()
})

// 初始化
onMounted(() => {
  loadSettings()
  loadAppInfo()
  loadUsageStats()
})
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <h3>{{ t('components.settings.settingsPanel.title') }}</h3>
      <!-- T12：拆至 SettingsSearchBox（搜索框 + 结果下拉） -->
      <SettingsSearchBox
        v-model:query="searchQuery"
        v-model:focused="searchFocused"
        v-model:active-index="activeSearchIndex"
        :search-active="searchActive"
        :results="searchResults"
        :tab-icon="tabIcon"
        @open="openSearchResult"
        @move="moveSearchSelection"
      />
      <button class="settings-close-btn" :title="t('components.settings.settingsPanel.backToChat')" @click="settingsStore.showChat">
        <i class="codicon codicon-close"></i>
      </button>
    </div>
    
    <div class="settings-content">
      <!-- 左侧页签（T12：拆至 SettingsSidebar；可折叠：展开显示图标+文字，折叠仅图标+tooltip） -->
      <SettingsSidebar
        :tabs="tabs"
        :active-tab="settingsStore.activeTab"
        v-model:collapsed="sidebarCollapsed"
        :search-active="searchActive"
        :tabs-with-matches="tabsWithMatches"
        @select="settingsStore.setActiveTab"
      />
      
      <!-- 右侧内容 -->
      <CustomScrollbar ref="scrollbarRef" class="settings-main-scrollbar">
        <div class="settings-main">
          <!-- 渠道设置 -->
          <div v-if="settingsStore.activeTab === 'channel'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.channel.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.channel.description') }}</p>
            
            <ChannelSettings />
          </div>
          
          <!-- 工具设置 -->
          <div v-if="settingsStore.activeTab === 'tools'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.tools.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.tools.description') }}</p>
            
            <ToolsSettings />
          </div>
          
          <!-- 自动执行设置 -->
          <div v-if="settingsStore.activeTab === 'autoExec'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.autoExec.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.autoExec.description') }}</p>
            
            <AutoExecSettings />
          </div>
          
          <!-- MCP 设置 -->
          <div v-if="settingsStore.activeTab === 'mcp'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.mcp.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.mcp.description') }}</p>
            
            <McpSettings />
          </div>
          
          <!-- 存档点设置 -->
          <div v-if="settingsStore.activeTab === 'checkpoint'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.checkpoint.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.checkpoint.description') }}</p>
            
            <CheckpointSettings />
          </div>
          
          <!-- 总结设置 -->
          <div v-if="settingsStore.activeTab === 'summarize'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.summarize.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.summarize.description') }}</p>
            
            <SummarizeSettings />
          </div>
          
          <!-- 图像生成设置 -->
          <div v-if="settingsStore.activeTab === 'imageGen'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.imageGen.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.imageGen.description') }}</p>
            
            <GenerateImageSettings />
          </div>
          
          <!-- 扩展依赖设置 -->
          <div v-if="settingsStore.activeTab === 'dependencies'" class="settings-section">
            <DependencySettings />
          </div>
          
          <!-- 上下文感知设置 -->
          <div v-if="settingsStore.activeTab === 'context'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.context.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.context.description') }}</p>
            
            <ContextSettings />
          </div>
          
          <!-- 提示词设置 -->
          <div v-if="settingsStore.activeTab === 'prompt'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.prompt.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.prompt.description') }}</p>
            
            <PromptSettings />
          </div>
          
          <!-- Token 计数设置 -->
          <div v-if="settingsStore.activeTab === 'tokenCount'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.tokenCount.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.tokenCount.description') }}</p>
            
            <TokenCountSettings />
          </div>
          
          <!-- 子代理设置 -->
          <div v-if="settingsStore.activeTab === 'subagents'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.subagents.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.subagents.description') }}</p>
            
            <SubAgentsSettings />
          </div>

          <!-- 通知系统 -->
          <div v-if="settingsStore.activeTab === 'sound'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.sound.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.sound.description') }}</p>

            <SoundSettings />
          </div>

          <!-- 外观设置 -->
          <div v-if="settingsStore.activeTab === 'appearance'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.appearance.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.appearance.description') }}</p>

            <AppearanceSettings />
          </div>

          <!-- 记忆设置 -->
          <div v-if="settingsStore.activeTab === 'memory'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.memory.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.memory.description') }}</p>

            <MemorySettings />
          </div>

          <!-- 沙箱设置 -->
          <div v-if="settingsStore.activeTab === 'sandbox'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.sandbox.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.sandbox.description') }}</p>

            <SandboxSettings />
          </div>

          <!-- 远程控制设置 -->
          <div v-if="settingsStore.activeTab === 'remoteControl'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.remoteControl.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.remoteControl.description') }}</p>

            <RemoteControlSettings />
          </div>
          
          <!-- 通用设置（T12：拆至 GeneralSettingsSection） -->
          <div v-if="settingsStore.activeTab === 'general'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.general.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.general.description') }}</p>

            <GeneralSettingsSection
              v-model:proxy-enabled="proxySettings.enabled"
              v-model:proxy-url="proxySettings.url"
              :is-saving="isSaving"
              :save-message="saveMessage"
              :save-message-type="saveMessageType"
              @save-proxy="saveProxySettings"
              :language="languageSetting"
              @update:language="updateLanguage"
              v-model:check-updates-enabled="checkUpdatesEnabled"
              @update:check-updates-enabled="saveCheckUpdates"
              :update-channel="updateChannel"
              @update:update-channel="saveUpdateChannel"
              :is-update-checking="isUpdateChecking"
              :is-updating="isUpdating"
              :update-check-result="updateCheckResult"
              @check-update-now="checkUpdateNow"
              @update-now="updateNow"
              :storage-settings="storageSettings"
              v-model:custom-path="storageSettings.customPath"
              :is-validating-path="isValidatingPath"
              :path-validation-result="pathValidationResult"
              :is-migrating="isMigrating"
              :storage-message="storageMessage"
              :storage-message-type="storageMessageType"
              :needs-reload="needsReload"
              @pick-storage-path="pickStoragePath"
              @apply-storage-path="applyStoragePath"
              @reset-storage-path="resetStoragePath"
              @open-in-explorer="openStoragePathInExplorer"
              @reload-window="reloadWindow"
              :is-exporting="isExporting"
              :is-importing="isImporting"
              :import-export-message="importExportMessage"
              :import-export-message-type="importExportMessageType"
              @export-settings="handleExportSettings"
              @import-settings="handleImportSettings"
              :app-info="appInfo"
            />

            <!-- 工作区行为（桌面版独有） -->
            <div class="form-group" data-search-anchor="workspace-behavior">
              <label class="group-label">
                <i class="codicon codicon-folder-opened"></i>
                {{ t('components.settings.settingsPanel.workspaceBehavior.title') }}
              </label>
              <p class="field-description">{{ t('components.settings.settingsPanel.workspaceBehavior.description') }}</p>

              <div class="workspace-behavior-settings">
                <CustomSelect
                  :model-value="workspaceBehavior"
                  :options="workspaceBehaviorOptions"
                  @update:model-value="saveWorkspaceBehavior"
                />
              </div>
            </div>
          </div>

          <!-- 用量统计（T12：Token 摘要拆至 UsageSummaryCard） -->
          <div v-if="settingsStore.activeTab === 'usage'" class="settings-section">
            <h4>{{ t('components.settings.settingsPanel.sections.usage.title') }}</h4>
            <p class="settings-description">{{ t('components.settings.settingsPanel.sections.usage.description') }}</p>

            <!-- 使用时间（活动统计，独立于 token 用量） -->
            <UsageTimeSection />

            <!-- Token 用量摘要 -->
            <UsageSummaryCard
              :stats="usageStats"
              v-model:range="usageRange"
              :loading="usageLoading"
              :load-error="usageLoadError"
              @refresh="loadUsageStats()"
              @retry="loadUsageStats()"
              @open-full="settingsStore.showUsage"
            />
          </div>
        </div>
      </CustomScrollbar>
    </div>
    
    <!-- 迁移确认对话框（T12：拆至 StorageMigrateDialog） -->
    <StorageMigrateDialog
      v-model:show="showMigrateDialog"
      :is-migrating="isMigrating"
      @confirm="executeMigration"
    />
  </div>
</template>

<style scoped>
.settings-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--vscode-sideBar-background);
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.settings-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.settings-close-btn {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.settings-close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.settings-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

/* 右侧内容 - 滚动条容器 */
.settings-main-scrollbar {
  flex: 1;
  min-height: 0;
  height: 100%;
  position: relative;
}

.settings-main {
  padding: 16px;
  min-height: min-content;
}

.settings-section h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 500;
}

.settings-description {
  margin: 0 0 16px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}


.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 12px;
  font-weight: 500;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.group-label .codicon {
  font-size: 14px;
  color: var(--vscode-foreground);
}

.field-description {
  margin: 4px 0 12px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 搜索结果跳转后的临时闪烁高亮 */
.search-flash {
  animation: settings-search-flash 1.6s ease;
}

@keyframes settings-search-flash {
  0% {
    background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  }
  60% {
    background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  }
  100% {
    background-color: transparent;
  }
}
</style>