/**
 * LimCode - 全局设置类型定义
 * 
 * 定义全局设置的类型和接口
 */

/**
 * 工具启用状态配置
 *
 * key: 工具名称
 * value: 是否启用
 */
export interface ToolsEnabledState {
    [toolName: string]: boolean;
}

/**
 * 工具自动执行配置
 *
 * 控制哪些工具可以自动执行（无需用户确认）
 * key: 工具名称
 * value: true = 自动执行，false = 需要确认
 *
 * 未列出的工具默认自动执行（不需要确认）
 */
export interface ToolAutoExecConfig {
    [toolName: string]: boolean;
}

/**
 * read_file 工具访问工作区外文件的策略
 *
 * - deny: 禁止读取工作区外文件
 * - ask: 每次读取前请求用户确认
 * - allow: 直接允许读取
 */
export type OutsideWorkspaceReadAccess = 'deny' | 'ask' | 'allow';

/**
 * write_file 工具访问工作区外文件的策略
 *
 * - deny: 禁止写入工作区外文件
 * - ask: 每次写入前请求用户确认
 */
export type OutsideWorkspaceWriteAccess = 'deny' | 'ask';

/**
 * Read File 工具配置
 */
export interface ReadFileToolConfig {
    /**
     * 工作区外文件读取策略
     */
    outsideWorkspaceAccess: OutsideWorkspaceReadAccess;
    [key: string]: unknown;
}

/**
 * Write File 工具配置
 */
export interface WriteFileToolConfig {
    /**
     * 工作区外文件写入策略
     */
    outsideWorkspaceAccess: OutsideWorkspaceWriteAccess;
    [key: string]: unknown;
}

/**
 * List Files 工具配置
 */
export interface ListFilesToolConfig {
    /**
     * 忽略列表（支持通配符）
     */
    ignorePatterns: string[];
    [key: string]: unknown;
}

/**
 * Find Files 工具配置
 */
export interface FindFilesToolConfig {
    /**
     * 排除模式（glob 格式）
     * 用于 vscode.workspace.findFiles 的 exclude 参数
     */
    excludePatterns: string[];
    [key: string]: unknown;
}

/**
 * Search In Files 工具配置
 */
export interface SearchInFilesToolConfig {
    /**
     * 排除模式（glob 格式）
     * 用于 vscode.workspace.findFiles 的 exclude 参数
     */
    excludePatterns: string[];
    
    /**
     * 是否启用基于文件头的文本/二进制检测
     *
     * 启用后：在读取/搜索前先读取少量文件头字节进行启发式判断，
     * 避免对 .db 等二进制文件进行字符串搜索导致结果爆炸。
     *
     * 默认 true
     */
    enableHeaderTextCheck?: boolean;
    
    /**
     * 读取文件头的采样字节数（用于文本/二进制检测）
     * 默认 4096
     */
    headerSampleBytes?: number;
    
    /**
     * 搜索模式下允许读取并搜索的最大文件大小（字节）
     * 超过该大小的文件将被跳过，避免内存/输出过大。
     * 默认 5MB
     */
    maxFileSizeBytes?: number;
    
    /**
     * 替换模式下允许处理（生成 diff）的最大文件大小（字节）
     * 默认 1MB（更保守，避免生成超大 diff）
     */
    maxReplaceFileSizeBytes?: number;
    
    /**
     * 上下文行数（匹配行之前的行数）
     * 默认 1
     */
    contextLinesBefore?: number;
    
    /**
     * 上下文行数（匹配行之后的行数）
     * 默认 1
     */
    contextLinesAfter?: number;
    
    /**
     * 上下文行/非匹配行的最大预览字符数（超出将截断）
     * 默认 300
     */
    maxLinePreviewChars?: number;
    
    /**
     * 匹配行的最大预览字符数（围绕 match 的窗口，超出将截断）
     * 默认 220
     */
    maxMatchPreviewChars?: number;
    
    /**
     * 搜索模式下返回结果的最大总字符预算（近似值）
     * 达到预算后提前停止并标记 truncated，避免返回体爆炸。
     * 默认 200000
     */
    maxTotalResultChars?: number;
    [key: string]: unknown;
}

/**
 * Apply Diff 工具配置
 */
export type ApplyDiffFormat = 'unified' | 'search_replace';


/**
 * History Search 工具配置
 */
export interface HistorySearchToolConfig {
    /** search 模式下最大返回匹配数 */
    maxSearchMatches: number;

    /** search 模式下每个匹配的上下文行数（前后各取） */
    searchContextLines: number;

    /** read 模式下单次最大读取行数 */
    maxReadLines: number;

    /** 返回结果的最大总字符数限制 */
    maxResultChars: number;

    /** 输出时单行的最大显示字符数（超出部分省略，可通过单行 read 获取完整内容） */
    lineDisplayLimit: number;

    /** 检索范围 */
    searchScope?: 'all' | 'summarized';

    [key: string]: unknown;
}

/**
 * Apply Diff 工具配置
 */
export interface ApplyDiffToolConfig {
    /**
     * apply_diff 参数格式：
     * - unified: unified diff patch（---/+++/@ @/+/-）
     * - search_replace: 旧版 search/replace/start_line diffs
     */
    format: ApplyDiffFormat;

    /**
     * 工作区外写入访问策略
     * - deny: 禁止 apply_diff 修改工作区外文件
     * - ask: 通过原本工具调用确认框询问用户
     */
    outsideWorkspaceAccess: OutsideWorkspaceWriteAccess;

    /**
     * 是否自动应用修改
     */
    autoSave: boolean;
    
    /**
     * 自动应用延迟（毫秒）
     * 在此延迟后自动保存修改，然后继续下一次 AI 调用
     */
    autoSaveDelay: number;
    
    /**
     * 自动应用时是否跳过 diff 视图
     * 
     * 当开启自动应用 (autoSave=true) 时：
     * - true: 直接将修改写入文件并保存，不打开 diff 视图
     * - false: 仍然打开 diff 视图显示差异（默认行为）
     */
    autoApplyWithoutDiffView: boolean;
    
    /**
     * 是否启用 diff 警戒值检测
     * 当开启自动应用时，如果一次性删除的行数超过文件总行数的百分比阈值，
     * 会在前端 diff 工具外侧显示一个提示文本
     */
    diffGuardEnabled: boolean;
    
    /**
     * diff 警戒值阈值（百分比，0-100）
     * 当删除行数占文件总行数的比例超过此值时触发警告
     * 默认: 50
     */
    diffGuardThreshold: number;
    
    [key: string]: unknown;
}

/**
 * Delete File 工具配置
 */
export interface DeleteFileToolConfig {
    /**
     * 是否自动执行（无需确认）
     * 默认 false，需要用户确认后才执行
     */
    autoExecute: boolean;
    
    [key: string]: unknown;
}

/**
 * Shell 配置
 */
export interface ShellConfig {
    /**
     * Shell 类型标识
     */
    type: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'gitbash' | 'wsl';
    
    /**
     * 是否启用
     */
    enabled: boolean;
    
    /**
     * Shell 可执行文件路径（可选，使用自定义路径）
     */
    path?: string;
    
    /**
     * 显示名称
     */
    displayName: string;
    
