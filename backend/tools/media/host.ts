import type { ToolContext } from '../types';
import type { TaskManager } from '../taskManager';

/** 媒体算法需要的最小宿主能力，不包含窗口或进程级设置。 */
export interface MediaToolHost {
    getAllWorkspaces(): Array<{ name: string }>;
    readImageFile(path: string, context?: ToolContext, displayName?: string): Promise<{ data: Buffer; mimeType: string; ext: string } | null>;
    saveImage(buffer: Buffer, path: string, context?: ToolContext, displayName?: string): Promise<void>;
    tasks: Pick<typeof TaskManager, 'getTasksByType' | 'generateTaskId' | 'cancelTask' | 'registerTask' | 'unregisterTask' | 'onTaskEventByType'>;
}
