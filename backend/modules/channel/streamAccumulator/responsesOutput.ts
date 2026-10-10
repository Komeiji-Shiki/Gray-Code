import type { ContentPart } from '../../conversation/types';
import { sameResponsesMessage } from '../formatters/responsesMessage';

/** 不把两个 assistant output item（尤其 commentary/final_answer）拼成同一段。 */
export function mergeResponsesMessagePart(parts: ContentPart[], incoming: ContentPart, eventType?: string): { delta: ContentPart[]; structural: boolean } {
    const metadata = incoming.openaiResponsesMessage!;
    let existing = parts.find(part => sameResponsesMessage(part.openaiResponsesMessage, metadata)
        && (part.openaiResponsesMessage?.contentIndex ?? 0) === (metadata.contentIndex ?? 0));
    // 兼容旧 text.delta 省略 item_id 的流：done 只接管最后一段尚未归属原生 item 的正文。
    if (!existing && eventType === 'response.output_item.done') {
        const last = parts.at(-1);
        if (last && typeof last.text === 'string' && !last.thought && !last.openaiResponsesMessage && !last.functionCall) existing = last;
    }
    const previous = existing?.text ?? '';
    const isDelta = eventType?.endsWith('.delta') === true;
    const target = existing ?? { ...incoming };
    target.openaiResponsesMessage = { ...target.openaiResponsesMessage, ...metadata };
    target.text = isDelta && existing ? previous + (incoming.text ?? '') : incoming.text ?? previous;
    if (!existing) parts.push(target);
    // delta 已知是追加，不能每个 token 都扫描已累积全文；只在 done 校准时比较前缀。
    // done 修正/缩短由结构快照校准，不再次追加相同正文。
    const appended = isDelta ? incoming.text ?? ''
        : target.text.startsWith(previous) ? target.text.slice(previous.length) : '';
    const delta = appended ? [{ text: appended }] : [];
    return { delta, structural: !existing || !isDelta };
}

/**
 * completed/incomplete.output 是有序终态快照，不是新的增量。
 * 用它回填只在流末出现的密文/phase，避免再次追加全文与并发工具。
 * 对兼容端点省略的 reasoning 元数据仍保留 item.done 已取得的值。
 */
export function reconcileResponsesOutput(previous: ContentPart[], snapshot: ContentPart[]): { parts: ContentPart[]; delta: ContentPart[] } {
    // 终态批量回填共用首项索引，缺少 call id 的记录也保留原 find/some 的匹配结果。
    const callsById = new Map<string | undefined, ContentPart['functionCall']>();
    const reasoningById = new Map<string, ContentPart>();
    for (const part of previous) {
        const callId = part.functionCall?.id;
        if (!callsById.has(callId)) callsById.set(callId, part.functionCall);
        const reasoningId = part.openaiResponsesReasoning?.id;
        if (reasoningId && !reasoningById.has(reasoningId)) reasoningById.set(reasoningId, part);
    }
    const parts = snapshot.map(part => {
        if (part.functionCall) {
            const old = callsById.get(part.functionCall.id);
            // 终态可能省略先前完整 item 的 async 扩展；显式新值仍以终态为准。
            return { ...part, functionCall: { ...part.functionCall,
                ...(part.functionCall.async === undefined && old?.async !== undefined ? { async: old.async } : {}) } };
        }
        if (part.openaiResponsesMessage) {
            const old = previous.find(candidate => sameResponsesMessage(candidate.openaiResponsesMessage, part.openaiResponsesMessage)
                && (candidate.openaiResponsesMessage?.contentIndex ?? 0) === (part.openaiResponsesMessage?.contentIndex ?? 0));
            return { ...part, openaiResponsesMessage: { ...old?.openaiResponsesMessage, ...part.openaiResponsesMessage } };
        }
        const id = part.openaiResponsesReasoning?.id;
        const old = id ? reasoningById.get(id) : undefined;
        if (!old) return part;
        return { ...old, ...part,
            openaiResponsesReasoning: { ...old.openaiResponsesReasoning, ...part.openaiResponsesReasoning },
            ...(old.thoughtSignatures || part.thoughtSignatures ? {
                thoughtSignatures: { ...old.thoughtSignatures, ...part.thoughtSignatures }
            } : {})
        };
    });
    const delta: ContentPart[] = [];
    // 某些代理只在 completed 返回正文；已有增量的正常流绝不重复播放全文。
    for (const thought of [true, false]) {
        const text = (values: ContentPart[]) => values.filter(part => !!part.thought === thought).map(part => part.text ?? '').join('');
        const before = text(previous), after = text(parts);
        if (after.startsWith(before) && after.length > before.length) delta.push({ text: after.slice(before.length), ...(thought ? { thought: true } : {}) });
    }
    for (const part of parts) if (part.functionCall && !callsById.has(part.functionCall.id)) delta.push(part);
    return { parts, delta };
}
