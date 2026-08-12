/**
 * GrayCode VSCode Extension 入口
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { setDetectedLanguage, setLanguage as setBackendLanguage } from './backend/i18n';
import { Logger } from './backend/core/logger';
import { initializeProductMetadata } from './backend/core/productMetadata';
import { getDiffManager } from './backend/core/services/diffManager';
import { registerSettingsCommands } from './webview/commands/settingsCommands';
import { registerDiffUi } from './webview/commands/diffUi';

// 保存 ChatViewProvider 实例（openChat/newChat 等基础命令与命令注册时读取）
let chatViewProvider: ChatViewProvider | undefined;

const log = Logger.get('extension');

export function activate(context: vscode.ExtensionContext) {
    // 初始化日志系统：创建 OutputChannel 让日志同时输出到 VS Code 输出面板
    const outputChannel = vscode.window.createOutputChannel('GrayCode');
    context.subscriptions.push(outputChannel);
    Logger.setOutputChannel((line) => outputChannel.appendLine(line));

    // 关键初始化分阶段保护：任何一步失败只记日志，不阻断后续基础命令注册；
    // 已注册项均挂在 context.subscriptions 上，停用时由 VS Code 统一 dispose。
    try {
        // 以当前扩展自身的 packageJSON 初始化产品元数据（运行时版本唯一来源，供 MCP clientInfo 等使用）
        initializeProductMetadata(context);

        log.info('GrayCode extension is now active!');

        // Allow i18n to follow VS Code display language until settings load.
        setDetectedLanguage(vscode.env.language);
        setBackendLanguage('auto');

        // 注册聊天视图提供者
        chatViewProvider = new ChatViewProvider(context);

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                'graycode.chatView',
                chatViewProvider,
                {
                    // 保持 webview 状态，切换视图时不销毁
                    webviewOptions: {
                        retainContextWhenHidden: true
                    }
                }
            )
        );
    } catch (error) {
        console.error('[GrayCode] activate: core initialization failed:', error);
    }

    // 注册基础命令与设置命令（分阶段保护：任一命令注册失败只记日志，不阻断后续 diff 提供者注册）
    try {
        // 打开聊天面板 / 新建对话 / 显示历史 / 显示用量统计 / 显示设置
        context.subscriptions.push(
            vscode.commands.registerCommand('graycode.openChat', () => {
                vscode.commands.executeCommand('graycode.chatView.focus');
            }),
            vscode.commands.registerCommand('graycode.newChat', () => {
                chatViewProvider?.sendCommand('newChat');
            }),
            vscode.commands.registerCommand('graycode.showHistory', () => {
                chatViewProvider?.sendCommand('showHistory');
            }),
            vscode.commands.registerCommand('graycode.showUsage', () => {
                chatViewProvider?.sendCommand('showUsage');
            }),
            vscode.commands.registerCommand('graycode.showSettings', () => {
                chatViewProvider?.sendCommand('showSettings');
            })
        );

        // 设置导入/导出/旧对话历史迁移命令（外移 webview/commands/settingsCommands.ts）
        context.subscriptions.push(...registerSettingsCommands(context, chatViewProvider));
    } catch (error) {
        console.error('[GrayCode] activate: command registration failed:', error);
    }

    // ====== Toast 点击标记轮询（Windows） ======
    // toast-linger.exe（Win11 24H2+/25H2 唯一可靠的 toast 点击激活路径：驻留进程内
    // Activated 事件）在用户点击通知时写 %TEMP%\graycode-toast-clicked.flag 并聚焦
    // VSCode 窗口；这里轮询该标记，命中后打开聊天面板（graycode.openChat）并删除标记。
    try {
        const toastClickMarker = path.join(os.tmpdir(), 'graycode-toast-clicked.flag');
        const markerTimer = setInterval(() => {
            try {
                if (fs.existsSync(toastClickMarker)) {
                    try {
                        fs.unlinkSync(toastClickMarker);
                    } catch {
                        // 删除失败不阻塞 openChat（下次轮询会再次命中）
                    }
                    vscode.commands.executeCommand('graycode.openChat');
                }
            } catch (error) {
                console.error('[GrayCode] toast click marker polling failed:', error);
            }
        }, 1000);
        context.subscriptions.push({ dispose: () => clearInterval(markerTimer) });
    } catch (error) {
        console.error('[GrayCode] activate: toast click marker watcher failed:', error);
    }

    // ====== Diff / Selection 提供者与命令注册（分阶段保护：失败仅记日志并继续） ======
    // 释放顺序（与旧 deactivate 手工配对一致，保持不变）：
    //   Logger 清理 → 摘除 DiffManager 状态监听 → 注销 CodeLens/Inline Hover → 释放 Provider 实例
    //   → ChatViewProvider 资源 → DiffManager 单例最后释放。
    // VS Code 在 deactivate 后按 LIFO 释放 context.subscriptions，因此这里按释放顺序的逆序 push：
    try {
        // DiffManager 单例最后释放（最先 push）
        context.subscriptions.push({ dispose: () => getDiffManager().dispose() });
        // ChatViewProvider 资源其次（次先 push）
        context.subscriptions.push({ dispose: () => chatViewProvider?.dispose() });
        // registerDiffUi 返回的顺序敏感释放项（状态监听摘除 → CodeLens → Inline Hover → Provider 实例），
        // 逆序 push 后由 LIFO 还原为数组顺序释放；其余顺序不敏感项已由 registerDiffUi 内部挂载。
        const diffUiTeardown = registerDiffUi(context, chatViewProvider);
        for (const disposable of [...diffUiTeardown].reverse()) {
            context.subscriptions.push(disposable);
        }
    } catch (error) {
        console.error('[GrayCode] activate: diff provider registration failed:', error);
    }

    log.info('GrayCode extension activated successfully!');
}

export function deactivate() {
    log.info('GrayCode extension deactivating...');

    // 清空 Logger 的 OutputChannel writer：channel 已随 context.subscriptions 销毁，停用后不再写入。
    // 其余资源（diff 状态监听/CodeLens/Inline/ChatViewProvider/DiffManager）已按释放顺序的逆序
    // 挂到 context.subscriptions，由 VS Code 在 deactivate 后按 LIFO 释放，无需手工配对。
    Logger.setOutputChannel(undefined);

    log.info('GrayCode extension deactivated');
}