    /**
     * 是否可用（由后端检测，前端只读）
     */
    available?: boolean;
    
    /**
     * 不可用的原因
     */
    unavailableReason?: string;
}

/**
 * Execute Command 工具配置
 */
export interface ExecuteCommandToolConfig {
    /**
     * 默认使用的 Shell 类型
     */
    defaultShell: string;
    
    /**
     * 可用的 Shell 配置
     */
    shells: ShellConfig[];
    
    /**
     * 默认超时时间（毫秒）
     */
    defaultTimeout: number;
    
    /**
     * 是否自动执行（无需确认）
     * 默认 false，需要用户确认后才执行
     */
    autoExecute?: boolean;
    
    /**
     * 返回给 AI 的最大输出行数
     * 只返回终端输出的最后 N 行，避免输出过大
     * -1 表示无限制（返回全部输出）
     * 默认: 50
     */
    maxOutputLines: number;
    
    [key: string]: unknown;
}

/**
 * 消息类型存档点配置
 *
 * 类似工具备份配置，支持在消息前后创建存档点
 */
export interface MessageCheckpointConfig {
    /**
     * 需要在消息发送/接收前创建备份的消息类型
     * 可选值: 'user', 'model'
     */
    beforeMessages: string[];
    
    /**
     * 需要在消息发送/接收后创建备份的消息类型
     * 可选值: 'user', 'model'
     */
    afterMessages: string[];
    
    /**
     * 连续调用工具时，是否只在最外层创建模型消息存档点
     *
     * 当为 true 时：
     * - 模型消息前存档点：只在第一次迭代时创建
     * - 模型消息后存档点：只在最后一次迭代（无工具调用）时创建
     *
     * 当为 false 时：
     * - 每次迭代都会创建模型消息的前后存档点
     *
     * 默认为 true
     */
    modelOuterLayerOnly?: boolean;
    
    /**
     * 是否合并显示消息前后无变更的存档点
     *
     * 当为 true 时：
     * - 如果消息前后存档点的内容哈希相同，则合并显示为一个"内容未变化"的存档点
     *
     * 当为 false 时：
     * - 始终分别显示消息前和消息后的存档点
     *
     * 默认为 true
     */
    mergeUnchangedCheckpoints?: boolean;
}

/**
 * 存档点配置
 *
 * 控制哪些工具需要在执行前后创建备份
 */
export interface CheckpointConfig {
    /**
     * 是否全局启用存档点功能
     */
    enabled: boolean;
    
    /**
     * 需要在执行前创建备份的工具列表
     */
    beforeTools: string[];
    
    /**
     * 需要在执行后创建备份的工具列表
     */
    afterTools: string[];
    
    /**
     * 消息类型存档点配置
     *
     * 控制是否为用户消息和模型消息创建存档点
     */
    messageCheckpoint?: MessageCheckpointConfig;
    
    /**
     * 保留的最大存档点数量
     * 超过此数量时自动清理旧的存档点
     */
    maxCheckpoints: number;
    
    /**
     * 自定义忽略模式（追加到默认 .gitignore 规则）
     */
    customIgnorePatterns?: string[];
    
    [key: string]: unknown;
}

/**
 * 图像生成工具配置
 */
export interface GenerateImageToolConfig {
    /**
     * API URL
     * 默认使用 Gemini API
     */
    url: string;
    
    /**
     * API Key
     */
    apiKey: string;
    
    /**
     * 模型名称
     * 例如: gemini-2.5-flash-image
     */
    model: string;
    
    /**
     * 是否启用宽高比参数
     * - 启用 + 空值：工具包含可选的 aspect_ratio 字段，AI 可选择性传入
     * - 启用 + 设定值：工具不包含该字段，AI 只看到提示词说明，后端强制使用设定值
     * - 禁用：工具不包含该字段，后端不传
     * 默认: false
     */
    enableAspectRatio: boolean;
    
    /**
     * 默认宽高比（仅当 enableAspectRatio 为 true 时生效）
     * 空值表示 AI 可自由选择，设定值表示强制使用
     */
    defaultAspectRatio?: string;
    
    /**
     * 是否启用图片尺寸参数
     * - 启用 + 空值：工具包含可选的 image_size 字段，AI 可选择性传入
     * - 启用 + 设定值：工具不包含该字段，AI 只看到提示词说明，后端强制使用设定值
     * - 禁用：工具不包含该字段，后端不传
     * 默认: false
     */
    enableImageSize: boolean;
    
    /**
     * 默认图片尺寸（仅当 enableImageSize 为 true 时生效）
     * 空值表示 AI 可自由选择，设定值表示强制使用
     */
    defaultImageSize?: string;
    
    /**
     * 单次调用允许的最大任务数（批量模式）
     * 控制 AI 一次可以发起多少个不同的图像生成请求
     * 默认: 5
     */
    maxBatchTasks: number;
    
    /**
     * 单个任务的最大图片数
     * API 可能为一个提示词返回多张图片，此项控制保留的最大数量
     * 默认: 1
     */
    maxImagesPerTask: number;
    
    /**
     * 是否直接返回图片给 AI
     *
     * true: 将生成的图片 base64 直接返回给 AI 作为工具结果
     * false: 只返回文字描述，AI 需要调用 read_file 工具查看
     *
     * 默认: false（节省 token 消耗）
     */
    returnImageToAI: boolean;
    
    [key: string]: unknown;
}

/**
 * 抠图工具配置
 */
export interface RemoveBackgroundToolConfig {
    /**
     * 是否直接返回图片给 AI
     *
     * true: 将处理后的图片 base64 直接返回给 AI 作为工具结果
     * false: 只返回文字描述，AI 需要调用 read_file 工具查看
     *
     * 默认: false（节省 token 消耗）
     */
    returnImageToAI: boolean;
    
    [key: string]: unknown;
}

/**
 * 裁切图片工具配置
 */
export interface CropImageToolConfig {
    /**
     * 是否直接返回图片给 AI
     *
     * true: 将处理后的图片 base64 直接返回给 AI 作为工具结果
     * false: 只返回文字描述，AI 需要调用 read_file 工具查看
     *
     * 默认: false（节省 token 消耗）
     */
    returnImageToAI: boolean;
    
    [key: string]: unknown;
}

/**
 * 缩放图片工具配置
 */
export interface ResizeImageToolConfig {
    /**
     * 是否直接返回图片给 AI
     *
     * true: 将处理后的图片 base64 直接返回给 AI 作为工具结果
     * false: 只返回文字描述，AI 需要调用 read_file 工具查看
     *
     * 默认: false（节省 token 消耗）
     */
    returnImageToAI: boolean;
    
    [key: string]: unknown;
}

/**
 * 旋转图片工具配置
 */
export interface RotateImageToolConfig {
    /**
     * 是否直接返回图片给 AI
     *
     * true: 将处理后的图片 base64 直接返回给 AI 作为工具结果
     * false: 只返回文字描述，AI 需要调用 read_file 工具查看
     *
     * 默认: false（节省 token 消耗）
     */
    returnImageToAI: boolean;
    
    [key: string]: unknown;
}

/**
 * 固定文件项
 *
 * 单个被挂载的文件信息
 */
