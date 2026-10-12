import type { PromptContext } from './types';
import type { Content } from '../conversation';
import type { SettingsManager } from '../settings/SettingsManager';

export type DynamicRuntimeContext = {
    /** 由独立角色服务捕获的资料，仅在预设显式引用时输出。 */
    characterModules?: Record<string, string>;
    characterMacros?: Record<string, string>;
    characterInjections?: Content[];
    characterOutlets?: Record<string, string>;
    /** ConversationMetadata.custom['todoList'] */
    todoList?: unknown;

    /** ConversationMetadata.custom['inputPinnedFiles'] */
    pinnedFiles?: unknown;

    /** ConversationMetadata.custom['inputSkills'] */
    skills?: unknown;

    /** 会话绑定的工作区 URI（记忆隔离：工具执行按工作区路由记忆存储） */
    workspaceUri?: string;
};

export interface PromptContextBundle {
    /** 当前请求中位于真实聊天历史之前的非 system prompt context。 */
    beforeHistoryMessages: Content[];

    /** 当前请求中位于真实聊天历史之后的非 system prompt context。 */
    afterHistoryMessages: Content[];

    /** preserve 旧回合快照要插回原位的 before-history 动态子集。 */
    dynamicSnapshotBeforeHistoryMessages: Content[];

    /** preserve 旧回合快照要插回原位的 after-history 动态子集。 */
    dynamicSnapshotAfterHistoryMessages: Content[];

    /** 当前请求要插入的完整非 system prompt context（before + after），保留给旧调用兼容。 */
    messages: Content[];

    /** preserve 旧回合快照要插回原位的动态子集（dynamic before + dynamic after）。 */
    dynamicSnapshotMessages: Content[];

    /** messages 的纯文本拼接，用于 token 计数。 */
    text: string;

    /** dynamicSnapshotMessages 的纯文本拼接，用于 preserve 历史 token 计数。 */
    dynamicSnapshotText: string;

    /** entry 表示 chat_history 条目显式控制真实历史位置；legacy 表示沿用旧插入逻辑。 */
    historyPlacement: 'legacy' | 'entry';

    /** 各动态 section 的完整渲染值（key → wrapSection 后的文本），用于下一轮差分基准。 */
    sectionValues?: Record<string, string>;

    /** 动态模板/条目内容指纹；模板变化时强制全量发送一轮。 */
    dynamicTemplateFingerprint?: string;
}

/**
 * 跨回合差分基准：上一轮（最近一个带 turnDynamicContext 的用户回合）缓存的
 * 各动态 section 完整渲染值与模板指纹。
 *
 * 只有 preserve 策略会提供基准：它把历史快照回插到原位，模型能看到省略的 section，
 * 差分才是安全的；single 策略下省略会导致模型丢失基线信息，必须全量发送。
 */
export interface DynamicContextDiffBase {
    /** 上一轮各动态 section 的完整渲染值。缺失/空对象时视为无基准，全量发送。 */
    sectionValues?: Record<string, string>;

    /** 上一轮的动态模板/条目内容指纹；与当前指纹不同时强制全量发送。 */
    templateFingerprint?: string;
}

/**
 * 系统提示词管理器
 *
 * 功能：
 * 1. 生成静态系统提示词（可缓存）
 * 2. 生成动态上下文消息（每次请求时插入，不存储）
 * 3. 支持自定义前缀/后缀
 * 4. 缓存和更新机制
 *
 * 静态部分（放入系统提示词，可被 API provider 缓存）：
 * - 操作系统信息
 * - 时区
 * - 用户语言
 * - 工作区路径
 * - 工具定义（{{$TOOLS}}、{{$MCP_TOOLS}}）
 *
 * 动态部分（作为 user 消息插入，不存储到历史记录）：
 * - 当前时间
 * - 工作区文件树
 * - 打开的标签页
 * - 当前活动编辑器
 * - 诊断信息
 * - 固定文件内容
 */
export interface PromptAssemblyHost {
    settings: () => SettingsManager | null | undefined;
    workspacePaths: () => string[];
    sections: {
        wrapSection(title: string, content: string | null): string;
        cleanupEmptyLines(text: string): string;
        getUserLanguage(): string;
        generateStaticEnvironmentSection(): string;
        generateContextBadgeFormatSection(): string;
        generateMemorySection(): string;
        generateFileTreeSection(maxDepth: number, ignorePatterns: string[]): string;
        generateOpenTabsSection(maxTabs: number, ignorePatterns: string[]): string;
        generateActiveEditorSection(ignorePatterns: string[]): string;
        generateDiagnosticsSection(): string;
        generatePinnedFilesSection(runtimePinnedFiles?: unknown): string;
        getContext(): PromptContext;
    };
}
