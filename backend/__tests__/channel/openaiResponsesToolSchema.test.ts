import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import type { ToolDeclaration } from '../../tools/types';
import { createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';

const topics: ToolDeclaration = {
    name: 'memory_topics', description: 'List scopes, then continue with the returned cursor.',
    parameters: {
        type: 'object', properties: {
            cursor: { type: 'string', maxLength: 512 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
        }, required: [],
    },
};

function request(tools: ToolDeclaration[], strictToolsEnabled?: boolean) {
    return new OpenAIResponsesFormatter().buildRequest({ configId: 'responses', history: [] },
        createOpenAIResponsesConfig({ strictToolsEnabled }), tools).body as any;
}

describe('Responses 工具参数可选语义', () => {
    test('默认显式禁用上游自动严格化，不强迫首屏调用编造 cursor', () => {
        const original = structuredClone(topics);
        const converted = request([topics]).tools[0];
        expect(converted.strict).toBe(false);
        expect(converted.parameters).toEqual(topics.parameters);
        expect(converted.parameters.required).toEqual([]);
        expect(converted.parameters.properties.cursor.type).toBe('string');
        expect(topics).toEqual(original);
    });

    test.each([undefined, false])('渠道未启用 strict (%s) 时声明标记不会暗中开启', enabled => {
        expect(request([{ ...topics, strict: true }], enabled).tools[0].strict).toBe(false);
    });

    test('启用 strict 后 nullable 代表省略，原 required 参数仍不可省略', () => {
        // 样本保留嵌套数组边界，防止只转换顶层而让子项 optional 再次变成必填。
        const tool = {
            ...topics, strict: true,
            parameters: {
                type: 'object', required: ['action'], properties: {
                    action: { type: 'string', enum: ['read'] },
                    items: { type: 'array', items: { type: 'object', properties: {
                        path: { type: 'string' }, line: { type: 'integer', minimum: 1 },
                    }, required: ['path'] } },
                },
            },
        } as ToolDeclaration;
        const original = structuredClone(tool);
        const converted = request([tool], true).tools[0];
        expect(converted.strict).toBe(true);
        expect(converted.parameters.additionalProperties).toBe(false);
        expect(converted.parameters.required).toEqual(['action', 'items']);
        expect(converted.parameters.properties.action).toEqual(tool.parameters.properties.action);
        const items = converted.parameters.properties.items.anyOf;
        expect(items[1]).toEqual({ type: 'null' });
        expect(items[0].items).toMatchObject({ additionalProperties: false, required: ['path', 'line'] });
        expect(items[0].items.properties.line).toEqual({ anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] });
        expect(tool).toEqual(original);
    });

    test('没有 strict 标记的工具和任意字典保持原 schema，不因同批其它工具开启而改写', () => {
        const dictionary = { ...topics, name: 'dictionary', parameters: {
            type: 'object', properties: { values: { type: 'object', additionalProperties: { type: 'string' } } }, required: [],
        } } as ToolDeclaration;
        const converted = request([{ ...topics, strict: true }, dictionary], true).tools;
        expect(converted.map((tool: any) => tool.strict)).toEqual([true, false]);
        expect(converted[1].parameters).toEqual(dictionary.parameters);
    });

    test('显式严格化任意字典会明确失败，不悄悄删掉允许的键', () => {
        const dictionary = { ...topics, strict: true, parameters: {
            type: 'object', properties: { values: { type: 'object', additionalProperties: { type: 'string' } } }, required: [],
        } } as ToolDeclaration;
        expect(() => request([dictionary], true)).toThrow('arbitrary object keys');
    });

    test('工具声明在连续构建中确定不变，空工具集不生成 tools', () => {
        expect(request([topics])).toEqual(request([topics]));
        expect(request([]).tools).toBeUndefined();
    });
});
