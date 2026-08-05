/**
 * SummarizeService.handleAutoSummarize 溢出裁剪回归测试
 *
 * 覆盖（H2 / H4 / M4）：
 * - 溢出检查与预算估算口径一致（usageMetadata / tokenCountByChannel 优先）
 * - 溢出裁剪循环迭代：整轮排除后重新估算，直到装得下或没有可排除的内容
 * - 全部排除后仍超限：返回 CONTEXT_OVERFLOW，不把必败的请求发给 API
 * - abort（ChannelError.CANCELLED_ERROR / 原生 AbortError）返回 ABORTED，不当作普通失败
 * - previousSummarizedCount 从最后一个总结消息读取；字段缺失时往前找更早的总结消息
 */

import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';
import { ChannelError, ErrorType } from '../../modules/channel/types';
import type { Content } from '../../modules/conversation/types';

// ==================== 消息构造工具 ====================

/** 真实用户消息（带 tokenCountByChannel，走精确估算口径） */
const userMsg = (text: string, tokens: number, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    tokenCountByChannel: { openai: tokens },
    ...extra
});

/** functionCall 消息（model 角色，走 usageMetadata 口径） */
const fcMsg = (id: string, tokens: number): Content => ({
    role: 'model',
    parts: [{ functionCall: { name: 'tool', args: {}, id } }],
    usageMetadata: { totalTokenCount: tokens, promptTokenCount: 0 }
});

/** functionResponse 消息（user 角色，带 tokenCountByChannel） */
const frMsg = (id: string, tokens: number): Content => ({
    role: 'user',
    isFunctionResponse: true,
    parts: [{ functionResponse: { name: 'tool', response: { ok: true }, id } }],
    tokenCountByChannel: { openai: tokens }
});

/** model 文本消息（走 usageMetadata 口径） */
const modelMsg = (text: string, tokens: number): Content => ({
    role: 'model',
    parts: [{ text }],
    usageMetadata: { totalTokenCount: tokens, promptTokenCount: 0 }
});

/** 总结消息 */
const summaryMsg = (text: string, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    isSummary: true,
    ...extra
});

// ==================== 测试脚手架 ====================

const SUCCESS_SUMMARY: Content = {
    role: 'model',
    parts: [{ text: '总结完成' }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100 }
};

interface HarnessOptions {
    fullHistory: Content[];
    lastSummaryIndex?: number;
    maxContextTokens?: number;
    keepRecentTokens?: number | string;
    keepRecentRounds?: number;
    summarizeMaxInputRatio?: number;
    generateContent?: Content;
    generateError?: Error;
}

interface Harness {
    service: SummarizeService;
    generate: jest.Mock;
    insertContent: jest.Mock;
    getHistoryRef: jest.Mock;
}

function createHarness(options: HarnessOptions): Harness {
    const {
        fullHistory,
        lastSummaryIndex = -1,
        maxContextTokens = 1000,
        keepRecentTokens = '10%',
        keepRecentRounds = 1,
        summarizeMaxInputRatio = 0.5,
        generateContent = SUCCESS_SUMMARY,
        generateError
    } = options;

    const configManager = {
        getConfig: jest.fn(async () => ({
            id: 'cfg1',
            type: 'openai',
            enabled: true,
            maxContextTokens
        }))
    };

    const generate = jest.fn(async () => {
        if (generateError) {
            throw generateError;
        }
        return { content: generateContent };
    });

    const getHistoryRef = jest.fn(async () => fullHistory);
    const insertContent = jest.fn(async () => undefined);

    const contextTrimService = {
        findLastSummaryIndex: jest.fn(() => lastSummaryIndex),
        identifyRounds: jest.fn(() => [])
    };

    const settingsManager = {
        getSummarizeConfig: jest.fn(() => ({
            keepRecentRounds,
            keepRecentTokens,
            useSeparateModel: false,
            summarizeChannelId: '',
            summarizeModelId: '',
            summarizeMaxInputRatio,
            autoSummarizePrompt: ''
        }))
    };

    const service = new SummarizeService(
        configManager as any,
        { generate } as any,
        { getHistoryRef, insertContent } as any,
        contextTrimService as any,
        settingsManager as any
    );

    return { service, generate, insertContent, getHistoryRef };
}

// ==================== 测试用例 ====================

