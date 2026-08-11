/**
 * LimCode - 聊天输入框焦点守卫
 *
 * 解决的问题：关闭活动的 diff 标签页时，即使 `tabGroups.close(tab, true)`
 * 传了 preserveFocus，VSCode 仍会在激活相邻编辑器的过程中把键盘焦点从
 * 侧边栏 webview 收回到 workbench——正在聊天输入框打字的用户会失焦，
 * 必须再点一次输入框才能继续输入。
 *
 * 机制：
 * 1. 前端聊天输入框 focus/blur 时通过 `chatInput.focusState` 消息上报状态
 *    （webview/handlers/ChatHandlers.ts 接收并写入这里）；
 * 2. diffManager / CheckpointManager 在关闭 diff 标签前调用
 *    shouldRestoreChatInputFocus() 采样（采样必须在关闭前——关闭动作本身
 *    就是抢焦点的来源）；
 * 3. 关闭后调用 restoreChatInputFocus()：若输入框此前持有焦点，执行
 *    `graycode.chatView.focus` 把 workbench 焦点还给聊天视图，并通过
 *    ChatViewProvider 注入的通知器推送 `chat.restoreInputFocus` 命令，
 *    让前端把 DOM 光标放回输入框；若焦点原本在编辑器/终端等其他位置，
 *    什么都不做（不打扰正在写代码的用户）。
 *
 * 竞态处理：连续关闭多个 diff（如 acceptAll）时，上一次关闭引发的 blur
 * 上报可能先于下一次采样到达，导致误判"输入框没有焦点"。因此"最近
 * RECENT_BLUR_GRACE_MS 内刚刚失焦"也视为需要恢复。
 */

import * as vscode from 'vscode';

/** VSCode 为 package.json 中的 graycode.chatView 视图自动注册的聚焦命令 */
const CHAT_VIEW_FOCUS_COMMAND = 'graycode.chatView.focus';

/** blur 上报竞态宽限期（毫秒） */
const RECENT_BLUR_GRACE_MS = 1500;

let chatInputFocused = false;
let lastBlurAt = 0;
/** 最近一次 restoreChatInputFocus 强制归还焦点的时间：用于消歧「主动 blur」与「恢复动作引发的 blur」 */
let lastForcedRestoreAt = 0;
/** 多窗口/多视图各自注册的焦点归还通知器：dispose 只移除自己的，互不覆盖 */
const focusRestoreNotifiers = new Set<() => void>();

/** 由 webview 消息处理器调用：更新聊天输入框的焦点状态 */
export function setChatInputFocused(focused: boolean): void {
    if (chatInputFocused && !focused) {
        // 只有「距上次强制归还焦点很近」的 blur 才进入宽限期：
        // 用户主动 blur（点编辑器/终端）说明焦点是被用户拿走的，不应在宽限期内被强行拉回；
        // 同时把 lastBlurAt 清零，避免上一轮残留时间戳污染后续判断。
        lastBlurAt = (Date.now() - lastForcedRestoreAt < RECENT_BLUR_GRACE_MS) ? Date.now() : 0;
    }
    chatInputFocused = focused;
}

/**
 * 由 ChatViewProvider 注入：归还 workbench 焦点后，
 * 通知前端把 DOM 光标放回输入框。
 * 返回移除函数；视图销毁时调用它只摘除自己的通知器，不影响其他窗口。
 */
export function addChatFocusRestoreNotifier(notifier: () => void): () => void {
    focusRestoreNotifiers.add(notifier);
    return () => {
        focusRestoreNotifiers.delete(notifier);
    };
}

/**
 * 关闭 diff 标签前调用：采样"关闭后是否需要归还聊天输入框焦点"。
 * 必须在 tabGroups.close 之前采样，关闭后焦点状态已被破坏。
 */
export function shouldRestoreChatInputFocus(): boolean {
    return chatInputFocused || (Date.now() - lastBlurAt < RECENT_BLUR_GRACE_MS);
}

/** 关闭 diff 标签后调用：按采样结果归还焦点 */
export async function restoreChatInputFocus(shouldRestore: boolean): Promise<void> {
    if (!shouldRestore) {
        return;
    }
    try {
        await vscode.commands.executeCommand(CHAT_VIEW_FOCUS_COMMAND);
        for (const notifier of focusRestoreNotifiers) {
            // 单个通知器异常不影响其他通知器与焦点归还主流程
            try {
                notifier();
            } catch (error) {
                console.warn('[chatFocusGuard] focus restore notifier failed', error);
            }
        }
        // 记录强制归还时间：随后的 blur 上报会被视为「恢复动作的副作用」而非用户主动离开
        lastForcedRestoreAt = Date.now();
    } catch {
        // 聊天视图未注册/不可见等场景：静默忽略，不影响 diff 主流程
    }
}
