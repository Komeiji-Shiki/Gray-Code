import { getAllWorkspaces } from '../utils';
import { TaskManager } from '../taskManager';
import { readImageFile, saveImage } from './imageUtils';
import type { MediaToolHost } from './host';

/** 扩展入口保留原宿主，独立平台直接提供自己的文件事务和任务端口。 */
export const legacyMediaHost: MediaToolHost = { getAllWorkspaces, readImageFile, saveImage, tasks: TaskManager };
