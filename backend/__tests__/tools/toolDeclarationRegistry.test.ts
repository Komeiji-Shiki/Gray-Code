/**
 * 工具声明工厂注册表测试：反向注册契约（模块化重构遗留第 5 项）。
 *
 * 覆盖：
 * - 未注册时 getToolDeclarationFactory 返回 undefined（resolver 保持静态声明回退）；
 * - 注册后按名获取；工厂懒创建（每次调用重新执行，不缓存单例）；
 * - 同名重复注册为覆盖（幂等，重试初始化安全）；
 * - clearToolDeclarationFactories 清空全部注册（测试隔离）；
 * - 集成：ToolDeclarationResolver 注册工厂后产出动态 read_file 描述，未注册时保持静态声明。
 */

import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import type { Tool, ToolDeclaration } from '../../tools/types';
import {
    registerToolDeclarationFactory,
    getToolDeclarationFactory,
    clearToolDeclarationFactories
} from '../../tools/toolDeclarationRegistry';

const READ_FILE_DECLARATION: ToolDeclaration = {
    name: 'read_file',
    description: 'static read_file description',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
};

function createResolverHarness() {
    const toolRegistry = {
        getDeclarationsBy: jest.fn(() => [{
            ...READ_FILE_DECLARATION,
            parameters: JSON.parse(JSON.stringify(READ_FILE_DECLARATION.parameters))
        }])
    };
    const settingsManager = {
        getSettings: jest.fn(() => ({ toolsEnabled: {}, toolAutoExec: {}, toolsConfig: {} })),
        isToolEnabled: jest.fn(() => true),
        getGenerateImageConfig: jest.fn(() => ({}))
    };
    const resolver = new ToolDeclarationResolver(toolRegistry as any, settingsManager as any, undefined as any);
    return { resolver };
}

describe('toolDeclarationRegistry 反向注册', () => {
    afterEach(() => {
        clearToolDeclarationFactories();
    });

    test('未注册时返回 undefined', () => {
        expect(getToolDeclarationFactory('read_file')).toBeUndefined();
        expect(getToolDeclarationFactory('generate_image')).toBeUndefined();
    });

    test('注册后可获取，且工厂每次调用都重新构建（懒创建，不缓存单例）', () => {
        const calls: string[] = [];
        registerToolDeclarationFactory('read_file', (args) => {
            calls.push(`${args.channelType ?? 'none'}/${args.toolMode ?? 'none'}`);
            return {
                declaration: {
                    name: 'read_file',
                    description: `dynamic-${calls.length}`,
                    parameters: { type: 'object', properties: {} }
                },
                handler: async () => ({ success: true })
            } as Tool;
        });

        const factory = getToolDeclarationFactory('read_file')!;
        expect(factory).toBeDefined();
        const first = factory({ multimodalEnabled: true, channelType: 'openai', toolMode: 'function_call' });
        const second = factory({ multimodalEnabled: false });
        expect(calls).toEqual(['openai/function_call', 'none/none']);
        expect(first.declaration.description).toBe('dynamic-1');
        expect(second.declaration.description).toBe('dynamic-2');
    });

    test('同名重复注册为覆盖（幂等，重试初始化安全）', () => {
        registerToolDeclarationFactory('read_file', () => ({
            declaration: { name: 'read_file', description: 'first', parameters: { type: 'object', properties: {} } },
            handler: async () => ({ success: true })
        } as Tool));
        registerToolDeclarationFactory('read_file', () => ({
            declaration: { name: 'read_file', description: 'second', parameters: { type: 'object', properties: {} } },
            handler: async () => ({ success: true })
        } as Tool));
        expect(getToolDeclarationFactory('read_file')!({}).declaration.description).toBe('second');
    });

    test('clearToolDeclarationFactories 清空全部注册', () => {
        registerToolDeclarationFactory('read_file', () => ({
            declaration: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } },
            handler: async () => ({ success: true })
        } as Tool));
        clearToolDeclarationFactories();
        expect(getToolDeclarationFactory('read_file')).toBeUndefined();
    });
});

describe('ToolDeclarationResolver × 注册表（行为一致性）', () => {
    afterEach(() => {
        clearToolDeclarationFactories();
    });

    test('工厂已注册：resolve 产出动态 read_file 描述与参数', () => {
        registerToolDeclarationFactory('read_file', (args) => ({
            declaration: {
                name: 'read_file',
                description: `dynamic-description(${args.multimodalEnabled}, ${args.channelType}, ${args.toolMode})`,
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' }, files: { type: 'array' } }
                }
            },
            handler: async () => ({ success: true })
        } as Tool));

        const { resolver } = createResolverHarness();
        const declarations = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: true
        })!;
        const readFile = declarations.find(d => d.name === 'read_file')!;
        expect(readFile.description).toBe('dynamic-description(true, openai, function_call)');
        expect((readFile.parameters as any).properties.files).toBeDefined();
    });

    test('工厂未注册：resolve 保持静态声明（回退行为）', () => {
        const { resolver } = createResolverHarness();
        const declarations = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: true
        })!;
        const readFile = declarations.find(d => d.name === 'read_file')!;
        expect(readFile.description).toBe('static read_file description');
        expect((readFile.parameters as any).properties.files).toBeUndefined();
        expect((readFile.parameters as any).properties.path).toBeDefined();
    });
});
