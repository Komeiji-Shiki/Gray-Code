/**
 * GrayCode - 工具相关设置类型与默认值
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

import type { CheckpointConfig } from './checkpointTypes';
import type { SummarizeConfig } from './summarizeTypes';
import type { ContextAwarenessConfig } from './contextTypes';
import type { PinnedFilesConfig } from './pinnedFilesTypes';
import type { SkillsConfig } from './skillsTypes';
import type { SystemPromptConfig } from './promptTypes';
import type { TokenCountConfig } from './tokenCountTypes';
import type { SubAgentsConfig } from './subAgentsTypes';

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
     * vscode.workspace.findFiles 单次枚举的最大文件数。
     * 工具会额外请求 1 个条目判断是否真的截断，避免恰好等于上限时误报。
     * 默认 1000。
     */
    maxFindFiles?: number;

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
 * Memory 工具配置（永久记忆系统）
 */
export interface MemoryToolConfig {
    /**
     * 是否启用长期记忆系统。
     *
     * 关闭后不注入记忆提示词，也不向模型提供记忆工具；已有记忆数据保持不变。
     */
    enabled?: boolean;

    /**
     * 自定义记忆系统提示词。
     *
     * 如果设置，将替换内置的 {{$MEMORY}} 模板变量内容。
     * 可以在这里自定义 AI 如何使用记忆系统的行为规则。
     * 留空则使用内置默认值。
     */
    systemPrompt?: string;

    /**
     * wake 输出的行数预算（默认 96，≈8k tokens）。
     * 更大的值 = 更多细节，但也消耗更多 token。
     */
    wakeLines?: number;

    /**
     * 单条记忆最大字节数（默认 280）。
     * 超过此长度的记忆文本将被截断。最大值 280。
     */
    entryChars?: number;

    [key: string]: unknown;
}

/**
 * 默认 Memory 工具配置
 */
export const DEFAULT_MEMORY_TOOL_CONFIG: MemoryToolConfig = {
    enabled: true,
    // systemPrompt 为空时，PromptManager 使用内置默认值
    wakeLines: 96,
    entryChars: 280,
};


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
 *
 * 注：是否需要确认由统一的自动执行配置（toolAutoExec）控制，
 * 此处不再重复定义 autoExecute（旧字段从未被执行链路消费，已移除）。
 */
export interface DeleteFileToolConfig {
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
     * 返回给 AI 的最大输出行数
     * 只返回终端输出的最后 N 行，避免输出过大
     * -1 表示无限制（返回全部输出）
     * 默认: 50
     */
    maxOutputLines: number;
    
    [key: string]: unknown;
}

/**
 * 沙箱工具支持的语言
 */
export type SandboxLanguage = 'python' | 'javascript' | 'bash' | 'powershell' | 'sh';

/**
 * Sandbox 工具配置
 *
 * 沙箱在隔离的临时目录中运行代码片段，提供文件系统隔离、超时与输出上限。
 */
export interface SandboxToolConfig {
    /**
     * 是否启用沙箱工具。
     *
     * 关闭后不向模型提供 sandbox 工具。默认关闭（opt-in）。
     */
    enabled?: boolean;

    /**
     * 允许运行的语言白名单。
     * 仅这些语言可在沙箱中执行。
     */
    allowedLanguages: SandboxLanguage[];

    /**
     * 默认超时时间（毫秒），硬上限。
     * 用户在工具调用中传入的 timeout 不能超过此值。
     * 默认: 30000
     */
    defaultTimeout: number;

    /**
     * 返回给 AI 的最大输出行数。
     * 超出时仅保留最后 N 行并标记 truncated。
     * -1 表示无限制。
     * 默认: 200
     */
    maxOutputLines: number;

    /**
     * 运行结束后是否清理临时目录。
     * 默认: true
     */
    cleanupTempDir: boolean;

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
    sandbox?: SandboxToolConfig;
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
    memory?: MemoryToolConfig;
    [toolName: string]: Record<string, unknown> | undefined;
}

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
    maxFindFiles: 1000,
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
export const DEFAULT_DELETE_FILE_CONFIG: DeleteFileToolConfig = {};

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
        maxOutputLines: 50
    };
}

/**
 * 沙箱支持的语言列表（唯一权威来源）
 *
 * 定义在 settings 层避免 tools -> settings 循环依赖；
 * sandbox 工具模块从这里引用，设置服务校验也用它。
 */
export const SANDBOX_LANGUAGES: SandboxLanguage[] = ['python', 'javascript', 'bash', 'powershell', 'sh'];

/**
 * 获取默认的 sandbox 配置
 */
export function getDefaultSandboxConfig(): SandboxToolConfig {
    return {
        enabled: false,
        allowedLanguages: [...SANDBOX_LANGUAGES],
        defaultTimeout: 30000,
        maxOutputLines: 200,
        cleanupTempDir: true
    };
}

/**
 * 默认 sandbox 配置（运行时生成）
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxToolConfig = getDefaultSandboxConfig();

/**
 * 默认工具自动执行配置
 *
 * 默认情况下，以下危险工具需要确认后才能执行：
 * - delete_file: 删除文件
 * - execute_command: 执行终端命令
 * - sandbox: 沙箱运行代码
 */
export const DEFAULT_TOOL_AUTO_EXEC_CONFIG: ToolAutoExecConfig = {
    delete_file: false,      // 需要确认
  execute_command: false,  // 需要确认
  sandbox: false           // 需要确认
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
 * 默认单回合最大工具调用次数
 *
 * 与 generalTypes.ts 中 maxToolIterations 的注释保持一致：默认值 200，-1 表示无限制
 */
export const DEFAULT_MAX_TOOL_ITERATIONS = 200;
