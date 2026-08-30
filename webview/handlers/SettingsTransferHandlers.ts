/**
 * 设置导入/导出子域消息处理器（从 SettingsHandlers 拆分）。
 *
 * 消息 key：settings.export / settings.import。
 *
 * 对话框 / 写文件 / 解析导入流程已收敛到 utils/settingsTransfer（发现 7），
 * 此处仅保留 webview handler 的入口适配：把共享流程的结果直接回响应，
 * 并按实际导入成功的配置域广播刷新通知（否则界面要重启插件才可见）。
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import type { HandlerContext, MessageHandler } from '../types';
import { notifyImportedScopesChanged } from '../utils/configChangeNotifier';
import {
    exportSettingsToFile,
    importSettingsFromFile,
    toSettingsTransferSource
} from '../utils/settingsTransfer';

/**
 * 导出设置
 * 从设置页面触发，弹出保存对话框，将设置导出为 JSON 文件
 */
export const exportSettings: MessageHandler = async (_data, requestId, ctx) => {
    try {
        const outcome = await exportSettingsToFile(toSettingsTransferSource(ctx));
        if (outcome.cancelled) {
            ctx.sendResponse(requestId, { success: false, cancelled: true });
            return;
        }
        ctx.sendResponse(requestId, { success: true, filePath: outcome.filePath });
    } catch (error: any) {
        ctx.sendError(requestId, 'EXPORT_ERROR', error.message || 'Failed to export settings');
    }
};

/**
 * 导入设置
 * 从设置页面触发，弹出打开对话框，从 JSON 文件导入设置
 */
export const importSettings: MessageHandler = async (data, requestId, ctx) => {
    try {
        const { overwrite } = data || {}; // 前端传入的覆盖选项
        const outcome = await importSettingsFromFile(toSettingsTransferSource(ctx), { overwrite });
        if (outcome.cancelled) {
            ctx.sendResponse(requestId, { success: false, cancelled: true });
            return;
        }
        ctx.sendResponse(requestId, {
            success: outcome.result.success,
            imported: outcome.result.imported,
            errors: outcome.result.errors
        });
        // 导入写入的是后端数据，webview 侧列表/表单是挂载时拉取的快照：
        // 不广播就只能等重启插件（重置模块缓存）才看得到刚导入的渠道/MCP/设置值。
        notifyImportedScopesChanged(ctx, outcome.result.imported);
    } catch (error: any) {
        ctx.sendError(requestId, 'IMPORT_ERROR', error.message || 'Failed to import settings');
    }
};

/**
 * 注册设置导入/导出处理器
 */
export function registerSettingsTransferHandlers(registry: Map<string, MessageHandler>): void {
  // 设置导出/导入
  registry.set(MESSAGE_NAMES['settings.export'], exportSettings);
  registry.set(MESSAGE_NAMES['settings.import'], importSettings);
}
