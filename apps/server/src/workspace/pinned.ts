import { inside, workspaceFilePath, workspaceRootFor } from './paths';
import { pinnedFileLocation, pinnedWorkspaceRoot } from './pinnedPaths';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import type { ProductSettingsDraft } from '../settings/product';
import type { PinnedFileItem } from '../../../../backend/modules/settings/types';
import { normalizePinnedFiles } from '../../../../backend/modules/prompt/pinnedFiles';
import { uiFilePath, uiWorkspace } from './uiFiles';

/** 对话固定文件独立保存，全局列表沿用共享设置草稿。 */
export function pinnedFileHandlers(app: PlatformApplication, client: ClientSession, draft: ProductSettingsDraft, selected?: WorkspaceDefinition) {
  const settings = draft.settings; const conversations = app.productUi.conversations;
  const workspace = (data: Record<string, any>) => uiWorkspace(app, client, selected, data);
  async function validate(data: Record<string, any>) {
    const target = await workspace(data);
    const provided = data.workspaceUri ? pinnedWorkspaceRoot(target, String(data.workspaceUri)) : undefined;
    if (data.workspaceUri && !provided) throw new Error('固定文件必须属于当前工作区中的目录。');
    const file = uiFilePath(data.path);
    const absolute = await app.files.resolve(target, provided ? path.resolve(provided.directory, file) : file);
    const root = provided ?? workspaceRootFor(target, absolute)!;
    if (!inside(root.directory, absolute)) throw new Error('固定文件不属于所选目录。');
    if (!(await stat(absolute)).isFile()) throw new Error('请选择普通文件。');
    return { valid: true, relativePath: path.relative(root.directory, absolute).replaceAll('\\', '/'), workspaceUri: pathToFileURL(root.directory).toString(), displayPath: workspaceFilePath(target, absolute) };
  }

  async function files(data: Record<string, any>): Promise<PinnedFileItem[]> {
    if (data.conversationId) {
      await app.conversation(client.actorId, data.conversationId);
      const value = await conversations.getCustomMetadata(data.conversationId, 'inputPinnedFiles');
      if (value !== undefined) return normalizePinnedFiles(value);
    }
    return structuredClone(settings.getPinnedFiles());
  }
  async function change(data: Record<string, any>, update: (items: PinnedFileItem[]) => PinnedFileItem[]) {
    if (data.conversationId) {
      await app.conversation(client.actorId, data.conversationId);
      return conversations.runExclusive(data.conversationId, async () => {
        await conversations.setCustomMetadata(data.conversationId, 'inputPinnedFiles', update(await files(data)));
      });
    }
    await settings.updatePinnedFilesConfig({ files: update(await files(data)) });
  }
  return {
    getPinnedFilesConfig: async (data: Record<string, any>) => {
      const conversation = data.conversationId ? await app.conversation(client.actorId, data.conversationId) : null;
      const workspaceId = conversation ? conversation.workspaceId : selected?.id;
      if (typeof workspaceId !== 'string') return { files: [] };
      const target = app.workspace(client.actorId, workspaceId, ['workspace_read']);
      return { files: (await files(data)).flatMap(file => {
        const location = pinnedFileLocation(target, file);
        return location ? [{ ...file, path: location.path }] : [];
      }) };
    },
    validatePinnedFile: async (data: Record<string, any>) => {
      try { return await validate(data); } catch (error) { return { valid: false, error: String(error) }; }
    },
    checkPinnedFilesExistence: async (data: Record<string, any>) => {
      const results: { id: string; exists: boolean }[] = [];
      for (const item of Array.isArray(data.files) ? data.files : []) {
        try { await validate({ ...data, path: item.path }); results.push({ id: item.id, exists: true }); }
        catch { results.push({ id: item.id, exists: false }); }
      }
      return { files: results };
    },
    addPinnedFile: async (data: Record<string, any>) => {
      const value = await validate(data);
      const file: PinnedFileItem = { id: `pinned_${randomUUID()}`, path: value.relativePath, workspaceUri: value.workspaceUri, enabled: true, addedAt: Date.now() };
      await change(data, items => {
        if (items.some(item => item.path === file.path && item.workspaceUri === file.workspaceUri)) throw new Error('文件已经固定。');
        return [...items, file];
      }); return { success: true, file: { ...file, path: value.displayPath } };
    },
    removePinnedFile: async (data: Record<string, any>) => { await change(data, items => items.filter(item => item.id !== data.id)); return { success: true }; },
    setPinnedFileEnabled: async (data: Record<string, any>) => {
      if (typeof data.enabled !== 'boolean') throw new Error('请明确启用或禁用固定文件。');
      await change(data, items => items.map(item => item.id === data.id ? { ...item, enabled: data.enabled } : item)); return { success: true };
    },
  };
}