export interface PinnedFileItem {
    /**
     * 文件的唯一标识
     */
    id: string;
    
    /**
     * 文件路径（相对于工作区的路径）
     */
    path: string;
    
    /**
     * 所属工作区 URI
     * 用于多工作区场景下区分文件所属
     */
    workspaceUri: string;
    
    /**
     * 是否启用（可临时禁用某个文件）
     * 默认: true
     */
    enabled: boolean;
    
    /**
     * 添加时间戳
     */
    addedAt: number;
}

/**
 * 固定文件配置
 *
 * 允许挂载多个文本文件，每次调用 AI 时读取内容并添加到系统提示词
 */
export interface PinnedFilesConfig {
    /**
     * 固定文件列表
     */
    files: PinnedFileItem[];
    
    /**
     * 在系统提示词中的标题
     * 默认: 'PINNED FILES CONTENT'
     */
    sectionTitle: string;
    
    [key: string]: unknown;
}

/**
 * Skills 配置项
 */
export interface SkillConfigItem {
    /**
     * Skill ID
     */
    id: string;
    
    /**
     * Skill 名称
     */
    name: string;
    
    /**
     * Skill 描述
     */
    description: string;
    
    /**
     * 是否在当前对话中启用
     */
    enabled: boolean;
    
    /**
     * @deprecated 不再使用拼接注入模式。保留字段仅为向后兼容配置解析。
     * Skills 现在通过 read_skill 工具按需读取。
     */
    sendContent: boolean;
}

/**
 * Skills 配置
 */
export interface SkillsConfig {
    /**
     * Skills 配置列表
     */
    skills: SkillConfigItem[];
    
    [key: string]: unknown;
}

/**
 * 系统提示词模块定义
 *
 * 描述一个可用的提示词模块
 */
export interface PromptModule {
    /**
     * 模块 ID（唯一标识符）
     */
    id: string;
    
    /**
     * 模块名称
     */
    name: string;
    
    /**
     * 模块描述
     */
    description: string;
    
    /**
     * 使用示例
     */
    example?: string;
    
    /**
     * 是否需要特定配置才能生效
     */
    requiresConfig?: string;
}

/**
 * 动态上下文策略
 * - single: 仅存在一份动态上下文，保持当前请求插入策略
 * - preserve: 保留旧动态上下文原位不变，新回合上下文插到新回合位置
 */
export type DynamicContextStrategy = 'single' | 'preserve';

/**
 * 提示词组装方式。
 *
 * - legacy：使用传统 template / dynamicTemplate
 * - entries：使用 fast-tavern 风格 promptEntries，并由 chat_history 条目决定真实历史位置
 */
export type PromptAssemblyMode = 'legacy' | 'entries';

/**
 * 提示词预设条目类型。
 *
 * - prompt：普通提示词条目
 * - chat_history：真实聊天历史插入点
 */
export type PromptEntryType = 'prompt' | 'chat_history';

/** 预设模式中固定的聊天历史占位条目 ID。 */
export const CHAT_HISTORY_PROMPT_ENTRY_ID = 'chat-history';

/**
 * 提示词预设条目的角色。
 *
 * 普通 prompt 条目使用该角色；chat_history 条目的 role/content 会被忽略。
 * UI 使用 assistant 命名；后端发送给模型前会映射为内部 Content.role = model。
 */
export type PromptEntryRole = 'system' | 'user' | 'assistant';

/**
 * 提示词预设条目。
 *
 * 条目按 order 排序；enabled=false 时不参与组装。
 * - chat_history：真实对话历史插入点，不能发送成普通消息
 * - system：合并进系统提示词
 * - user：作为临时 user 上下文消息插入请求，不写入真实历史
 * - assistant：作为临时 model 上下文消息插入请求，不写入真实历史
 */
export interface PromptEntry {
    /** 条目 ID（同一模式内唯一） */
    id: string;

    /** 条目名称（用于显示） */
    name: string;

    /** 条目类型。旧配置未设置时视为 prompt。 */
    type?: PromptEntryType;

    /** 是否启用 */
    enabled: boolean;

    /** 条目角色 */
    role: PromptEntryRole;

    /** 提示词内容，支持 {{$MODULE}} 占位符 */
    content: string;

    /** 排序值，小的在前 */
    order: number;
}

/**
 * 提示词模式定义
 * 
 * 每个模式包含独立的系统提示词和动态上下文配置
 */
export interface PromptMode {
    /**
     * 模式 ID（唯一标识）
     */
    id: string;
    
    /**
     * 模式名称（用于显示）
     */
    name: string;
    
    /**
     * 模式图标（codicon 名称，可选）
     */
    icon?: string;
    
    /**
     * 系统提示词模板
     */
    template: string;

    /**
     * 提示词组装方式。未设置时为 legacy，避免旧配置被 promptEntries 隐式接管。
     */
    promptAssemblyMode?: PromptAssemblyMode;
    
    /**
     * 是否启用动态上下文模板
     */
    dynamicTemplateEnabled: boolean;
    
    /**
     * 动态上下文模板
     */
    dynamicTemplate: string;

    /**
     * 动态上下文策略。未设置时继承全局 system_prompt.dynamicContextStrategy。
     */
    dynamicContextStrategy?: DynamicContextStrategy;

    /**
     * fast-tavern 风格的有序预设条目。
     *
     * 仅 promptAssemblyMode === 'entries' 时参与组装。
     */
    promptEntries?: PromptEntry[];
    
    /**
     * 工具策略（allowlist）
     * 未设置时继承 code 工具集
     */
    toolPolicy?: string[];
}

/**
 * 已解析的提示词模式快照
 *
 * 运行中的请求应使用这个快照，而不是读取全局当前模式。
 */
export type ResolvedPromptModeSnapshot = PromptMode;

/**
 * 系统提示词配置
 *
 * 允许用户自定义系统提示词模板
 * 支持多模式配置，不同模式可以有不同的提示词
 * 注意：此功能始终启用，不可关闭
 */
export interface SystemPromptConfig {
    /**
     * 当前激活的模式 ID
     * 默认为 'default'
     */
    currentModeId: string;
    
    /**
     * 所有模式配置
     * key 为模式 ID
     */
    modes: Record<string, PromptMode>;
    
    /**
     * 自定义提示词模板（默认模式的模板，向后兼容）
     *
     * 支持使用以下模块占位符（使用 {{$xxx}} 格式）：
     * - {{$ENVIRONMENT}} - 环境信息（工作区、操作系统、时区、语言）
     * - {{$CONTEXT_BADGE_FORMAT}} - lim-context 徽章结构说明（标题/正文/二进制标记）
     * - {{$WORKSPACE_FILES}} - 工作区文件树
     * - {{$OPEN_TABS}} - 打开的标签页
     * - {{$ACTIVE_EDITOR}} - 当前活动编辑器
     * - {{$PINNED_FILES}} - 固定文件内容
     * - {{$TOOLS}} - 工具定义（XML 或 Function Call）
     * - {{$MCP_TOOLS}} - MCP 工具定义
     *
     * 模块之间可以添加任意文字
     */
    template: string;
    
    /**
     * 自定义前缀内容
     * 在模板中使用 {{CUSTOM_PREFIX}} 引用
     */
    customPrefix: string;
    
