import * as path from 'path';
import * as vscode from 'vscode';
import { createFindReferencesTool } from '../../tools/lsp/find_references';
import { createGotoDefinitionTool } from '../../tools/lsp/goto_definition';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';

const root = path.resolve('workspace/project');
const external = vscode.Uri.file(path.resolve('workspace/private/secret.ts'));
const openDocument = vscode.workspace.openTextDocument as jest.Mock;
let settings: SettingsManager;

beforeEach(async () => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ name: 'project', uri: vscode.Uri.file(root) }];
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockImplementation(uri =>
        uri.fsPath.startsWith(root + path.sep) ? { name: 'project', uri: vscode.Uri.file(root) } : undefined);
    openDocument.mockResolvedValue({ lineCount: 1, lineAt: () => ({ text: 'private fixture content' }) });
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([{
        uri: external, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
    }]);
    settings = new SettingsManager(new MemorySettingsStorage());
    await settings.initialize();
    setGlobalSettingsManager(settings);
});

afterEach(() => { setGlobalSettingsManager(null); });

describe.each([
    ['find_references', createFindReferencesTool],
    ['goto_definition', createGotoDefinitionTool]
] as const)('%s 返回目标的读取策略', (_name, createTool) => {
    test.each([
        ['deny', false, false], ['deny', true, false],
        ['ask', false, false], ['ask', true, true], ['allow', false, true]
    ] as const)('policy=%s，confirmed=%s 时只读取已授权目标', async (policy, approved, allowed) => {
        await settings.updateToolConfig('read_file', { outsideWorkspaceAccess: policy });
        const result = await createTool().handler({ path: 'source.ts', line: 1 }, { approvedByToolConfirmation: approved });
        expect(result.success).toBe(true);
        const openedTarget = openDocument.mock.calls.some(([uri]) => uri.fsPath === external.fsPath);
        expect(openedTarget).toBe(allowed);
        expect(JSON.stringify(result.data).includes('private fixture content')).toBe(allowed);
        // 拒绝正文读取仍保留语言服务给出的位置，供调用方按既有策略另行请求。
        expect(JSON.stringify(result.data)).toContain('secret.ts');
    });
});
