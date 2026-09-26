import type { RuntimeTool } from '@graycode/core';
import { createShowWindowsNotificationTool, createShowWindowsNotificationToolDeclaration } from '../../../backend/tools/notification/showWindowsNotificationRuntime';
import type { WindowsToastAdapter } from '../../../backend/modules/notifications/types';
export class PlatformNotifications {
  private host?: { adapter: WindowsToastAdapter; open: (conversationId?: string) => Promise<void> };
  connect(host: { adapter: WindowsToastAdapter; open: (conversationId?: string) => Promise<void> }) { this.host = host; }
  tool(): RuntimeTool {
    const declaration = createShowWindowsNotificationToolDeclaration();
    return { declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters }, effects: () => ['desktop_control'],
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        if (!this.host) return { success: false, code: 'UNAVAILABLE', error: '当前核心服务没有连接桌面通知宿主。' };
        const host = this.host, conversationId = context.conversationId;
        const tool = createShowWindowsNotificationTool(host.adapter, process.platform, () => host.open(conversationId));
        return tool.handler(args);
      } };
  }
}