    /**
     * 自定义后缀内容
     * 在模板中使用 {{CUSTOM_SUFFIX}} 引用
     */
    customSuffix: string;
    
    /**
     * 是否启用动态上下文模板（默认模式，向后兼容）
     *
     * 当启用时，会将动态上下文（文件树、诊断、固定文件等）作为消息发送给 AI
     * 当禁用时，不发送动态上下文消息
     *
     * 默认: true
     */
    dynamicTemplateEnabled: boolean;
    
    /**
     * 动态上下文模板（默认模式，向后兼容）
     *
     * 支持以下模块占位符（使用 {{$xxx}} 格式）：
     * - {{$WORKSPACE_FILES}} - 工作区文件树
     * - {{$OPEN_TABS}} - 打开的标签页
     * - {{$ACTIVE_EDITOR}} - 当前活动编辑器
     * - {{$DIAGNOSTICS}} - 诊断信息
     * - {{$PINNED_FILES}} - 固定文件内容
     *
     * 每次请求时动态生成，不存储到历史记录中
     */
    dynamicTemplate: string;

    /**
     * 动态上下文保留策略
     *
     * single: 仅在当前请求中插入一份动态上下文，保持现状
     * preserve: 保留每个回合缓存的动态上下文原位，不改写旧上下文
     */
    dynamicContextStrategy: DynamicContextStrategy;
    
    [key: string]: unknown;
}

/**
 * VSCode 诊断严重程度
 *
 * 与 vscode.DiagnosticSeverity 对应：
 * - Error = 0
 * - Warning = 1
 * - Information = 2
 * - Hint = 3
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

/**
 * 诊断信息配置
 *
 * 控制是否将 VSCode 诊断信息（错误/警告/建议等）发送给 AI
 */
export interface DiagnosticsConfig {
    /**
     * 是否启用诊断信息功能
     * 默认: false
     */
    enabled: boolean;
    
    /**
     * 要包含的诊断严重程度级别
     * 默认: ['error', 'warning']
     */
    includeSeverities: DiagnosticSeverity[];
    
    /**
     * 是否只包含当前工作区的诊断
     * 默认: true
     */
    workspaceOnly: boolean;
    
    /**
     * 是否只包含打开文件的诊断
     * 默认: false
     */
    openFilesOnly: boolean;
    
    /**
     * 每个文件最大显示的诊断数量
     * -1 表示无限制
     * 默认: 10
     */
    maxDiagnosticsPerFile: number;
    
    /**
     * 最大显示的文件数量
     * -1 表示无限制
     * 默认: 20
     */
    maxFiles: number;
    
    [key: string]: unknown;
}

/**
 * 上下文感知配置
 *
 * 控制发送给 AI 的上下文信息
 */
export interface ContextAwarenessConfig {
    /**
     * 是否发送工作区文件树给 AI
     * 默认: true
     */
    includeWorkspaceFiles: boolean;
    
    /**
     * 文件层级最大深度
     * -1 表示无限制
     * 默认: 10
     */
    maxFileDepth: number;
    
    /**
     * 是否发送打开的标签页列表给 AI
     * 默认: true
     */
    includeOpenTabs: boolean;
    
    /**
     * 发送的标签页最大数量
     * -1 表示无限制
     * 默认: 20
     */
    maxOpenTabs: number;
    
    /**
     * 是否发送当前活动编辑器的路径给 AI
     * 默认: true
     */
    includeActiveEditor: boolean;
    
    /**
     * 诊断信息配置
     * 控制是否发送 VSCode 诊断信息给 AI
     */
    diagnostics?: DiagnosticsConfig;
    
    /**
     * 自定义忽略模式（支持通配符）
     * 匹配的文件/文件夹不会出现在文件树和标签页列表中
     * 例如: ["*\/node_modules", "*.log", ".git"]
     * 默认: []
     */
    ignorePatterns: string[];
    
    [key: string]: unknown;
}

/**
 * Token 计数 API 渠道配置
 *
 * 支持 Gemini、OpenAI、Anthropic 三种格式
 */
export interface TokenCountChannelConfig {
    /**
     * 是否启用此渠道的 Token 计数 API
     */
    enabled: boolean;
    
    /**
     * API 基础 URL
     *
     * Gemini 示例: https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}
     * OpenAI 示例: https://api.openai.com/v1/chat/completions (使用 tiktoken 或 API)
     * Anthropic 示例: https://api.anthropic.com/v1/messages/count_tokens
     */
    baseUrl: string;
    
    /**
     * API Key
     */
    apiKey: string;
    
    /**
     * 模型名称
     *
     * 用于替换 URL 中的 {model} 占位符
     * 例如: gemini-2.5-pro
     */
    model: string;
}

/**
 * Token 计数配置
 *
 * 允许用户配置各渠道的 Token 计数 API，用于精确计算上下文 token 数量
 * 如果未配置或 API 调用失败，将回退到估算方法
 */
export interface TokenCountConfig {
    /**
     * Gemini 渠道配置
     */
    gemini?: TokenCountChannelConfig;
    
    /**
     * OpenAI 渠道配置
     */
    openai?: TokenCountChannelConfig;
    
    /**
     * Anthropic 渠道配置
     */
    anthropic?: TokenCountChannelConfig;

    /**
     * OpenAI Responses 渠道配置
     */
    'openai-responses'?: TokenCountChannelConfig;
    
    [key: string]: unknown;
}

/**
 * 默认 Gemini Token 计数配置
 */
export const DEFAULT_GEMINI_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}',
    apiKey: '',
    model: 'gemini-2.5-pro'
};

/**
 * 默认 OpenAI Token 计数配置
 */
export const DEFAULT_OPENAI_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-5'
};

/**
 * 默认 OpenAI Responses Token 计数配置
 */
export const DEFAULT_OPENAI_RESPONSES_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1/responses/input_tokens',
    apiKey: '',
    model: 'gpt-5'
};

/**
 * 默认 Anthropic Token 计数配置
 */
export const DEFAULT_ANTHROPIC_TOKEN_COUNT_CONFIG: TokenCountChannelConfig = {
    enabled: false,
    baseUrl: 'https://api.anthropic.com/v1/messages/count_tokens',
    apiKey: '',
    model: 'claude-sonnet-4-5'
};

/**
 * 默认 Token 计数配置
 */
export const DEFAULT_TOKEN_COUNT_CONFIG: TokenCountConfig = {
    gemini: DEFAULT_GEMINI_TOKEN_COUNT_CONFIG,
    openai: DEFAULT_OPENAI_TOKEN_COUNT_CONFIG,
    anthropic: DEFAULT_ANTHROPIC_TOKEN_COUNT_CONFIG,
    'openai-responses': DEFAULT_OPENAI_RESPONSES_TOKEN_COUNT_CONFIG
};

/**
 * 上下文总结配置
 */
export interface SummarizeConfig {
    /**
     * 手动总结提示词
     */
    summarizePrompt: string;

    /**
     * 自动总结提示词
     */
    autoSummarizePrompt: string;
    
    /**
     * 保留最近 N 轮不总结
     */
    keepRecentRounds: number;
    
