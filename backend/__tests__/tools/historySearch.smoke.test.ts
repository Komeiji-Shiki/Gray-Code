/**
 * history_search 模块 smoke 测试（模块化重构回归网）
 *
 * 覆盖点：
 * - virtualDocument：Round 标题与行号范围、tool_call/tool_result 标签、thought 跳过、
 *   isSummarized 过滤、addLineNumbers 对齐、超长行显示截断
 * - historySearch：handleSearch 命中标记/无匹配/suspected_regex 提示/非法正则/关键词回退/
 *   匹配数上限；handleRead 单行不截断/越界错误/maxReadLines 截断
 * - history_search 壳：工具声明与 handler 装配（mock 对话历史 store 的 search 基本路径）
 *
 * 依赖全部内联（mock settingsContext + conversationStore），无共享 fixture。
 */

import { DEFAULT_HISTORY_SEARCH_CONFIG } from '../../modules/settings/types';
import type { Content } from '../../modules/conversation/types';
import type { RuntimeConfig } from '../../tools/history/historySearch';

jest.mock('../../core/settingsContext', () => ({
    getGlobalSettingsManager: () => null
}));

import { formatToDocument, getSummarizedMessages, addLineNumbers, truncateLineForDisplay } from '../../tools/history/virtualDocument';
import { handleSearch, handleRead } from '../../tools/history/historySearch';
import { createHistorySearchTool } from '../../tools/history/history_search';

const DEFAULT_CFG: RuntimeConfig = { ...DEFAULT_HISTORY_SEARCH_CONFIG } as RuntimeConfig;

function userMsg(text: string, extra: Partial<Content> = {}): Content {
    return { role: 'user', parts: [{ text }], ...extra };
}

function modelMsg(parts: Content['parts'], extra: Partial<Content> = {}): Content {
    return { role: 'model', parts, ...extra };
}

describe('virtualDocument：虚拟文档格式化', () => {
    test('单回合生成 Round 标题且行号范围覆盖整个文档', () => {
        const doc = formatToDocument([
            userMsg('你好'),
            modelMsg([{ text: '好的' }])
        ]);

        expect(doc[0]).toContain('══ Round 1');
        expect(doc[0]).toContain('L1-L7');
        expect(doc).toContain('👤 User:');
        expect(doc).toContain('🤖 Model:');
        expect(doc).toContain('你好');
    });

    test('多回合生成 Round 1/2 标题与正确范围、回合间空行', () => {
        const doc = formatToDocument([
            userMsg('a'),
            modelMsg([{ text: 'b' }]),
            userMsg('c')
        ]);

        expect(doc[0]).toContain('Round 1');
        expect(doc[0]).toContain('L1-L7');
        expect(doc[7]).toBe(''); // 回合间空行
        expect(doc[8]).toContain('Round 2');
        expect(doc[8]).toContain('L9-L12');
    });

    test('functionCall part 输出 [tool_call] 标签与 name(args) 行', () => {
        const doc = formatToDocument([
            modelMsg([{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }])
        ]);

        expect(doc).toContain('🤖 Model [tool_call]:');
        expect(doc).toContain('read_file({"path":"a.ts"})');
    });

    test('functionResponse part 输出 [tool_result] 标签，thought part 被跳过', () => {
        const doc = formatToDocument([
            modelMsg([
                { text: 'thinking...', thought: true },
                { text: 'answer' },
                { functionResponse: { name: 'read_file', response: { ok: true } } }
            ])
        ]);

        expect(doc).toContain('🤖 Model [tool_result]:');
        expect(doc).toContain('answer');
        expect(doc).toContain('read_file → {"ok":true}');
        expect(doc.some(line => line.includes('thinking'))).toBe(false);
    });

    test('getSummarizedMessages 只返回 isSummarized 标记的消息', () => {
        const history = [
            userMsg('原始内容', { isSummarized: true }),
            userMsg('未总结')
        ];
        const summarized = getSummarizedMessages(history);
        expect(summarized).toHaveLength(1);
        expect(summarized[0].parts[0]).toEqual({ text: '原始内容' });
    });

    test('addLineNumbers 对齐 + truncateLineForDisplay 超长行截断', () => {
        const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
        const formatted = addLineNumbers(lines, 1);
        expect(formatted).toContain(' 1 | line-1');
        expect(formatted).toContain('10 | line-10');

        const long = 'x'.repeat(600);
        const truncated = truncateLineForDisplay(long, 5, 100);
        expect(truncated.length).toBeLessThan(long.length);
        expect(truncated).toContain('read line 5 for full content');
    });
});

