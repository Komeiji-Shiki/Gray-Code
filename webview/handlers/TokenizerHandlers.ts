/**
 * tokenizer 词表资源消息处理器
 *
 * 前端 TPS 统计的模型专属 tokenizer 词表（cl100k / DeepSeek V3）不在 vsix 内，
 * 由扩展端 TokenizerResourceManager 运行时下载/解压/转换/缓存到数据目录；
 * 本处理器负责把就绪的词表内容回传给前端（首次需要时触发下载，可等待较长时间）。
 */

import type { MessageHandler } from '../types';
import {
    getGlobalTokenizerResourceManager,
    type TokenizerResource,
    type TokenizerResourceName
} from '../../backend/modules/tokenizer';

/** 前端可用资源名白名单 */
function normalizeResourceName(data: unknown): TokenizerResourceName | null {
    const name = (data as { name?: unknown } | undefined)?.name;
    if (name === 'deepseek-v3') return 'deepseek-v3';
    if (name === 'cl100k' || name === undefined) return 'cl100k';
    return null;
}

/**
 * 获取 tokenizer 词表资源
 * data: { name: 'cl100k' | 'deepseek-v3' }
 * 返回 TokenizerResource { bpeRanks, patStr, specialTokens }
 * 下载失败/未初始化时返回错误（前端回退字符加权估算）
 */
export const getTokenizerResourceHandler: MessageHandler = async (data, requestId, ctx) => {
    const name = normalizeResourceName(data);
    if (!name) {
        ctx.sendError(requestId, 'TOKENIZER_INVALID_NAME', 'Invalid tokenizer resource name.');
        return;
    }

    const manager = getGlobalTokenizerResourceManager();
    if (!manager) {
        ctx.sendError(requestId, 'TOKENIZER_NOT_READY', 'Tokenizer resource manager is not initialized.');
        return;
    }

    try {
        const resource: TokenizerResource = await manager.ensureResource(name);
        ctx.sendResponse(requestId, resource);
    } catch (error: any) {
        ctx.sendError(
            requestId,
            'TOKENIZER_RESOURCE_ERROR',
            error?.message || `Failed to load tokenizer resource: ${name}`
        );
    }
};

/** 注册 tokenizer 资源处理器 */
export function registerTokenizerHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('tokenizer.getResource', getTokenizerResourceHandler);
}
