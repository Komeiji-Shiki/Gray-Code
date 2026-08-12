/**
 * 固定文件（pinned files）管理消息处理器
 *
 * 拆分自 FileHandlers.ts 域 B：会话级（conversationId）与全局 pinned files
 * 的读取、增删、启停、校验与存在性检查。
 */

import { MESSAGE_NAMES } from '../../../shared/protocol';
import { t } from '../../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../../types';
import { validateFileInWorkspace, checkFileExists } from '../../utils/WorkspaceUtils';
import type { PinnedFileItem } from '../../../backend/modules/settings';

// ========== 固定文件管理 ==========

const CONVERSATION_PINNED_FILES_KEY = 'inputPinnedFiles';

function normalizePinnedFiles(raw: unknown): PinnedFileItem[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is PinnedFileItem => {
      return !!item
        && typeof (item as any).id === 'string'
        && typeof (item as any).path === 'string'
        && typeof (item as any).workspaceUri === 'string'
        && typeof (item as any).enabled === 'boolean'
        && typeof (item as any).addedAt === 'number';
    })
    .map(item => ({ ...item }));
}

function filterPinnedFilesByWorkspace(files: PinnedFileItem[], workspaceUri: string | null): PinnedFileItem[] {
  if (!workspaceUri) return files;
  return files.filter(f => f.workspaceUri === workspaceUri);
}

async function getConversationPinnedFilesRaw(
  ctx: HandlerContext,
  conversationId: string
): Promise<PinnedFileItem[] | null> {
  try {
    const raw = await ctx.conversationManager.getCustomMetadata(conversationId, CONVERSATION_PINNED_FILES_KEY);
    if (raw === undefined) return null;
    return normalizePinnedFiles(raw);
  } catch {
    return null;
  }
}

async function saveConversationPinnedFiles(
  ctx: HandlerContext,
  conversationId: string,
  files: PinnedFileItem[]
): Promise<void> {
  await ctx.conversationManager.setCustomMetadata(conversationId, CONVERSATION_PINNED_FILES_KEY, files);
}

export const getPinnedFilesConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const workspaceUri = ctx.getCurrentWorkspaceUri();
    if (!workspaceUri) {
      // 无工作区：sectionTitle 沿用设置侧配置（单一来源，不再硬编码英文魔值），
      // 响应结构与正常分支一致（直接展开 config，仅 files 置空）。
      const config = ctx.settingsManager.getPinnedFilesConfig();
      ctx.sendResponse(requestId, { ...config, files: [] });
      return;
    }

    const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
    
    const allConfig = ctx.settingsManager.getPinnedFilesConfig();
    const conversationFiles = conversationId ? await getConversationPinnedFilesRaw(ctx, conversationId) : null;
    const sourceFiles = conversationFiles ?? allConfig.files;
    const workspaceFiles = filterPinnedFilesByWorkspace(sourceFiles, workspaceUri);
    
    ctx.sendResponse(requestId, {
      ...allConfig,
      files: workspaceFiles
    });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_PINNED_FILES_CONFIG_ERROR', error.message || t('webview.errors.getPinnedFilesConfigFailed'));
  }
};

export const checkPinnedFilesExistence: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { files } = data;
    const workspaceUri = ctx.getCurrentWorkspaceUri();
    
    if (!workspaceUri || !files) {
      ctx.sendResponse(requestId, { files: [] });
      return;
    }
    
    const filesWithExistence = await Promise.all(
      files.map(async (file: { id: string; path: string }) => {
        const exists = await checkFileExists(file.path, workspaceUri);
        return { id: file.id, exists };
      })
    );
    
    ctx.sendResponse(requestId, { files: filesWithExistence });
  } catch (error: any) {
    ctx.sendError(requestId, 'CHECK_PINNED_FILES_EXISTENCE_ERROR', error.message || t('webview.errors.checkPinnedFilesExistenceFailed'));
  }
};

/**
 * 批量检查工作区文件是否存在
 * 接收一组路径，返回每个路径的存在性结果
 */
export const checkWorkspaceFilesExist: MessageHandler = async (data, requestId, ctx) => {
  try {
    const paths: string[] = data?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      ctx.sendResponse(requestId, { results: {} });
      return;
    }

    const workspaceUri = ctx.getCurrentWorkspaceUri();
    if (!workspaceUri) {
      // 无工作区，全部视为不存在
      const results: Record<string, boolean> = {};
      for (const p of paths) results[p] = false;
      ctx.sendResponse(requestId, { results });
      return;
    }

    const results: Record<string, boolean> = {};
    await Promise.all(paths.map(async (p: string) => {
      results[p] = await checkFileExists(p, workspaceUri);
    }));

    ctx.sendResponse(requestId, { results });
  } catch (error: any) {
    ctx.sendError(requestId, 'CHECK_WORKSPACE_FILES_EXIST_ERROR', error.message || 'Failed to check files existence');
  }
};