describe('handleSearch：关键词/正则搜索', () => {
    const docLines = ['line one', 'websocket connected', 'line three', 'websocket again'];

    test('关键词命中：返回匹配行（> 标记）与行号', () => {
        const result = handleSearch(docLines, 'websocket', false, DEFAULT_CFG);
        expect(result.success).toBe(true);
        const data = String(result.data);
        expect(data).toContain('websocket');
        expect(data).toContain('>');
        expect((data.match(/>/g) || [])).toHaveLength(2);
    });

    test('无匹配：success 且提示中包含查询词', () => {
        const result = handleSearch(docLines, 'not-there', false, DEFAULT_CFG);
        expect(result.success).toBe(true);
        expect(String(result.data)).toContain('not-there');
    });

    test('疑似正则语法（is_regex=false 且无匹配）给出 suspected_regex 提示', () => {
        const result = handleSearch(['foo bar'], 'ws.*', false, DEFAULT_CFG);
        expect(result.success).toBe(true);
        expect(String(result.data)).toContain('suspected_regex');
    });

    test('非法正则（is_regex=true）返回失败', () => {
        const result = handleSearch(docLines, '[', true, DEFAULT_CFG);
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    test('完整短语无匹配时回退为空格分隔关键词搜索并提示', () => {
        const lines = ['hello foo', 'bar world'];
        const result = handleSearch(lines, 'hello world', false, DEFAULT_CFG);
        expect(result.success).toBe(true);
        expect(String(result.data)).toContain('hello, world');
    });

    test('匹配数达到 maxSearchMatches 上限时输出限制提示', () => {
        const lines = ['x1', 'x2', 'x3', 'x4', 'x5'];
        const cfg = { ...DEFAULT_CFG, maxSearchMatches: 2 };
        const result = handleSearch(lines, 'x', false, cfg);
        expect(result.success).toBe(true);
        const data = String(result.data);
        expect((data.match(/>/g) || [])).toHaveLength(2);
        expect(data).toContain('2');
    });
});

describe('handleRead：按行号读取', () => {
    const longLine = 'y'.repeat(600);
    const docLines = ['a', 'b', longLine, 'd', 'e'];

    test('单行读取不截断长行；多行读取超过 maxReadLines 时截断并提示', () => {
        const single = handleRead(docLines, 3, 3, DEFAULT_CFG);
        expect(single.success).toBe(true);
        expect(String(single.data)).toContain(longLine);

        const cfg = { ...DEFAULT_CFG, maxReadLines: 2 };
        const limited = handleRead(docLines, 1, 5, cfg);
        expect(limited.success).toBe(true);
        expect(String(limited.data)).toContain('start_line=3');
    });
});

describe('history_search 壳：工具装配', () => {
    test('工具声明与 handler：search 模式基于 mock 对话历史返回结果', async () => {
        const tool = createHistorySearchTool();
        expect(tool.declaration.name).toBe('history_search');
        expect(tool.declaration.parameters.properties).toHaveProperty('mode');

        const result = await tool.handler(
            { mode: 'search', query: 'websocket' },
            {
                conversationId: 'c1',
                conversationStore: {
                    getHistory: jest.fn(async () => [
                        userMsg('websocket 连接怎么建立'),
                        modelMsg([{ text: '参考文档' }])
                    ])
                }
            } as any
        );

        expect(result.success).toBe(true);
        expect(String(result.data)).toContain('websocket');
    });
});
