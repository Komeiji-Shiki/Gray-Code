import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { Tool, ToolOptions } from '../../../../backend/tools/types';
import type { SettingsManager } from '../../../../backend/modules/settings/SettingsManager';
import type { MediaToolHost } from '../../../../backend/tools/media/host';
import { createGenerateImageRuntime } from '../../../../backend/tools/media/generate_imageRuntime';
import { createRemoveBackgroundRuntime } from '../../../../backend/tools/media/remove_backgroundRuntime';
import { createCropImageRuntime } from '../../../../backend/tools/media/crop_imageRuntime';
import { createResizeImageRuntime } from '../../../../backend/tools/media/resize_imageRuntime';
import { createRotateImageRuntime } from '../../../../backend/tools/media/rotate_imageRuntime';
import { DEFAULT_GENERATE_IMAGE_CONFIG, DEFAULT_REMOVE_BACKGROUND_CONFIG, DEFAULT_CROP_IMAGE_CONFIG,
  DEFAULT_RESIZE_IMAGE_CONFIG, DEFAULT_ROTATE_IMAGE_CONFIG } from '../../../../backend/modules/settings/types/toolsTypes';
import { ToolTaskPort } from '../tasks/toolPort';
import { FileReadAccess } from '../workspace/readAccess';
import { prepareExternalWrite } from '../workspace/writeAccess';
import type { PlatformApplication } from '../application';

type MediaName = 'generate_image' | 'remove_background' | 'crop_image' | 'resize_image' | 'rotate_image';
interface ActiveMedia { id: string; name: MediaName; context: ToolContext; tasks: ToolTaskPort; startTime: number }

/** 原图片工具共享算法；独立任务仅注入本轮身份、配置、文件事务和取消端口。 */
export class PlatformMedia {
  private readonly active = new Map<string, ActiveMedia>();
  constructor(private readonly app: PlatformApplication) {}
  list() { return [...this.active.values()].map(item => ({ id: item.id, type: item.name === 'generate_image' ? 'image_generation' : item.name,
    startTime: item.startTime, metadata: { conversationId: item.context.conversationId, toolCallId: item.context.toolCallId, runId: item.context.runId } })); }
  has(id: string) { return [...this.active.values()].some(item => item.id === id || item.context.toolCallId === id); }
  cancel(actorId: string, id: string, conversationId?: string) {
    this.app.requireOwner(actorId);
    const matches = [...this.active.values()].filter(item => (item.id === id || item.context.toolCallId === id) && (!conversationId || item.context.conversationId === conversationId));
    if (matches.length !== 1) return { success: false, error: matches.length ? '存在多个同名工具调用，请从对应任务取消。' : '图片任务已经结束或不存在。' };
    return matches[0].tasks.cancelTask(matches[0].id);
  }
  tools(settings?: SettingsManager, toolOptions?: ToolOptions): RuntimeTool[] {
    const image = structuredClone(settings?.getGenerateImageConfig() ?? DEFAULT_GENERATE_IMAGE_CONFIG);
    const proxyUrl = settings?.getEffectiveProxyUrl();
    const configs = {
      generate_image: { ...image, proxyUrl },
      remove_background: { ...image, ...(settings?.getRemoveBackgroundConfig() ?? DEFAULT_REMOVE_BACKGROUND_CONFIG), proxyUrl },
      crop_image: structuredClone(settings?.getCropImageConfig() ?? DEFAULT_CROP_IMAGE_CONFIG),
      resize_image: structuredClone(settings?.getResizeImageConfig() ?? DEFAULT_RESIZE_IMAGE_CONFIG),
      rotate_image: structuredClone(settings?.getRotateImageConfig() ?? DEFAULT_ROTATE_IMAGE_CONFIG),
    };
    const capturedOptions = structuredClone(toolOptions);
    const factories: Record<MediaName, (host: MediaToolHost) => Tool> = {
      generate_image: host => createGenerateImageRuntime(host).createGenerateImageTool(image.maxBatchTasks, image.maxImagesPerTask,
        { enableAspectRatio: image.enableAspectRatio, forcedAspectRatio: image.defaultAspectRatio,
          enableImageSize: image.enableImageSize, forcedImageSize: image.defaultImageSize }),
      remove_background: host => createRemoveBackgroundRuntime(host).createRemoveBackgroundTool(image.maxBatchTasks),
      crop_image: host => createCropImageRuntime(host).createCropImageTool(10, capturedOptions?.cropImage),
      resize_image: host => createResizeImageRuntime(host).createResizeImageTool(10),
      rotate_image: host => createRotateImageRuntime(host).createRotateImageTool(10),
    };
    const catalogHost: MediaToolHost = { tasks: new ToolTaskPort(() => {}), getAllWorkspaces: () => [],
      readImageFile: async () => { throw new Error('工具声明不读取图片。'); }, saveImage: async () => { throw new Error('工具声明不写入文件。'); } };
    return (Object.keys(factories) as MediaName[]).map(name => {
      const factory = factories[name]; const declaration = factory(catalogHost).declaration;
      return { declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
        effects: () => name === 'generate_image' || name === 'remove_background' ? ['workspace_read', 'workspace_write', 'external_send'] : ['workspace_read', 'workspace_write'],
        execute: (args, context) => this.execute(name, factory, configs[name], capturedOptions, args, context) } as RuntimeTool;
    });
  }
  private async execute(name: MediaName, factory: (host: MediaToolHost) => Tool, config: object, toolOptions: ToolOptions | undefined,
    args: Record<string, unknown>, context: ToolContext) {
    if (!context.workspace || !context.conversationId) throw new Error('请先选择保存图片的工作区。');
    context.signal.throwIfAborted();
    const id = `media-${randomUUID()}`;
    const tasks = new ToolTaskPort(event => {
      const data = { ...event.data, conversationId: context.conversationId, toolCallId: context.toolCallId, runId: context.runId };
      this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'taskEvent', data: { ...event, data } } });
      if (name === 'generate_image') this.app.publish({ type: 'ui.message', message: { type: 'command', command: 'imageGenOutput',
        data: { toolId: id, type: event.type, data, error: event.error } } });
      context.progress({ mediaTaskId: id, ...event, data });
    });
    const access = new FileReadAccess(this.app, context);
    const host: MediaToolHost = {
      tasks, getAllWorkspaces: () => [{ name: context.workspace!.name }],
      readImageFile: async requested => {
        const file = await access.resolve(requested); context.signal.throwIfAborted();
        const data = await readFile(file); const ext = path.extname(file).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
        return { data, ext, mimeType };
      },
      saveImage: async (bytes, requested) => {
        // 并发批量任务各自持有写入授权，不能被另一个输出路径覆盖。
        const writeContext = { ...context };
        await prepareExternalWrite(this.app, writeContext, 'write_file', { path: requested });
        const expectedHash = await this.app.files.transaction(context.workspace!, async transaction => (await transaction.capture(requested)).hash,
          { writeGrants: writeContext.fileWriteGrants });
        await this.app.changes.write(writeContext, [{ path: requested, bytes, expectedHash }]);
      },
    };
    this.active.set(id, { id, name, context, tasks, startTime: Date.now() });
    try {
      const { multimodal, ...result } = await factory(host).handler(args, { toolId: id, conversationId: context.conversationId,
        activeWorkspaceUri: context.workspace.directory, abortSignal: context.signal, config: { ...config }, toolOptions });
      return { ...result, attachments: multimodal };
    } finally { this.active.delete(id); }
  }
}
