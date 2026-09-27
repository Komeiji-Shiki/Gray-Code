import type { ContentPart } from '../../conversation/types';

type MessageMetadata = NonNullable<ContentPart['openaiResponsesMessage']>;

/** Responses message 的正文仍存放在 part.text，元数据只负责原生 item/content 边界。 */
function metadata(item: any, outputIndex?: number): MessageMetadata {
    return {
        ...(typeof item?.id === 'string' ? { id: item.id } : {}),
        ...(['in_progress', 'completed', 'incomplete'].includes(item?.status) ? { status: item.status } : {}),
        ...(item?.phase === 'commentary' || item?.phase === 'final_answer' || item?.phase === null ? { phase: item.phase } : {}),
        ...(typeof outputIndex === 'number' ? { outputIndex } : {})
    };
}

export function responsesMessageParts(item: any, outputIndex?: number): ContentPart[] {
    const native = metadata(item, outputIndex);
    const hasIdentity = Object.keys(native).length > 0;
    const parts = (Array.isArray(item?.content) ? item.content : []).flatMap((entry: any, contentIndex: number) => {
        const text = entry?.type === 'refusal' ? entry.refusal : entry?.type === 'output_text' ? entry.text : undefined;
        if (typeof text !== 'string') return [];
        return [{ text, ...(hasIdentity || entry.type === 'refusal' ? {
            openaiResponsesMessage: {
                ...native, contentIndex, contentType: entry.type,
                ...(Array.isArray(entry.annotations) ? { annotations: entry.annotations } : {}),
                ...(Array.isArray(entry.logprobs) ? { logprobs: entry.logprobs } : {})
            }
        } : {}) }];
    });
    return parts.length || !hasIdentity ? parts : [{ text: '', openaiResponsesMessage: { ...native, contentIndex: undefined, contentType: undefined } }];
}

export function responsesMessageStart(item: any, outputIndex?: number): ContentPart {
    return { text: '', openaiResponsesMessage: { ...metadata(item, outputIndex), contentIndex: 0 } };
}

export function responsesTextPart(chunk: any): ContentPart {
    const text = typeof chunk.delta === 'string' ? chunk.delta : chunk.text ?? chunk.refusal;
    // 老兼容事件没有任何 item 定位符，继续使用原来的文本累加路径。
    if (typeof chunk.item_id !== 'string' && typeof chunk.output_index !== 'number') return { text };
    return { text, openaiResponsesMessage: {
        ...(typeof chunk.item_id === 'string' ? { id: chunk.item_id } : {}),
        ...(typeof chunk.output_index === 'number' ? { outputIndex: chunk.output_index } : {}),
        contentIndex: chunk.content_index ?? 0,
        contentType: chunk.type.startsWith('response.refusal.') ? 'refusal' : 'output_text'
    } };
}

export function sameResponsesMessage(a?: MessageMetadata, b?: MessageMetadata): boolean {
    if (!a || !b) return false;
    if (a.id && b.id) return a.id === b.id;
    // 部分兼容端点只在 added/done 返回 id，文本增量仅有 output_index。
    // 单侧缺 id 时仍可用共同 index 合并；两个明确不同的 id 则绝不能被 index 覆盖。
    if (a.outputIndex !== undefined || b.outputIndex !== undefined) return a.outputIndex !== undefined && a.outputIndex === b.outputIndex;
    if (a.id || b.id) return false;
    return a.phase === b.phase && a.status === b.status;
}

export function responsesMessageFields(value?: MessageMetadata): Record<string, unknown> {
    return value ? {
        ...(value.id !== undefined ? { id: value.id } : {}),
        ...(value.status !== undefined ? { status: value.status } : {}),
        ...(value.phase !== undefined ? { phase: value.phase } : {})
    } : {};
}