    /**
     * 是否使用专门的总结模型
     */
    useSeparateModel: boolean;
    
    /**
     * 总结用的渠道 ID
     */
    summarizeChannelId: string;
    
    /**
     * 总结用的模型 ID
     */
    summarizeModelId: string;
    
    [key: string]: unknown;
}

/**
 * 子代理工具配置
 */
export interface SubAgentToolsConfig {
    /**
     * 工具模式
     */
    mode: 'all' | 'builtin' | 'mcp' | 'whitelist' | 'blacklist';
    
    /**
     * 工具列表（白名单/黑名单模式下使用）
     */
    list?: string[];
}

/**
 * Provider 自动重试耗尽后的 SubAgent 处理策略。
 */
export type SubAgentFailureModeAfterRetries = 'fail_parent_tool' | 'wait_for_monitor_action';

/**
 * 子代理配置项
 */
export interface SubAgentConfigItem {
    /**
     * 子代理类型 ID（唯一标识符）
     */
    type: string;
    
    /**
     * 子代理名称（显示名称）
     */
    name: string;
    
    /**
     * 子代理描述
     */
    description: string;
    
    /**
     * 系统提示词
     */
    systemPrompt: string;
    
    /**
     * 渠道配置
     */
    channel: {
        channelId: string;
        modelId?: string;
    };
    
    /**
     * 工具配置
     */
    tools: SubAgentToolsConfig;
    
    /**
     * 最大迭代次数（-1 表示无限制）
     * 默认: 20
     */
    maxIterations?: number;
    
    /**
     * 最大运行时间（秒，-1 表示无限制）
     * 默认: 300 (5分钟)
     */
    maxRuntime?: number;

    /**
     * Provider 自动重试耗尽后的处理策略，可覆盖全局默认值。
     */
    failureModeAfterRetries?: SubAgentFailureModeAfterRetries;
    
    /**
     * 是否启用
     */
    enabled: boolean;
}

/**
 * 子代理配置
 */
export interface SubAgentsConfig extends Record<string, unknown> {
    /**
     * 子代理列表
     */
    agents: SubAgentConfigItem[];
    
    /**
     * AI 一次性可调用的最大子代理数量
     * 默认: 3
     */
    maxConcurrentAgents?: number;

    /**
     * 全局默认的 Provider 自动重试耗尽处理策略。
     */
    failureModeAfterRetries?: SubAgentFailureModeAfterRetries;
}

/**
 * 默认子代理配置
 */
export const DEFAULT_SUBAGENTS_CONFIG: SubAgentsConfig = {
    agents: [],
    maxConcurrentAgents: 3,
    failureModeAfterRetries: 'fail_parent_tool'
};

/**
 * 工具特定配置
 *
 * key: 工具名称
 * value: 该工具的配置对象
 */
export interface ToolsConfig {
    read_file?: ReadFileToolConfig;
    write_file?: WriteFileToolConfig;
    list_files?: ListFilesToolConfig;
    find_files?: FindFilesToolConfig;
    search_in_files?: SearchInFilesToolConfig;
    apply_diff?: ApplyDiffToolConfig;
    delete_file?: DeleteFileToolConfig;
    execute_command?: ExecuteCommandToolConfig;
    checkpoint?: CheckpointConfig;
    summarize?: SummarizeConfig;
    generate_image?: GenerateImageToolConfig;
    remove_background?: RemoveBackgroundToolConfig;
    crop_image?: CropImageToolConfig;
    resize_image?: ResizeImageToolConfig;
    rotate_image?: RotateImageToolConfig;
    context_awareness?: ContextAwarenessConfig;
    pinned_files?: PinnedFilesConfig;
    skills?: SkillsConfig;
    system_prompt?: SystemPromptConfig;
    token_count?: TokenCountConfig;
    subagents?: SubAgentsConfig;
    history_search?: HistorySearchToolConfig;
    [toolName: string]: Record<string, unknown> | undefined;
}

/**
 * 代理配置
 */
export interface ProxySettings {
    /**
     * 是否启用代理
     */
    enabled: boolean;
    
    /**
     * 代理地址
     *
     * 格式: http://host:port 或 https://host:port
     * 例如: http://127.0.0.1:7890
     */
    url?: string;
}

/**
 * 数据存储路径配置
 *
 * 允许用户自定义大文件的存储位置，避免占用 C 盘空间
 * 核心设置仍保存在 globalStorageUri，只有大文件使用自定义路径
 */
export interface StoragePathConfig {
    /**
     * 自定义数据存储根目录
     *
     * 如果为空或未设置，使用默认的 globalStorageUri
     * 例如: "D:\\LimCodeData" 或 "/home/user/limcode-data"
     */
    customDataPath?: string;
    
    /**
     * 最后一次成功迁移的时间戳
     */
    lastMigrationAt?: number;
    
    /**
     * 迁移状态
     */
    migrationStatus?: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';
    
    /**
     * 迁移失败的错误信息
     */
    migrationError?: string;
}

/**
 * 存储目录统计信息
 */
export interface StorageStats {
    /**
     * 目录路径
     */
    path: string;
    
    /**
     * 总大小（字节）
     */
    totalSize: number;
    
    /**
     * 文件数量
     */
    fileCount: number;
    
    /**
     * 子目录统计
     */
    subDirs: {
        conversations: { size: number; count: number };
        checkpoints: { size: number; count: number };
        mcp: { size: number; count: number };
        dependencies: { size: number; count: number };
        diffs: { size: number; count: number };
    };
}

/**
 * UI 声音提醒设置
 */
export interface WindowsAgentStopNotificationContentSettings {
    /** 通知标题模板 */
    titleTemplate?: string;

    /** 通知正文模板 */
    bodyTemplates?: {
        /** 错误停止 */
        error?: string;
        /** 等待用户动作 */
        awaitingUserAction?: string;
        /** 等待继续 */
        continueRequired?: string;
    };
}

export interface WindowsAgentStopNotificationSettings {
    /** 总开关（默认关闭） */
    enabled?: boolean;

    /** 仅在当前窗口未聚焦时发送通知 */
    onlyWhenWindowNotFocused?: boolean;

    /** 停止场景开关 */
    cases?: {
        /** 错误停止 */
        error?: boolean;
        /** 等待用户操作 */
        awaitingUserAction?: boolean;
        /** 等待继续 */
        continueRequired?: boolean;
    };

    /** 通知内容模板 */
    content?: WindowsAgentStopNotificationContentSettings;
}

export interface UISoundSettings {
    /** 总开关（默认关闭，避免打扰） */
    enabled?: boolean;

    /** 音量（0-100） */
    volume?: number;

    /** 最小播放间隔（毫秒），用于限流 */
    cooldownMs?: number;

    /** 各类提示音开关 */
    cues?: {
        warning?: boolean;
        error?: boolean;
        taskComplete?: boolean;
        /** 任务失败提示音（可与 error 分开控制） */
        taskError?: boolean;
    };

    /**
     * 自定义音效（可选）：为各类提示音导入本地音频文件。
     *
     * 注意：为支持“清除已导入音效”，这里允许显式写入 null。
     */
    assets?: {
        warning?: UISoundAsset | null;
        error?: UISoundAsset | null;
        taskComplete?: UISoundAsset | null;
        taskError?: UISoundAsset | null;
    };

