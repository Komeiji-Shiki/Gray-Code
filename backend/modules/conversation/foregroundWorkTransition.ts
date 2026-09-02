import type { ContentPart, ForegroundWorkTransition } from '../../../shared/protocol';

/** 防止异常客户端把计数放大成没有意义的超长数字。 */
const MAX_TRANSITION_COUNT = 999;

function normalizeCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(MAX_TRANSITION_COUNT, Math.floor(value));
}

/**
 * 只接受固定数字字段，拒绝把 Webview 传来的自由文本带入模型提示。
 * 两项都为 0 时返回 undefined，避免给普通新回合添加无意义提醒。
 */
export function normalizeForegroundWorkTransition(value: unknown): ForegroundWorkTransition | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const candidate = value as Partial<Record<keyof ForegroundWorkTransition, unknown>>;
    const normalized: ForegroundWorkTransition = {
        terminalCommands: normalizeCount(candidate.terminalCommands),
        subAgentTasks: normalizeCount(candidate.subAgentTasks),
    };

    return normalized.terminalCommands + normalized.subAgentTasks > 0
        ? normalized
        : undefined;
}

function describeCount(count: number, singular: string, plural: string): string | undefined {
    if (count <= 0) return undefined;
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * 由持久化计数确定性生成模型可见提醒。文本不接受前端输入，避免形成提示注入入口。
 * 同一条历史消息在工具续跑、重试和后续回合中会生成完全相同的前缀，适配提示缓存。
 */
export function buildForegroundWorkTransitionPrompt(value: unknown): string | undefined {
    const transition = normalizeForegroundWorkTransition(value);
    if (!transition) return undefined;

    const descriptions = [
        describeCount(transition.terminalCommands, 'terminal command', 'terminal commands'),
        describeCount(transition.subAgentTasks, 'sub-agent task', 'sub-agent tasks'),
    ].filter((item): item is string => !!item);

    return [
        '[GrayCode runtime notice]',
        `The user's latest message arrived while foreground work was still running (${descriptions.join(' and ')}). GrayCode moved that work to the background; the new message did not cancel or fail it.`,
        'Do not restart, duplicate, or poll that work solely because the conversation advanced. Follow any explicit instruction in the latest user message about that work. GrayCode will automatically report each completion or failure in a later "[Background task completed]" user message.',
        'Continue with the user\'s latest request using the information currently available.',
    ].join('\n');
}

/** 构造要放在用户原文之前的固定提示 part；无有效转后台记录时不生成。 */
export function createForegroundWorkTransitionPart(value: unknown): ContentPart | undefined {
    const text = buildForegroundWorkTransitionPrompt(value);
    return text ? { text } : undefined;
}
