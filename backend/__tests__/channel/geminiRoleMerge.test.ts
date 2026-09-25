/**
 * 回归测试：Gemini generateContent 的相邻同角色 content 合并
 *
 * 背景（真实事故，抓包坐实）：动态上下文以独立 user content 插在当前用户回合之前，
 * 请求体出现 [user, model, user(动态上下文), user(用户提问)] 的连续两条 user。
 * Gemini generateContent 要求 contents 严格 user/model 交替（否则官方端点 400
 * "Please ensure that multiturn requests alternate between user and model"）；
 * 上游接受时也可能把连续同角色归一化成「只有其中一条是当前输入」，实测后果是
 * 模型只回答了动态上下文，把用户真正的问题整条忽略。
 *
 * 修复：下发前按角色合并相邻 content（parts 按原顺序拼接），用户输入始终位于最后
 * 一条 content 的末尾；model(functionCall) 与其后的 user(functionResponse) 角色
 * 不同，天然交替，不会跨工具边界错误合并。
 *
 * 后续修复：合并后各段 parts 之间没有边界标识，模型仍可能把动态上下文整段当成
 * 最新用户输入。现在在真实用户输入（isUserInput）前插入 USER_INPUT_MARKER 分隔
 * 标识，明确标出其后才是本轮用户输入。
 */

import { GeminiFormatter } from '../../modules/channel';
import type { Content } from '../../modules/conversation/types';
import type { GeminiConfig } from '../../modules/config/types';
import type { GenerateRequest, RequestPromptContext } from '../../modules/channel/types';

const USER_INPUT_MARKER = '\n\n[User Input]\n\n';

function createGeminiConfig(): GeminiConfig {
    return {
        id: 'gemini-test',
        name: 'Gemini Test',
        type: 'gemini',
        enabled: true,
        url: 'http://127.0.0.1:5102/v1beta',
        apiKey: 'test-key',
        model: 'gemini-3.8-flash',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call'
    } as GeminiConfig;
}

function buildContents(history: Content[], promptContext?: RequestPromptContext, strategy: 'single' | 'preserve' = 'single'): any[] {
    const request: GenerateRequest = {
        configId: 'gemini-test',
        history,
        dynamicContextStrategy: strategy,
        ...(promptContext ? { promptContext } : {})
    };
    return new GeminiFormatter().buildRequest(request, createGeminiConfig()).body.contents;
}

function textOf(content: any): string {
    return (content.parts ?? []).map((part: any) => part.text ?? '').join('|');
}

/** Gemini 硬约束：任意相邻两条 content 的角色必须不同。 */
function expectAlternatingRoles(contents: any[]): void {
    for (let i = 1; i < contents.length; i++) {
        expect(contents[i].role).not.toBe(contents[i - 1].role);
    }
}

