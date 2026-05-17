import type { Content } from '../../../conversation/types';
import type { RequestPromptContext } from '../../../channel/types';
import type { DynamicContextStrategy } from '../../../settings/types';
import { promptContextMessagesToText } from '../../../prompt/promptContextCache';
import type {
    AgentLoopState,
    AgentTraceEventStatus,
    ChatStreamAgentStateData,
    PromptContextPreview,
    PromptContextPreviewSection
} from '../types';

const MAX_PREVIEW_CHARS_PER_SECTION = 12_000;

export interface CreateAgentStateDataArgs {
    conversationId: string;
    state: AgentLoopState;
    status: AgentTraceEventStatus;
    label: string;
    detail?: string;
    iteration?: number;
    startedAt?: number;
    tool?: {
        id?: string;
        name: string;
    };
    promptContextPreview?: PromptContextPreview;
}

export interface BuildPromptContextPreviewArgs {
    iteration: number;
    strategy: DynamicContextStrategy;
    promptContext: RequestPromptContext;
    dynamicSystemPrompt: string;
    history: Content[];
    trimStartIndex?: number;
    needsAutoSummarize?: boolean;
}

function createEventId(state: AgentLoopState): string {
    return `${state}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}

function truncatePreviewText(text: string): { text: string; truncated: boolean } {
    if (text.length <= MAX_PREVIEW_CHARS_PER_SECTION) {
        return { text, truncated: false };
    }

    return {
        text: `${text.slice(0, MAX_PREVIEW_CHARS_PER_SECTION)}\n... (truncated, total=${text.length} chars)`,
        truncated: true
    };
}

function contentToText(content: Content): string {
    return content.parts
        ?.map(part => {
            if (part.text) return part.text;
            if (part.functionCall) {
                return `[functionCall:${part.functionCall.name}] ${JSON.stringify(part.functionCall.args || {})}`;
            }
            if (part.functionResponse) {
                return `[functionResponse:${part.functionResponse.name}] ${JSON.stringify(part.functionResponse.response || {})}`;
            }
            if (part.inlineData) {
                return `[inlineData:${part.inlineData.mimeType}]`;
            }
            if (part.fileData) {
                return `[fileData:${part.fileData.mimeType}] ${part.fileData.fileUri}`;
            }
            return '';
        })
        .filter(Boolean)
        .join('') || '';
}

function historyToPreviewText(history: Content[]): string {
    return history
        .map((message, index) => {
            const text = contentToText(message).trim();
            return `#${index + 1} [${message.role}]\n${text || '(empty)'}`;
        })
        .join('\n\n');
}

function makeSection(
    id: string,
    title: string,
    text: string,
    options: { role?: 'system' | 'user' | 'model'; messageCount?: number } = {}
): PromptContextPreviewSection {
    const normalizedText = text || '';
    const preview = truncatePreviewText(normalizedText);
    return {
        id,
        title,
        role: options.role,
        text: preview.text,
        charCount: normalizedText.length,
        estimatedTokens: estimateTokens(normalizedText),
        messageCount: options.messageCount,
        truncated: preview.truncated || undefined
    };
}

export function createAgentStateData(args: CreateAgentStateDataArgs): ChatStreamAgentStateData {
    const createdAt = Date.now();
    return {
        conversationId: args.conversationId,
        agentState: true,
        event: {
            id: createEventId(args.state),
            state: args.state,
            status: args.status,
            label: args.label,
            detail: args.detail,
            iteration: args.iteration,
            createdAt,
            durationMs: args.startedAt ? Math.max(0, createdAt - args.startedAt) : undefined,
            tool: args.tool,
            promptContextPreview: args.promptContextPreview
        }
    };
}

export function buildPromptContextPreview(args: BuildPromptContextPreviewArgs): PromptContextPreview {
    const beforeHistoryMessages = args.promptContext.beforeHistoryMessages || [];
    const afterHistoryMessages = args.promptContext.afterHistoryMessages || [];
    const historyPlacement = args.promptContext.historyPlacement || 'legacy';

    const sections: PromptContextPreviewSection[] = [
        makeSection('system', 'System prompt', args.dynamicSystemPrompt || '', { role: 'system', messageCount: args.dynamicSystemPrompt ? 1 : 0 }),
        makeSection('before_history', 'Prompt context before chat history', promptContextMessagesToText(beforeHistoryMessages), {
            role: beforeHistoryMessages[0]?.role === 'model' ? 'model' : 'user',
            messageCount: beforeHistoryMessages.length
        }),
        makeSection('chat_history', 'Trimmed chat history sent to model', historyToPreviewText(args.history), {
            messageCount: args.history.length
        }),
        makeSection('after_history', 'Prompt context after chat history', promptContextMessagesToText(afterHistoryMessages), {
            role: afterHistoryMessages[0]?.role === 'model' ? 'model' : 'user',
            messageCount: afterHistoryMessages.length
        })
    ];

    return {
        generatedAt: Date.now(),
        iteration: args.iteration,
        strategy: args.strategy,
        historyPlacement,
        trim: {
            trimStartIndex: args.trimStartIndex,
            historyLength: args.history.length,
            needsAutoSummarize: args.needsAutoSummarize || undefined
        },
        sections
    };
}
