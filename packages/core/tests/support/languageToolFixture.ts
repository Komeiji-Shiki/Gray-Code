import path from 'node:path';
import fs from 'node:fs/promises';
import type { ToolContext } from '../../src/runtime/tools';
import type { PlatformApplication } from '../../../../apps/server/src/application';
import { languageTools } from '../../../../apps/server/src/development/tools';
import { LanguageServices } from '../../../../apps/server/src/development/languages';

/** 保留平台工具、文件访问和请求超时链路，只替换磁盘句柄与 JSON-RPC 会话。 */
export function createLanguageToolFixture(name: string) {
    const directory = path.resolve('workspace/project');
    const workspace = { id: 'project', name: 'project', directory, deviceId: 'local' };
    const provider = jest.fn();
    const openDocument = jest.fn();
    const app = {
        actor: () => ({ role: 'owner' }),
        workspace: () => workspace,
        settings: { read: () => ({}) },
        product: { runtimeSettings: () => ({ getReadFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }) }) }
    } as unknown as PlatformApplication;
    const languages = new LanguageServices(app);
    Object.assign(app, { languages });
    const tool = languageTools(app).find(item => item.declaration.name === name)!;
    let context: ToolContext;
    let openSpy: jest.SpyInstance;
    let realpathSpy: jest.SpyInstance;
    let definitionSpy: jest.SpyInstance;
    let sessionSpy: jest.SpyInstance;
    return {
        provider,
        openDocument,
        reset() {
            provider.mockReset();
            openDocument.mockReset().mockResolvedValue({});
            context = { actorId: 'owner', runId: name, conversationId: 'language-test', workspace,
                signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() };
            realpathSpy = jest.spyOn(fs, 'realpath').mockImplementation(async value => String(value) as any);
            openSpy = jest.spyOn(fs, 'open').mockImplementation(async value => {
                const document = await openDocument(String(value));
                const text = typeof document.getText === 'function' ? document.getText()
                    : Array.from({ length: document.lineCount ?? 40 }, (_, index) => document.lineAt?.(index).text ?? 'source').join('\n');
                return { stat: async () => ({ size: Buffer.byteLength(text) }), readFile: async () => text, close: async () => {} } as any;
            });
            definitionSpy = jest.spyOn(languages, 'definitions').mockReturnValue([
                { id: 'fixture', name: '测试语言服务', languages: ['typescript'], command: 'fixture', args: [] }
            ]);
            sessionSpy = jest.spyOn(languages as any, 'sessionFor').mockResolvedValue({
                info: { id: 'fixture' }, changes: Promise.resolve(), documents: new Map(),
                capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true },
                connection: { sendRequest: provider, sendNotification: jest.fn(async () => {}) }
            });
        },
        restore() {
            openSpy.mockRestore();
            realpathSpy.mockRestore();
            definitionSpy.mockRestore();
            sessionSpy.mockRestore();
        },
        createTool() {
            return {
                handler: async (args: Record<string, unknown>, options?: { abortSignal?: AbortSignal }): Promise<any> => {
                    try {
                        return await tool.execute(args, { ...context, signal: options?.abortSignal ?? context.signal });
                    } catch (error) {
                        // RuntimeTool 抛出的异常由外层执行器转换为失败回执，沿用原用例的观察方式。
                        return { success: false, error: error instanceof Error ? error.message : String(error) };
                    }
                }
            };
        }
    };
}