describe('GeminiFormatter 相邻同角色 content 合并', () => {
    const contextMessage: Content = { role: 'user', parts: [{ text: '【动态上下文】技能与环境' }] };
    const history: Content[] = [
        { role: 'user', isUserInput: true, parts: [{ text: '第一问' }] },
        { role: 'model', parts: [{ text: '第一答' }] },
        { role: 'user', isUserInput: true, parts: [{ text: '吃了吗？' }] }
    ];

    test('entry 模式下 after-history 动态上下文并入当前用户 content，顺序保持上下文在前', () => {
        const contents = buildContents(history, {
            beforeHistoryMessages: [],
            afterHistoryMessages: [contextMessage],
            historyPlacement: 'entry'
        });

        expect(contents.map(content => content.role)).toEqual(['user', 'model', 'user']);
        expectAlternatingRoles(contents);
        expect(textOf(contents[2])).toBe(`【动态上下文】技能与环境|${USER_INPUT_MARKER}|吃了吗？`);
    });

    test('legacy 单份动态上下文并入当前用户 content', () => {
        const contents = buildContents(history, {
            beforeHistoryMessages: [contextMessage],
            afterHistoryMessages: [],
            historyPlacement: 'legacy'
        });

        expect(contents.map(content => content.role)).toEqual(['user', 'model', 'user']);
        expectAlternatingRoles(contents);
        expect(textOf(contents[2])).toBe(`【动态上下文】技能与环境|${USER_INPUT_MARKER}|吃了吗？`);
    });

    test('preserve 模式回插的历史快照同样并入相邻同角色 content', () => {
        const contents = buildContents([
            { role: 'user', isUserInput: true, parts: [{ text: '第一问' }] },
            { role: 'model', parts: [{ text: '第一答' }] },
            { role: 'user', isUserInput: true, parts: [{ text: '第二问' }] },
            { role: 'model', parts: [{ text: '第二答' }] },
            { role: 'user', isUserInput: true, parts: [{ text: '第三问' }] }
        ], {
            beforeHistoryMessages: [{ role: 'user', parts: [{ text: '本轮快照' }] }],
            afterHistoryMessages: [],
            historyPlacement: 'legacy'
        }, 'preserve');

        expectAlternatingRoles(contents);
        expect(textOf(contents[contents.length - 1])).toBe(`本轮快照|${USER_INPUT_MARKER}|第三问`);
    });

    test('工具流程：functionResponse 与后续用户文本合并，工具配对与顺序不变', () => {
        const contents = buildContents([
            { role: 'user', isUserInput: true, parts: [{ text: '读文件' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } } }] },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { success: true } } }] },
            { role: 'user', isUserInput: true, parts: [{ text: '顺便看下 B' }] }
        ]);

        expect(contents.map(content => content.role)).toEqual(['user', 'model', 'user']);
        expectAlternatingRoles(contents);
        // functionResponse 仍在紧随 functionCall 的 content 内，配对关系不破
        expect(contents[1].parts[0].functionCall.id).toBe('call_1');
        expect(contents[2].parts[0].functionResponse.id).toBe('call_1');
        expect(contents[2].parts[1].text).toBe(USER_INPUT_MARKER);
        expect(contents[2].parts[2].text).toBe('顺便看下 B');
    });

    test('交替历史与单条消息不受影响', () => {
        const contents = buildContents([
            { role: 'user', isUserInput: true, parts: [{ text: '问' }] },
            { role: 'model', parts: [{ text: '答' }] }
        ]);

        expect(contents.map(content => content.role)).toEqual(['user', 'model']);
        expect(contents[0].parts).toEqual([{ text: '问' }]);
        expect(contents[1].parts).toEqual([{ text: '答' }]);
    });

    test('连续 model content 合并后上下文条目仍排在原回答之后', () => {
        const contents = buildContents(history, {
            beforeHistoryMessages: [],
            afterHistoryMessages: [
                { role: 'model', parts: [{ text: '【模型侧上下文】' }] },
                { role: 'user', parts: [{ text: '【用户侧上下文】' }] }
            ],
            historyPlacement: 'entry'
        });

        expect(contents.map(content => content.role)).toEqual(['user', 'model', 'user']);
        expectAlternatingRoles(contents);
        expect(textOf(contents[1])).toBe('第一答|【模型侧上下文】');
        expect(textOf(contents[2])).toBe(`【用户侧上下文】|${USER_INPUT_MARKER}|吃了吗？`);
    });

    test('system 预设条目转为 user 后与相邻用户回合合并', () => {
        const contents = buildContents([
            { role: 'user', isUserInput: true, parts: [{ text: '问' }] },
            { role: 'model', parts: [{ text: '答' }] },
            { role: 'system', parts: [{ text: '预设条目' }] },
            { role: 'user', isUserInput: true, parts: [{ text: '追问' }] }
        ]);

        expect(contents.map(content => content.role)).toEqual(['user', 'model', 'user']);
        expectAlternatingRoles(contents);
        expect(textOf(contents[2])).toBe(`预设条目|${USER_INPUT_MARKER}|追问`);
    });
});
