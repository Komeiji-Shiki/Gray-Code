/**
 * SubAgent transcript 组装辅助（窗口深拷贝 / 预览提取 / 修订号 / provider 历史投影与恢复）。
 *
 * 拆分说明：从 runEventBus.ts 迁出（纯移动，逻辑一字未改）。
 */

import type { Content } from '../../../modules/conversation/types';
import type { SubAgentTranscriptData } from '../../../modules/conversation/storage';
import { MANIFEST_PREVIEW_MAX_LENGTH, type SubAgentRunSnapshot } from './types';

export function cloneContentsForWindow(contents: Content[]): Content[] {
    // 修改原因：按需 transcript window 会被前端本地流式 delta 临时修改，不能把事件总线内存对象引用直接交出去。
    // 修改方式：只对窗口切片做 JSON 深拷贝，而不是像旧 snapshots 首包那样复制所有 run 的完整 contents。
    // 修改目的：保持事件总线仍是唯一真源，同时把 Monitor 首屏和窗口请求的复制成本限定在窗口大小内。
    return JSON.parse(JSON.stringify(contents || [])) as Content[];
}

export function extractContentPreview(content: Content | undefined): string | undefined {
    if (!content) return undefined;
    // 修改原因：manifest 会在每个 llm_delta 事件上重新派生，旧实现先把整条消息的全部 parts 拼成完整字符串
    //          再截断到 160 字，对动辄数万字符的模型输出构成流式热路径上的 O(正文长度) 重复开销。
    // 修改方式：逐 part 累积，一旦超过预览上限立即停止读取后续内容。
    // 修改目的：预览成本与预览长度成正比，而不是与消息长度成正比。
    const segments: string[] = [];
    let length = 0;
    for (const part of content.parts || []) {
        let segment = '';
        if (typeof part.text === 'string' && part.text.trim()) {
            segment = part.text.trim();
        } else if (part.functionCall?.name) {
            segment = `调用工具 ${part.functionCall.name}`;
        } else if (part.functionResponse?.name) {
            segment = `工具结果 ${part.functionResponse.name}`;
        }
        if (!segment) continue;
        // 单个 part 就可能远超上限，先按上限裁剪再累积
        segments.push(segment.length > MANIFEST_PREVIEW_MAX_LENGTH + 1
            ? segment.slice(0, MANIFEST_PREVIEW_MAX_LENGTH + 1)
            : segment);
        length += segment.length + 1;
        if (length > MANIFEST_PREVIEW_MAX_LENGTH) break;
    }

    const text = segments.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > MANIFEST_PREVIEW_MAX_LENGTH
        ? `${text.slice(0, MANIFEST_PREVIEW_MAX_LENGTH)}…`
        : text;
}

export function bumpContentRevision(snapshot: SubAgentRunSnapshot): void {
    // 修改原因：append/update/replace 都会改变 transcript 真源，窗口缓存必须能识别这些变化。
    // 修改方式：所有 Content[] 写入口在发 content_snapshot 前递增 contentRevision。
    // 修改目的：避免旧窗口继续接收下一轮 delta，修复多次回复混为一楼。
    snapshot.contentRevision += 1;
}

function providerHistoryBucketKey(content: Content): string {
    const parts = content.parts || [];
    // 粗指纹：role + parts 数量 + 首个文本部分的长度。
    // 绝大多数消息在这一层即可区分，避免对大型 parts（图片/长工具结果）做全量 stringify。
    const firstPart = parts[0] as { text?: unknown } | undefined;
    const firstTextLength = typeof firstPart?.text === 'string' ? firstPart.text.length : 0;
    return `${content.role}:${parts.length}:${firstTextLength}`;
}

function providerHistoryKey(content: Content): string {
    return JSON.stringify({ role: content.role, parts: content.parts || [] });
}

export function buildLastSentHistoryProjection(
    contents: Content[],
    lastSentHistory: Content[]
): NonNullable<SubAgentTranscriptData['lastSentHistoryProjection']> {
    // 两级索引：先按粗桶（role + parts 数量 + 首文本长度）分组，桶内再惰性建立精确 key 索引。
    // 与直接把每个 content 全量 stringify 作 Map key 相比，桶内无匹配时（绝大多数情况）不会
    // 为大型 parts 产生大字符串；同一桶的精确索引也只构建一次。
    const contentIndicesByBucket = new Map<string, number[]>();
    contents.forEach((content, index) => {
        const bucket = providerHistoryBucketKey(content);
        const indices = contentIndicesByBucket.get(bucket) ?? [];
        indices.push(index);
        contentIndicesByBucket.set(bucket, indices);
    });
    const exactIndexByBucket = new Map<string, Map<string, number[]>>();
    const getExactIndex = (bucket: string): Map<string, number[]> => {
        let exact = exactIndexByBucket.get(bucket);
        if (exact) return exact;
        exact = new Map<string, number[]>();
        for (const index of contentIndicesByBucket.get(bucket) ?? []) {
            const key = providerHistoryKey(contents[index]);
            const indices = exact.get(key) ?? [];
            indices.push(index);
            exact.set(key, indices);
        }
        exactIndexByBucket.set(bucket, exact);
        return exact;
    };
    const consumedByKey = new Map<string, number>();
    return {
        version: 1,
        entries: lastSentHistory.map(content => {
            const exact = getExactIndex(providerHistoryBucketKey(content));
            const key = providerHistoryKey(content);
            const indices = exact.get(key) ?? [];
            const consumed = consumedByKey.get(key) ?? 0;
            const contentIndex = indices[consumed];
            if (contentIndex === undefined) {
                return { content: JSON.parse(JSON.stringify(content)) as Content };
            }
            consumedByKey.set(key, consumed + 1);
            return { contentIndex };
        })
    };
}

export function restoreLastSentHistory(data: SubAgentTranscriptData): Content[] | undefined {
    if (Array.isArray(data.lastSentHistory)) {
        return data.lastSentHistory;
    }
    if (!Array.isArray(data.contents)) return undefined;
    const projection = data.lastSentHistoryProjection;
    if (!projection || projection.version !== 1 || !Array.isArray(projection.entries)) return undefined;
    const restored: Content[] = [];
    for (const entry of projection.entries) {
        if (!entry || typeof entry !== 'object') return undefined;
        if ('content' in entry) {
            if (!entry.content || typeof entry.content !== 'object') return undefined;
            restored.push(JSON.parse(JSON.stringify(entry.content)) as Content);
            continue;
        }
        if (!('contentIndex' in entry) || !Number.isInteger(entry.contentIndex) || entry.contentIndex < 0) {
            return undefined;
        }
        const source = data.contents[entry.contentIndex];
        if (!source || typeof source !== 'object' || !Array.isArray(source.parts)) return undefined;
        // Provider formatter只消费 role/parts；显示层的 index/timestamp/isFunctionResponse 等字段不属于请求前缀。
        restored.push({
            role: source.role,
            parts: JSON.parse(JSON.stringify(source.parts || []))
        } as Content);
    }
    return restored;
}