export const addPinnedFile: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: filePath, workspaceUri: providedWorkspaceUri, conversationId } = data;
    const normalizedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';
    const currentWorkspaceUri = ctx.getCurrentWorkspaceUri();
    
    if (!currentWorkspaceUri) {
      ctx.sendError(requestId, 'ADD_PINNED_FILE_ERROR', t('webview.errors.noWorkspaceOpen'));
      return;
    }
    
    const targetWorkspaceUri = providedWorkspaceUri || currentWorkspaceUri;
    const validation = await validateFileInWorkspace(filePath, targetWorkspaceUri);
    
    if (!validation.valid) {
      ctx.sendResponse(requestId, {
        success: false,
        error: validation.error,
        errorCode: validation.errorCode
      });
      return;
    }
    
    const actualWorkspaceUri = validation.workspaceUri || targetWorkspaceUri;

    if (normalizedConversationId) {
      const files = (await getConversationPinnedFilesRaw(ctx, normalizedConversationId))
        ?? [...ctx.settingsManager.getPinnedFiles()];

      if (files.some(f => f.path === validation.relativePath && f.workspaceUri === actualWorkspaceUri)) {
        ctx.sendResponse(requestId, {
          success: false,
          error: 'File already pinned',
          errorCode: 'FILE_ALREADY_PINNED'
        });
        return;
      }

      const file: PinnedFileItem = {
        id: `pinned_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        path: validation.relativePath!,
        workspaceUri: actualWorkspaceUri,
        enabled: true,
        addedAt: Date.now()
      };
      await saveConversationPinnedFiles(ctx, normalizedConversationId, [...files, file]);
      ctx.sendResponse(requestId, { success: true, file });
      return;
    }

    const file = await ctx.settingsManager.addPinnedFile(validation.relativePath!, actualWorkspaceUri);
    ctx.sendResponse(requestId, { success: true, file });
  } catch (error: any) {
    ctx.sendError(requestId, 'ADD_PINNED_FILE_ERROR', error.message || t('webview.errors.addPinnedFileFailed'));
  }
};

export const removePinnedFile: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { id, conversationId } = data;
    const normalizedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';

    if (normalizedConversationId) {
      const files = (await getConversationPinnedFilesRaw(ctx, normalizedConversationId))
        ?? [...ctx.settingsManager.getPinnedFiles()];
      const updated = files.filter(f => f.id !== id);
      await saveConversationPinnedFiles(ctx, normalizedConversationId, updated);
      ctx.sendResponse(requestId, { success: true });
      return;
    }

    await ctx.settingsManager.removePinnedFile(id);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'REMOVE_PINNED_FILE_ERROR', error.message || t('webview.errors.removePinnedFileFailed'));
  }
};

export const setPinnedFileEnabled: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { id, enabled, conversationId } = data;
    const normalizedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';

    if (normalizedConversationId) {
      const files = (await getConversationPinnedFilesRaw(ctx, normalizedConversationId))
        ?? [...ctx.settingsManager.getPinnedFiles()];

      const updated = files.map(f => (
        f.id === id
          ? { ...f, enabled: !!enabled }
          : f
      ));

      // 若目标 id 不存在，保持兼容：不抛错，直接返回成功
      await saveConversationPinnedFiles(ctx, normalizedConversationId, updated);
      ctx.sendResponse(requestId, { success: true });
      return;
    }

    await ctx.settingsManager.setPinnedFileEnabled(id, enabled);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SET_PINNED_FILE_ENABLED_ERROR', error.message || t('webview.errors.setPinnedFileEnabledFailed'));
  }
};

export const validatePinnedFile: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: filePath, workspaceUri: providedWorkspaceUri } = data;
    const currentWorkspaceUri = ctx.getCurrentWorkspaceUri();
    
    if (!currentWorkspaceUri) {
      ctx.sendResponse(requestId, {
        valid: false,
        error: t('webview.errors.noWorkspaceOpen'),
        errorCode: 'NO_WORKSPACE'
      });
      return;
    }
    
    const result = await validateFileInWorkspace(filePath, providedWorkspaceUri || currentWorkspaceUri);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendResponse(requestId, { valid: false, error: error.message, errorCode: 'UNKNOWN' });
  }
};

/**
 * 注册固定文件管理处理器
 */
export function registerPinnedFileHandlers(registry: Map<string, MessageHandler>): void {
  // 固定文件管理
  registry.set(MESSAGE_NAMES.getPinnedFilesConfig, getPinnedFilesConfig);
  registry.set(MESSAGE_NAMES.checkPinnedFilesExistence, checkPinnedFilesExistence);
  registry.set(MESSAGE_NAMES.checkWorkspaceFilesExist, checkWorkspaceFilesExist);
  registry.set(MESSAGE_NAMES.addPinnedFile, addPinnedFile);
  registry.set(MESSAGE_NAMES.removePinnedFile, removePinnedFile);
  registry.set(MESSAGE_NAMES.setPinnedFileEnabled, setPinnedFileEnabled);
  registry.set(MESSAGE_NAMES.validatePinnedFile, validatePinnedFile);
}
