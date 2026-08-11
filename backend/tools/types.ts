
/**
 * GrayCode - 工具系统类型定义
 * 
 * 定义工具的标准接口和类型
 */

import type { MultimodalCapability } from './shared/multimodal';

/**
 * 通用工具进度事件。
 *
 * 用于 SubAgent Monitor、长任务工具和后续可观测工具进度，不把进度协议散落到具体工具实现里。
 */
export interface ToolProgressEvent {
    /** 事件所属运行实例；SubAgent 使用 runId，普通工具可不填 */
    runId?: string;
    /** 事件类型，覆盖运行级、内容级和工具级进度 */
    type: 'run_created' | 'run_queued' | 'run_started' | 'run_updated' | 'run_completed' | 'run_failed' | 'run_cancelled'
        | 'run_paused' | 'run_resumed' | 'run_awaiting_monitor_action' | 'run_interrupted' | 'run_detached'
        | 'retrying' | 'retrySuccess' | 'retryFailed'
        | 'llm_delta' | 'content_snapshot'
        | 'tool_started' | 'tool_progress' | 'tool_completed' | 'tool_failed';
    /** 工具调用 ID；工具级事件使用 */
    toolId?: string;
    /** 工具名；工具级事件使用 */
    toolName?: string;
    /** 事件时间戳；发送方不填时由桥接层补齐 */
    timestamp?: number;
    /** 复用现有结构的事件主体，例如工具结果、流式内容片段或业务进度 */
    payload?: unknown;
}

/**
 * 通用工具进度发射函数。
 */
export type ToolProgressEmitter = (event: ToolProgressEvent) => void | Promise<void>;

/**
 * 工具声明（Gemini Function Calling 格式）
 */
export interface ToolDeclaration {
    /** 工具名称 */
    name: string;
    
    /** 工具描述 */
    description: string;
    
    /** 工具分类（如 file, search, terminal） */
    category?: string;
    
    /** 参数定义（JSON Schema） */
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
    
    /**
     * 工具依赖列表
     *
     * 指定此工具运行所需的外部依赖包名称
     * 如果依赖未安装，工具将不会对 AI 可用
     *
     * @example ['sharp'] - 表示需要 sharp 库
     */
    dependencies?: string[];

    /**
     * 工具别名（兼容重命名后的旧对话历史）
     *
     */
    aliases?: string[];

    /**
     * 参数改名别名（alias → canonical）
     *
     * 仅适用于与规范参数语义完全等价的纯改名（如 read_file 的 maxLine → endLine）。
     * normalizeToolArgs 在规范参数缺失且别名出现时自动改名并附警告。
     * 需要计算/组合的语义转换请使用 compatParams 由 handler 自行处理。
     */
    paramAliases?: Record<string, string>;

    /**
     * 兼容透传参数
     *
     * 不写进 parameters 向模型宣传（节省 token、避免鼓励旧写法），
     * 但不会被未知参数剥离，由 handler 自行解释语义
     * （如 read_file 的 line/maxLines/limit 行范围兼容参数）。
     */
    compatParams?: string[];

    /**
     * 是否启用 strict 模式（API 端强制 schema 校验）
     *
     * 开启后，API 会使用 grammar-constrained sampling 保证模型输出
     * 严格符合参数 schema，消除类型错误和缺失字段。
     *
     * 各渠道行为：
     * - Anthropic: 工具定义中加 strict: true，请求头加 beta header
     * - OpenAI Chat Completions: 工具定义中加 strict: true
     * - OpenAI Responses: 默认即 strict，不需要额外设置
     * - Gemini: 不支持，此字段无效
     */
    strict?: boolean;

    /**
     * 是否为纯只读工具（不修改文件系统/会话状态/外部环境）。
     *
     * 标记为 true 的工具在同一批调用中相邻出现时会被并行执行，
     * 降低多个读取/搜索调用的累计延迟。
     *
     * 注意：只有“任何参数组合下都只读”的工具才能标记（如 read_file）；
     * 像 search_in_files 这种有 replace 模式的工具不能标记。
     */
    readOnly?: boolean;
}

/**
 * 工具执行参数
 */
export interface ToolArgs {
    [key: string]: any;
}

/**
 * 多模态能力（从 shared/multimodal 重新导出，避免重复定义）
 */
export { MultimodalCapability } from './shared/multimodal';

/**
 * 裁切图片工具配置
 */
export interface CropImageToolOptions {
    /**
     * 是否使用归一化坐标
     *
     * - true: 使用 0-1000 归一化坐标系统（适用于 Gemini 等模型）
     * - false: 模型直接输出像素坐标（适用于能自行计算坐标的模型）
     *
     * 默认值：true
     */
    useNormalizedCoordinates?: boolean;
}

/**
 * 工具配置
 *
 * 各工具的渠道级配置
 */
export interface ToolOptions {
    /** 裁切图片工具配置 */
    cropImage?: CropImageToolOptions;
}

/**
 * 对话存储接口
 *
 * 用于存储和获取对话的自定义元数据
 */