    /** 提示音风格 */
    theme?: 'beep' | 'soft';

    /**
     * Windows 专用 Agent 停止系统通知设置
     */
    windowsAgentStopNotification?: WindowsAgentStopNotificationSettings;
}

/**
 * UI 声音提醒 - 自定义音效资源
 */
export interface UISoundAsset {
    /** 文件名（展示用） */
    name: string;
    /** mime 类型（展示用，可为空字符串） */
    mime: string;
    /** base64 内容（不含 data: 前缀） */
    dataBase64: string;
}

/**
 * 全局设置
 *
 * 包含所有全局级别的配置项
 */
export interface GlobalSettings {
    /**
     * 数据存储路径配置
     */
    storagePath?: StoragePathConfig;
    
    /**
     * 当前激活的渠道配置 ID
     *
     * 用于快速切换渠道
     */
    activeChannelId?: string;
    
    /**
     * 单回合最大工具调用次数
     *
     * 防止 AI 无限循环调用工具
     * -1 表示无限制
     * 默认: 50
     */
    maxToolIterations?: number;
    
    /**
     * 工具启用状态
     *
     * 控制哪些工具对所有渠道可用
     * 未列出的工具默认启用
     */
    toolsEnabled: ToolsEnabledState;
    
    /**
     * 工具自动执行配置
     *
     * 控制哪些工具可以自动执行（无需用户确认）
     * 未列出的工具默认自动执行
     */
    toolAutoExec?: ToolAutoExecConfig;
    
    /**
     * 工具特定配置
     *
     * 每个工具可以有自己的配置项
     */
    toolsConfig?: ToolsConfig;
    
    /**
     * 全局默认工具模式
     *
     * 当渠道配置未指定时使用
     */
    defaultToolMode?: 'function_call' | 'xml' | 'json';
    
    /**
     * 代理配置
     *
     * 用于 API 请求通过代理服务器
     */
    proxy?: ProxySettings;
    
    /**
     * UI 偏好设置
     */
    ui?: {
        /** 主题模式 */
        theme?: 'light' | 'dark' | 'auto';
        
        /** 语言设置 */
        language?: string;

        /**
         * 外观设置
         */
        appearance?: {
            /**
             * 流式输出指示器文本（例如：Loading / 思考中…）
             *
             * - 为空或未设置时：前端使用默认值
             */
            loadingText?: string;

            /**
             * 是否启用选中内容入口
             *
             * - true: 显示“添加选中内容到输入框”的悬浮链接和 Code Action
             * - false: 不显示上述入口
             */
            selectionContextEnabled?: boolean;

            /**
             * 兼容旧版：是否启用选中文本悬浮入口
             * @deprecated 请改用 selectionContextEnabled
             */
            selectionContextHoverEnabled?: boolean;

            /**
             * 兼容旧版：是否启用选中文本 Code Action 入口
             * @deprecated 请改用 selectionContextEnabled
             */
            selectionContextCodeActionEnabled?: boolean;
        };

        /**
         * 声音提醒
         */
        sound?: UISoundSettings;

        /**
         * 用量页模型单价（美元 / 每百万 token）
         *
         * key 为 modelVersion；input = 输入单价，output = 输出单价（思考 token 按输出计）。
         * 两项均为 0 时视为未配置。
         */
        usagePricing?: Record<string, { input?: number; output?: number }>;
    };
    
    /**
     * 用户上次查看的公告版本
     * 
     * 用于判断是否需要显示新版本的更新公告
     */
    lastReadAnnouncementVersion?: string;
    
    /**
     * 最后更新时间戳
     */
    lastUpdated: number;
}

/**
 * 设置变更事件
 */
export interface SettingsChangeEvent {
    /** 变更类型 */
    type: 'channel' | 'tools' | 'toolMode' | 'proxy' | 'storagePath' | 'ui' | 'full';
    
    /** 变更的字段路径（如 'toolsEnabled.read_file'） */
    path?: string;
    
    /** 旧值 */
    oldValue?: any;
    
    /** 新值 */
    newValue?: any;
    
    /** 完整的新设置 */
    settings: GlobalSettings;
}

/**
 * 设置变更监听器
 */
export type SettingsChangeListener = (event: SettingsChangeEvent) => void | Promise<void>;

/**
 * 常用忽略模式列表
 * 供 list_files、find_files、search_in_files 共用
 */
export const COMMON_IGNORE_PATTERNS = [
    // 版本控制
    '.git',
    '.svn',
    '.hg',
    // 依赖目录
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    'vendor',
    // IDE 配置
    '.idea',
    // 系统文件
    '.DS_Store',
    'Thumbs.db',
    // 构建输出
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    // 缓存
    '.cache',
    '.turbo',
    '.parcel-cache',
    // 测试覆盖率
    'coverage',
    '.nyc_output',
    // 锁文件
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    // 编译产物
    '*.pyc',
    '*.pyo',
    '*.class',
    '*.o',
    '*.obj',
    // 日志文件
    '*.log',
    // 临时文件
    '*.tmp',
    '*.temp',
    '*.swp',
    '*.swo'
];

/**
 * 默认 read_file 配置
 */
export const DEFAULT_READ_FILE_CONFIG: ReadFileToolConfig = {
    outsideWorkspaceAccess: 'deny'
};

/**
 * 默认 write_file 配置
 */
export const DEFAULT_WRITE_FILE_CONFIG: WriteFileToolConfig = {
    outsideWorkspaceAccess: 'deny'
};

/**
 * 默认 list_files 配置
 */
export const DEFAULT_LIST_FILES_CONFIG: ListFilesToolConfig = {
    ignorePatterns: [...COMMON_IGNORE_PATTERNS]
};

/**
 * 默认 find_files 配置
 */
