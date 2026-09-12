import type { SearchIndexEntry } from './types'

/** 各宿主按可用分类建立搜索索引，关键词与实际入口在同一处维护。 */
export function settingsSearchIndex(isDesktopHost: boolean, supportsFileAssociations = isDesktopHost): SearchIndexEntry[] {
  return [
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
    key: 'channel-input-images', tab: 'channel',
    labelKey: 'components.channels.imageInput.label',
    keywords: ['图片数量', '图片上限', '历史图片', 'input image limit', 'maxInputImages', '画像数'],
    anchor: '[data-search-anchor="input-image-limit"]'
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
    key: 'channel-opencode-session', tab: 'channel',
    labelKey: 'components.settings.channelSettings.form.openCodeSession.title',
    keywords: ['OpenCode', 'OpenCode Go', 'opencode', 'x-opencode-session', '会话', 'session', 'セッション'],
    anchor: '[data-search-anchor="opencode-session"]'
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
    keywords: ['工具', 'tools', 'ツール', 'apply_diff', 'insert_code', 'delete_code', '文件编辑', '终端', 'terminal', 'ターミナル', '浏览器', 'browser', '搜索', 'search', '网页抓取', '图片', '图像', 'image', '生成', 'generate', '诊断', 'diagnostics']
  },
  {
    key: 'tools-max-iterations', tab: 'tools',
    labelKey: 'components.settings.toolsSettings.maxIterations.label',
    keywords: ['最大工具调用次数', 'max iterations', '工具调用', 'iteration', '反復', '无限制', '循环'],
    anchor: '[data-search-anchor="max-tool-iterations"]'
  },
  ...(isDesktopHost ? [{
    key: 'development-language-services', tab: 'development' as const, label: '代码补全与语言服务',
    labelKey: 'components.settings.settingsPanel.sections.tools.title',
    keywords: ['开发工具', '代码编辑器', 'development', 'code editor', '语言服务', '代码补全', 'LSP', 'language server', 'completion', '言語サーバー', 'TypeScript', 'JavaScript', 'Vue', 'Svelte', 'Python', 'HTML', 'CSS', 'JSON', 'YAML', 'Shell', 'Go', 'Rust', 'C++', 'Java', 'C#', 'PHP', 'Lua', 'PowerShell', 'SQL', 'Markdown'],
    anchor: '[data-search-anchor="language-services"]'
  }] : []),
  ...(supportsFileAssociations ? [{
    key: 'development-editor', tab: 'development' as const,
    labelKey: 'components.settings.tabs.development', label: '默认代码编辑器与文件关联',
    keywords: ['开发工具', '默认代码编辑器', '文件关联', '右键打开', '编辑器注册', 'development', 'default editor', 'file association'],
    anchor: '[data-search-anchor="desktop-editor"]'
  }] : []),
  {
    key: 'tools-list', tab: 'tools',
    labelKey: 'components.settings.settingsPanel.sections.tools.title',
    keywords: ['工具列表', 'tool list', 'ツール一覧', '全部启用', '全部禁用', '启用', '禁用', '依赖'],
    anchor: '[data-search-anchor="tool-list"]'
  },
  {
    key: 'autoExec', tab: 'autoExec',
    labelKey: 'components.settings.settingsPanel.sections.autoExec.title',
    keywords: ['自动执行', 'auto exec', '自動実行', '确认', 'confirmation', '確認', '批准', '执行模式', '手动', '工具确认', 'diff 审阅']
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
    key: 'prompt-entries', tab: 'prompt',
    labelKey: 'components.settings.settingsPanel.sections.prompt.title', label: '预设提示词条目',
    keywords: ['预设条目', 'entries', '条目', 'role', 'chat history', '排序', '组装方式', 'assembly', '传统模板', 'legacy',
      '动态上下文', 'dynamic context', '保留策略', 'preserve', 'single', '静态模板', 'static', '系统提示词', 'system prompt', '缓存', 'ダイナミック', 'スタティック', 'template', '模板'],
    anchor: '[data-search-anchor="prompt-entries"]'
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
    keywords: ['原始记忆', 'entries', '条目', '编辑', '删除', '记忆记录'],
    anchor: '[data-search-anchor="memory-raw-entries"]'
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
    key: 'general-storage', tab: 'general',
    labelKey: 'components.settings.storageSettings.title',
    keywords: ['存储路径', 'storage', '保存先', '数据目录', '自定义路径', '迁移'],
    anchor: '[data-search-anchor="storage"]'
  },
  ...(window.__GRAYCODE_HOST?.kind === 'desktop' ? [{
    key: 'general-backup', tab: 'general' as const, label: '程序数据备份',
    labelKey: 'components.settings.storageSettings.title',
    keywords: ['备份', 'backup', '恢复', 'restore', '加密', '密码', '对话', '附件'],
    anchor: '[data-search-anchor="backup"]'
  }] : []),
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
  },
  ...(isDesktopHost ? [
    { key: 'discord', tab: 'discord' as const, label: 'Discord Bot', labelKey: '',
      keywords: ['Discord', 'Bot', '机器人', '频道', '提及', '私聊', '群聊'] },
    { key: 'onebot', tab: 'onebot' as const, label: 'NapCat / OneBot', labelKey: '',
      keywords: ['QQ', 'NapCat', 'OneBot', '机器人', '群聊', '私聊', 'WebSocket'] },
    { key: 'accounts', tab: 'accounts' as const, label: '账号与授权', labelKey: '',
      keywords: ['账号', '授权', '权限', '绑定', '主人', '成员', '访客', '白名单', '黑名单', 'account', 'permission', 'owner', 'member'] },
    { key: 'workspaces', tab: 'workspaces' as const, label: '工作区', labelKey: '',
      keywords: ['工作区', '项目目录', '项目路径', 'workspace', 'project', 'directory'] },
    { key: 'remote', tab: 'remote' as const, label: '远程连接', labelKey: '',
      keywords: ['远程连接', '手机连接', '浏览器连接', 'Web', 'remote', 'mobile', '登录', '设备', '令牌'] },
  ] : []),
]
}