describe('SummarizeService.handleAutoSummarize - 溢出裁剪', () => {
    it('无工具交互可排除且超出上下文：返回 CONTEXT_OVERFLOW，不发 API 请求', async () => {
        const { service, generate, insertContent } = createHarness({
            // 单轮超大：3000 + 1000 token，预算 100，maxInput = 4000 * 0.5 = 2000
            fullHistory: [userMsg('老问题', 3000), modelMsg('老回答', 1000)],
            maxContextTokens: 4000
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('CONTEXT_OVERFLOW');
        }
        expect(generate).not.toHaveBeenCalled();
        expect(insertContent).not.toHaveBeenCalled();
    });

    it('溢出时排除最后一轮工具交互（整轮一起排除），重新估算后正常总结', async () => {
        const { service, generate, insertContent } = createHarness({
            // 三轮：500 / 500 / 400；预算 100 → 轮内细粒度切点落在轮3尾部（1400 token 被纳入总结），
            // maxInput = 1000 * 0.5 = 500 → 逐轮向前排除，最终只总结轮1（500 token）
            fullHistory: [
                userMsg('r1', 100), fcMsg('fc1', 200), frMsg('fc1', 200),
                userMsg('r2', 100), fcMsg('fc2', 200), frMsg('fc2', 200),
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100),
                modelMsg('done', 100)
            ],
            summarizeMaxInputRatio: 0.9
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 排除后范围 = [u1, fc1, fr1]（500 token，恰好装下），插入点 3
            expect(result.insertIndex).toBe(3);
            expect(result.summarizedMessageCount).toBe(3);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        const history = (generate.mock.calls[0][0] as { history: Content[] }).history;
        // 3 条被总结消息 + 1 条总结提示词
        expect(history.length).toBe(4);
        const inserted = insertContent.mock.calls[0];
        expect(inserted[1]).toBe(3);
        expect((inserted[2] as Content).isSummary).toBe(true);
        expect((inserted[2] as Content).summarizedMessageCount).toBe(3);
    });

    it('同一轮内的多个工具交互一起排除（不拆散轮）', async () => {
        const { service, generate } = createHarness({
            // 轮2 有两个工具交互（fc2a/fc2b）；总结范围 = 轮1+轮2 = 800 token > 500
            fullHistory: [
                userMsg('r1', 100), fcMsg('fc1', 100), frMsg('fc1', 100),
                userMsg('r2', 100), fcMsg('fc2a', 100), frMsg('fc2a', 100),
                fcMsg('fc2b', 100), frMsg('fc2b', 100),
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100),
                modelMsg('done', 100)
            ],
            summarizeMaxInputRatio: 0.9
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 整轮2（含两个工具交互与轮首用户消息）一起排除，插入点 = 轮2 起点 3
            expect(result.insertIndex).toBe(3);
        }
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('迭代排除后仍超限：返回 CONTEXT_OVERFLOW，不发 API 请求', async () => {
        const { service, generate, insertContent } = createHarness({
            // 轮1 = 700 token：排除轮2（300）后仍剩 700 > 500，继续排除时轮1起点即范围起点 → 无法收缩
            // 预算 20%（200）使规划器能先产生一个可用的轮内切点（cutIndex=7）
            fullHistory: [
                userMsg('r1', 100), fcMsg('fc1', 300), frMsg('fc1', 300),
                userMsg('r2', 100), fcMsg('fc2', 100), frMsg('fc2', 100),
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100)
            ],
            keepRecentTokens: '20%'
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('CONTEXT_OVERFLOW');
        }
        expect(generate).not.toHaveBeenCalled();
        expect(insertContent).not.toHaveBeenCalled();
    });

    it('从旧总结开始的范围：previousSummarizedCount 从最后一个总结消息读取', async () => {
        const { service, generate, insertContent } = createHarness({
            fullHistory: [
                summaryMsg('sum1', { summarizedMessageCount: 4 }),
                fcMsg('fc1', 100), frMsg('fc1', 100),
                userMsg('r2', 100), fcMsg('fc2', 100), frMsg('fc2', 100),
                modelMsg('done', 100)
            ],
            lastSummaryIndex: 0
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 旧总结累计覆盖 4 条 + 本次新总结 [fc1, fr1]（2 条）= 6；插入点 = 旧总结 + 2 = 3
            expect(result.summarizedMessageCount).toBe(6);
            expect(result.insertIndex).toBe(3);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        expect(insertContent).toHaveBeenCalledTimes(1);
    });

    it('最后一个总结缺 summarizedMessageCount：往前找更早总结的累计值，不回退数组下标', async () => {
        const { service, generate } = createHarness({
            fullHistory: [
                summaryMsg('sum1', { summarizedMessageCount: 3 }),
                modelMsg('m1', 100),
                summaryMsg('sum2'), // 缺 summarizedMessageCount
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100)
            ],
            lastSummaryIndex: 2,
            keepRecentTokens: '25%' // 250：允许轮内截断到 fc3 之后
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 旧累计 3（sum1）+ 本次新总结 [r3]（1 条）= 4；旧实现会回退到数组下标 2 得出 3
            expect(result.summarizedMessageCount).toBe(4);
        }
        expect(generate).toHaveBeenCalledTimes(1);
    });
});

describe('SummarizeService.handleAutoSummarize - abort 判定', () => {
    it('ChannelError CANCELLED_ERROR：返回 ABORTED 而非普通失败', async () => {
        const { service, generate } = createHarness({
            fullHistory: [userMsg('q1', 100), userMsg('q2', 100)],
            generateError: new ChannelError(ErrorType.CANCELLED_ERROR, 'cancelled')
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(generate).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('ABORTED');
        }
    });

    it('原生 AbortError：返回 ABORTED 而非普通失败', async () => {
        const abortError = new Error('aborted');
        abortError.name = 'AbortError';
        const { service, generate } = createHarness({
            fullHistory: [userMsg('q1', 100), userMsg('q2', 100)],
            generateError: abortError
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(generate).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('ABORTED');
        }
    });

    it('普通 API 错误仍按 UNKNOWN_ERROR 返回', async () => {
        const { service, generate } = createHarness({
            fullHistory: [userMsg('q1', 100), userMsg('q2', 100)],
            generateError: new Error('rate limited')
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(generate).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('UNKNOWN_ERROR');
        }
    });
});