export const DEFAULT_FIND_FILES_CONFIG: FindFilesToolConfig = {
    excludePatterns: [
        // glob 格式的排除模式
        '**/node_modules/**',
        '**/.git/**',
        '**/.svn/**',
        '**/.hg/**',
        '**/__pycache__/**',
        '**/.venv/**',
        '**/venv/**',
        '**/vendor/**',
        '**/.idea/**',
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/.cache/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/.nyc_output/**'
    ]
};

/**
 * 默认 search_in_files 配置
 */
export const DEFAULT_SEARCH_IN_FILES_CONFIG: SearchInFilesToolConfig = {
    excludePatterns: [
        // glob 格式的排除模式
        '**/node_modules/**',
        '**/.git/**',
        '**/.svn/**',
        '**/.hg/**',
        '**/__pycache__/**',
        '**/.venv/**',
        '**/venv/**',
        '**/vendor/**',
        '**/.idea/**',
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/.cache/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/.nyc_output/**'
    ],
    enableHeaderTextCheck: true,
    headerSampleBytes: 4096,
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxReplaceFileSizeBytes: 1 * 1024 * 1024,
    contextLinesBefore: 1,
    contextLinesAfter: 1,
    maxLinePreviewChars: 300,
    maxMatchPreviewChars: 220,
    maxTotalResultChars: 200000
};

/**
 * 默认 apply_diff 配置
 */
export const DEFAULT_APPLY_DIFF_CONFIG: ApplyDiffToolConfig = {
    // 默认使用新格式（unified diff patch）
    format: 'unified',
    outsideWorkspaceAccess: 'deny',
    autoSave: false,
    autoSaveDelay: 3000,
    autoApplyWithoutDiffView: false,
    diffGuardEnabled: true,
    diffGuardThreshold: 50
};

/**
 * 默认 delete_file 配置
 */
export const DEFAULT_DELETE_FILE_CONFIG: DeleteFileToolConfig = {
    autoExecute: false
};

/**
 * 默认 history_search 配置
 */
export const DEFAULT_HISTORY_SEARCH_CONFIG: HistorySearchToolConfig = {
    maxSearchMatches: 30,
    searchContextLines: 3,
    maxReadLines: 300,
    maxResultChars: 30000,
    lineDisplayLimit: 500,
    searchScope: 'all'
};

/**
 * 获取默认的 execute_command 配置
 * 根据操作系统自动设置默认 shell
 * 所有 shell 默认启用，用户自己配置路径
 */
export function getDefaultExecuteCommandConfig(): ExecuteCommandToolConfig {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    
    const shells: ShellConfig[] = isWindows ? [
        // Windows shells - 所有启用，不内置路径
        { type: 'powershell', enabled: true, displayName: 'PowerShell' },
        { type: 'cmd', enabled: true, displayName: 'CMD' },
        { type: 'bash', enabled: true, displayName: 'Bash (Git)' },
        { type: 'sh', enabled: true, displayName: 'sh (Git)' },
        { type: 'gitbash', enabled: true, displayName: 'Git Bash' },
        { type: 'wsl', enabled: true, displayName: 'WSL' }
    ] : isMac ? [
        // macOS shells - 所有启用
        { type: 'zsh', enabled: true, displayName: 'Zsh' },
        { type: 'bash', enabled: true, displayName: 'Bash' },
        { type: 'sh', enabled: true, displayName: 'sh' }
    ] : [
        // Linux shells - 所有启用
        { type: 'bash', enabled: true, displayName: 'Bash' },
        { type: 'zsh', enabled: true, displayName: 'Zsh' },
        { type: 'sh', enabled: true, displayName: 'sh' }
    ];
    
    return {
        defaultShell: isWindows ? 'powershell' : (isMac ? 'zsh' : 'bash'),
        shells,
        defaultTimeout: 60000,
        autoExecute: false,
        maxOutputLines: 50
    };
}

/**
 * 默认 execute_command 配置（运行时生成）
 */
export const DEFAULT_EXECUTE_COMMAND_CONFIG: ExecuteCommandToolConfig = getDefaultExecuteCommandConfig();

/**
 * 默认消息存档点配置
 *
 * 默认配置：
 * - 用户消息：只在发送前创建存档点
 * - 助手消息：不创建存档点
 */
export const DEFAULT_MESSAGE_CHECKPOINT_CONFIG: MessageCheckpointConfig = {
    beforeMessages: ['user'],  // 用户消息前创建存档点
    afterMessages: [],
    modelOuterLayerOnly: true,  // 默认只在最外层创建
    mergeUnchangedCheckpoints: true  // 默认合并无变更的存档点
};

/**
 * 默认存档点配置
 *
 * 默认对文件修改类工具启用备份
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
    enabled: true,
    beforeTools: [
        'apply_diff',
        'write_file',
        'delete_file',
        'create_directory',
        'execute_command',
        'generate_image'
    ],
    afterTools: [
        'apply_diff',
        'write_file',
        'delete_file',
        'create_directory',
        'execute_command',
        'generate_image'
    ],
    messageCheckpoint: DEFAULT_MESSAGE_CHECKPOINT_CONFIG,
    maxCheckpoints: -1,  // -1 表示无上限
    customIgnorePatterns: []
};

/**
 * 默认工具自动执行配置
 *
 * 默认情况下，以下危险工具需要确认后才能执行：
 * - delete_file: 删除文件
 * - execute_command: 执行终端命令
 */
export const DEFAULT_TOOL_AUTO_EXEC_CONFIG: ToolAutoExecConfig = {
    delete_file: false,      // 需要确认
  execute_command: false   // 需要确认
};

/**
 * 默认总结配置
 */
export const DEFAULT_SUMMARIZE_CONFIG: SummarizeConfig = {
    summarizePrompt: 'Please summarize the above conversation, keeping key information and context points while removing redundant content.',
    autoSummarizePrompt: `Please summarize the above conversation history and output the following sections, so that the AI can continue completing the unfinished tasks.

## User Requirements
What the user wants to accomplish (overall goal).

## Completed Work
List what has been done in chronological order, including which files were changed and what decisions were made.
File paths, variable names, and configuration values must be preserved exactly, do not generalize.

## Current Progress
What step has been reached, what is currently being done.

## TODO Items
What still needs to be done, listed by priority.

## Important Conventions
Constraints, preferences, and technical requirements raised by the user (e.g., "do not use third-party libraries", "use TypeScript", etc.).

Output content directly without any prefix.`,
    keepRecentRounds: 2,
    useSeparateModel: false,
    summarizeChannelId: '',
    summarizeModelId: ''
};

/**
 * 默认图像生成工具配置
 */
export const DEFAULT_GENERATE_IMAGE_CONFIG: GenerateImageToolConfig = {
    url: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    model: 'gemini-3-pro-image-preview',
    enableAspectRatio: false,
    defaultAspectRatio: undefined,
    enableImageSize: false,
    defaultImageSize: undefined,
    maxBatchTasks: 5,
    maxImagesPerTask: 1,
    returnImageToAI: false
};

/**
 * 默认抠图工具配置
 */
export const DEFAULT_REMOVE_BACKGROUND_CONFIG: RemoveBackgroundToolConfig = {
    returnImageToAI: false
};

/**
 * 默认裁切图片工具配置
 */
export const DEFAULT_CROP_IMAGE_CONFIG: CropImageToolConfig = {
    returnImageToAI: false
};

/**
 * 默认缩放图片工具配置
 */
export const DEFAULT_RESIZE_IMAGE_CONFIG: ResizeImageToolConfig = {
    returnImageToAI: false
};

/**
 * 默认旋转图片工具配置
 */
export const DEFAULT_ROTATE_IMAGE_CONFIG: RotateImageToolConfig = {
    returnImageToAI: false
};

/**
 * 默认固定文件配置
 */
export const DEFAULT_PINNED_FILES_CONFIG: PinnedFilesConfig = {
    files: [],
    sectionTitle: 'PINNED FILES CONTENT'
};

/**
 * 默认 Skills 配置
 */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
    skills: []
};

/**
 * 可用的提示词模块列表
 *
 * 注意：name、description、requiresConfig 等字段将在前端通过 i18n 翻译键显示
 * 这里使用英文作为后备值
 */
export const AVAILABLE_PROMPT_MODULES: PromptModule[] = [
    {
        id: 'ENVIRONMENT',
        name: 'Environment Info',
        description: 'Contains workspace path, operating system, current time, timezone, and user language',
        example: `====

ENVIRONMENT

Current Workspace: /path/to/project
Operating System: Windows 11
Current Time: 2024-01-01T12:00:00.000Z
Timezone: Asia/Shanghai
User Language: zh-CN
Please respond using the user's language by default.`
    },
    {
        id: 'WORKSPACE_FILES',
        name: 'Workspace Files',
        description: 'Lists files and directory structure in the workspace, affected by context awareness settings',
        example: `====

WORKSPACE FILES

The following is a list of files in the current workspace:

src/
  main.ts
  utils/
    helper.ts`,
        requiresConfig: 'Context Awareness > Send Workspace Files'
    },
    {
        id: 'OPEN_TABS',
        name: 'Open Tabs',
        description: 'Lists currently open file tabs in the editor',
        example: `====

OPEN TABS

Currently open files in editor:
  - src/main.ts
  - src/utils/helper.ts`,
        requiresConfig: 'Context Awareness > Send Open Tabs'
    },
    {
        id: 'ACTIVE_EDITOR',
        name: 'Active Editor',
        description: 'Shows the currently active file path',
        example: `====

ACTIVE EDITOR

Currently active file: src/main.ts`,
        requiresConfig: 'Context Awareness > Send Active Editor'
    },
    {
        id: 'DIAGNOSTICS',
        name: 'Diagnostics',
        description: 'Shows VSCode diagnostics (errors, warnings, hints) from the workspace',
        example: `====

DIAGNOSTICS

The following diagnostics were found in the workspace:

src/main.ts:
  Line 10: [Error] Cannot find name 'foo'.
  Line 25: [Warning] 'bar' is declared but never used.

src/utils/helper.ts:
  Line 5: [Error] Property 'x' does not exist on type 'Y'.`,
        requiresConfig: 'Context Awareness > Diagnostics'
    },
    {
        id: 'PINNED_FILES',
        name: 'Pinned Files Content',
        description: 'Shows full content of user-pinned files',
        example: `====

PINNED FILES CONTENT

The following are pinned files...

--- README.md ---
# Project Title
...`,
        requiresConfig: 'Add files via the pinned files button next to input'
    },
    {
        id: 'CONTEXT_BADGE_FORMAT',
        name: 'Context Badge Format',
        description: 'Explains how <lim-context ...>...</lim-context> is structured, including title/body and binary badges',
        example: `====

CONTEXT BADGE FORMAT

<lim-context type="file" path="新建文件夹 (10).zip" binary="true" title="新建文件夹 (10).zip">

</lim-context>

- title attribute is the chip title shown to users
- body text between tags is the actual content body
- when binary="true", body is intentionally empty and should not be parsed as text`
    },
    {
        id: 'TOOLS',
        name: 'Tools Definition',
        description: 'Generates tool definitions in XML or Function Call format based on channel config',
        example: `====

TOOLS

You have access to these tools:

## read_file
Description: Read file content
...`
    },
    {
        id: 'MCP_TOOLS',
        name: 'MCP Tools',
        description: 'Additional tool definitions from MCP servers',
        example: `====

MCP TOOLS

Additional tools from MCP servers:
...`,
        requiresConfig: 'Configure and connect servers in MCP Settings'
    }
];

/**
 * 默认诊断信息配置
 */
export const DEFAULT_DIAGNOSTICS_CONFIG: DiagnosticsConfig = {
    enabled: true,
    includeSeverities: ['error', 'warning'],
    workspaceOnly: true,
    openFilesOnly: false,
    maxDiagnosticsPerFile: 10,
    maxFiles: 20
};

/**
 * 内置提示词模板与内置模式定义已拆分到 promptModes.ts。
 * 此处重导出以保持旧的 import 路径兼容（如 from '../settings/types'）。
 */
export * from './promptModes';
import { DEFAULT_SYSTEM_PROMPT_CONFIG } from './promptModes';


/**
 * 默认单回合最大工具调用次数
 */
export const DEFAULT_MAX_TOOL_ITERATIONS = 50;

/**
 * 默认上下文感知配置
 *
 * ignorePatterns 使用与 COMMON_IGNORE_PATTERNS 相同的默认规则
 */
export const DEFAULT_CONTEXT_AWARENESS_CONFIG: ContextAwarenessConfig = {
    includeWorkspaceFiles: true,
    maxFileDepth: 2,
    includeOpenTabs: true,
    maxOpenTabs: 20,
    includeActiveEditor: true,
    diagnostics: DEFAULT_DIAGNOSTICS_CONFIG,
    ignorePatterns: [...COMMON_IGNORE_PATTERNS]
};

/**
 * 默认全局设置
 */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    toolsEnabled: {
        // 默认所有工具启用
    },
    toolAutoExec: DEFAULT_TOOL_AUTO_EXEC_CONFIG,
    toolsConfig: {
        read_file: DEFAULT_READ_FILE_CONFIG,
        write_file: DEFAULT_WRITE_FILE_CONFIG,
        list_files: DEFAULT_LIST_FILES_CONFIG,
        find_files: DEFAULT_FIND_FILES_CONFIG,
        search_in_files: DEFAULT_SEARCH_IN_FILES_CONFIG,
        apply_diff: DEFAULT_APPLY_DIFF_CONFIG,
        delete_file: DEFAULT_DELETE_FILE_CONFIG,
        execute_command: getDefaultExecuteCommandConfig(),
        checkpoint: DEFAULT_CHECKPOINT_CONFIG,
        summarize: DEFAULT_SUMMARIZE_CONFIG,
        generate_image: DEFAULT_GENERATE_IMAGE_CONFIG,
        remove_background: DEFAULT_REMOVE_BACKGROUND_CONFIG,
        crop_image: DEFAULT_CROP_IMAGE_CONFIG,
        resize_image: DEFAULT_RESIZE_IMAGE_CONFIG,
        rotate_image: DEFAULT_ROTATE_IMAGE_CONFIG,
        context_awareness: DEFAULT_CONTEXT_AWARENESS_CONFIG,
        pinned_files: DEFAULT_PINNED_FILES_CONFIG,
        system_prompt: DEFAULT_SYSTEM_PROMPT_CONFIG,
        token_count: DEFAULT_TOKEN_COUNT_CONFIG
    },
    defaultToolMode: 'function_call',
    proxy: {
        enabled: false,
        url: undefined
    },
    ui: {
        theme: 'auto',
        language: 'zh-CN',
        appearance: {
            // 为空表示前端使用默认值（通常来自 i18n）
            loadingText: '',
            selectionContextEnabled: true
        },
        sound: {
            enabled: false,
            volume: 60,
            cooldownMs: 800,
            cues: {
                warning: true,
                error: true,
                taskComplete: true,
                taskError: true
            },
            theme: 'beep',
            windowsAgentStopNotification: {
                enabled: false,
                onlyWhenWindowNotFocused: true,
                cases: {
                    error: true,
                    awaitingUserAction: true,
                    continueRequired: true
                },
                content: {
                    titleTemplate: '{windowTitle} · LimCode',
                    bodyTemplates: {
                        error: 'LimCode 已停止，请返回处理。',
                        awaitingUserAction: 'LimCode 正在等待：{actionLabel}。',
                        continueRequired: 'LimCode 已暂停，可继续处理。'
                    }
                }
            }
        }
    },
    lastUpdated: Date.now()
};