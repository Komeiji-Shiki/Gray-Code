import * as vscode from 'vscode';

export const MAIN_CHAT_VIEW_TYPE = 'graycode.chatView';

/**
 * 返回主聊天 Webview 所在的编辑器列。
 *
 * 主聊天通常位于侧边栏，此时 tabGroups 中没有对应标签并返回 undefined；调用方应回退到
 * ViewColumn.One。SubAgent Monitor 是独立 WebviewPanel，不能使用 activeTabGroup 推断，
 * 否则用户点击 Monitor 后原生 diff 会被打开到 Monitor 所在列。
 */
export function resolveMainChatDiffViewColumn(): vscode.ViewColumn | undefined {
    for (const group of vscode.window.tabGroups.all) {
        const containsMainChat = group.tabs.some(tab => {
            const input = tab.input as { viewType?: unknown } | undefined;
            return !!input && typeof input === 'object' && input.viewType === MAIN_CHAT_VIEW_TYPE;
        });
        if (containsMainChat) {
            return group.viewColumn;
        }
    }
    return undefined;
}

export function resolveDiffTargetViewColumn(): vscode.ViewColumn {
    return resolveMainChatDiffViewColumn() ?? vscode.ViewColumn.One;
}
