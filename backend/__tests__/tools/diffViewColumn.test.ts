import * as vscode from 'vscode';
import {
    resolveDiffTargetViewColumn,
    resolveMainChatDiffViewColumn
} from '../../tools/file/diffViewColumn';

describe('diff view column routing', () => {
    afterEach(() => {
        (vscode.window.tabGroups as any).all = [];
    });

    test('主聊天位于编辑器区时返回其列，而不是当前 Monitor 列', () => {
        (vscode.window.tabGroups as any).all = [
            {
                viewColumn: vscode.ViewColumn.One,
                tabs: [{ input: { viewType: 'graycode.subAgentMonitor' } }]
            },
            {
                viewColumn: vscode.ViewColumn.Three,
                tabs: [{ input: { viewType: 'graycode.chatView' } }]
            }
        ];

        expect(resolveMainChatDiffViewColumn()).toBe(vscode.ViewColumn.Three);
        expect(resolveDiffTargetViewColumn()).toBe(vscode.ViewColumn.Three);
    });

    test('主聊天在侧边栏时回退第一编辑器列', () => {
        (vscode.window.tabGroups as any).all = [{
            viewColumn: vscode.ViewColumn.Two,
            tabs: [{ input: { viewType: 'graycode.subAgentMonitor' } }]
        }];

        expect(resolveMainChatDiffViewColumn()).toBeUndefined();
        expect(resolveDiffTargetViewColumn()).toBe(vscode.ViewColumn.One);
    });
});