export interface ConversationStore {
    /**
     * 获取自定义元数据
     *
     * @param conversationId 对话 ID
     * @param key 元数据键
     * @returns 元数据值
     */
    getCustomMetadata(conversationId: string, key: string): Promise<unknown>;
    
    /**
     * 设置自定义元数据
     *
     * @param conversationId 对话 ID
     * @param key 元数据键
     * @param value 元数据值
     */
    setCustomMetadata(conversationId: string, key: string, value: unknown): Promise<void>;
}

/**
 * 工具执行上下文
 *
 * 包含工具执行时可能需要的额外信息
 */
export interface ToolContext {
    /** 工具配置（来自 SettingsManager） */
    config?: Record<string, unknown>;
    
    /**
     * 是否启用多模态工具
     *
     * 当启用时，read_file 等工具可以读取图片和 PDF 等多模态文件
     * 禁用时，仅支持读取纯文本文件
     */
    multimodalEnabled?: boolean;
    
    /**
     * 多模态能力
     *
     * 根据渠道类型和工具模式计算得出的多模态支持能力
     * 工具可以根据这个能力决定能否读取特定类型的文件
     */
    capability?: MultimodalCapability;
    
    /**
     * 取消信号
     *
     * 当用户取消对话或重载时，此信号会被触发
     * 工具应该在长时间操作中检查此信号并及时终止
     */
    abortSignal?: AbortSignal;
    
    /**
     * 工具调用 ID
     *
     * 由 ChatHandler 生成的唯一标识符，用于追踪和取消特定的工具调用
     * 格式为: `tool_{timestamp}_{random}`
     */
    toolId?: string;

    /**
     * 本次工具调用是否已经通过聊天里的原本工具确认框批准。
     * 工作区外 ask 策略会使用这个标记区分“已批准执行”和“绕过确认直接调用”。
     */
    approvedByToolConfirmation?: boolean;
    
    /**
     * 工具配置
     *
     * 各工具的渠道级配置项，由渠道配置传递
     */
    toolOptions?: ToolOptions;
    
    /**
     * 对话 ID
     *
     * 当前对话的唯一标识符
     */
    conversationId?: string;

    /**
     * 当前请求使用的渠道配置 ID
     *
     * 修改原因：General Worker 虚拟子代理需要继承主会话当前渠道，而渠道 id 只在工具执行层可见。
     * 修改方式：executeBuiltinTool 把当前请求的渠道配置 id 注入 toolContext。
     * 修改目的：用户零配置即可让主模型按需派发与自己同渠道同权限的 worker。
     */
    channelConfigId?: string;

    /**
     * 当前请求使用的模型覆盖 ID
     *
     * 修改原因：General Worker 虚拟子代理需要继承主会话当前模型（modelOverride），
     * 只传渠道 id 会落到渠道默认模型；子代理「与当前模型同步」同样需要它。
     * 由 tool-execution/result.ts 在构建工具执行上下文时注入。
     */
    channelModelId?: string;
    
    /**
     * 对话存储
     *
     * 用于存储和获取对话的自定义元数据
     */
    conversationStore?: {
        getCustomMetadata: (conversationId: string, key: string) => Promise<unknown>;
        setCustomMetadata: (conversationId: string, key: string, value: unknown) => Promise<void>;
    };

    /**
     * 当前对话绑定的工作区 URI
     *
     * 记忆隔离等按工作区路由的功能使用：memory_* 工具据此把记忆写入/读取到
     * 对应工作区的记忆存储，无工作区时回退全局记忆。
     */
    activeWorkspaceUri?: string;
    
    /** 其他上下文信息 */
    [key: string]: unknown;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
    /** 是否成功 */
    success: boolean;
    
    /** 返回数据（成功时） */
    data?: any;
    
    /** 错误信息（失败时） */
    error?: string;
    
    /** 多模态数据（可选） */
    multimodal?: MultimodalData[];
    
    /** 是否被用户取消（可选） */
    cancelled?: boolean;
    
    /**
     * 工具执行成功后，要求暂停 AI 的工具迭代循环，等待用户手动操作后再继续。
     * 与 autoExec 不同：autoExec 控制"是否自动执行工具"（执行前的门闸），
     * 而此字段控制"工具执行后是否继续 AI 循环"（执行后的门闸）。
     */
    requiresUserConfirmation?: boolean;
}

/**
 * 多模态数据
 */
export interface MultimodalData {
    /** MIME 类型 */
    mimeType: string;
    
    /** Base64 编码的数据 */
    data: string;
    
    /** 文件名（可选） */
    name?: string;
}

/**
 * 工具处理器函数
 */
export type ToolHandler = (args: ToolArgs, context?: ToolContext) => Promise<ToolResult>;

/**
 * 工具定义（完整）
 */
export interface Tool {
    /** 工具声明 */
    declaration: ToolDeclaration;
    
    /** 工具处理器 */
    handler: ToolHandler;
}

/**
 * 工具注册函数
 */
export type ToolRegistration = () => Tool;