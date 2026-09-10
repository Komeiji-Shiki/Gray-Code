import * as vscode from 'vscode';
import { getAllWorkspaces, getWorkspaceRoot, parseWorkspacePath, resolveFileToolPathWithInfo, toRelativePath } from '../shared/workspacePaths';
import { countTextFileLines } from '../shared/fileStats';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../modules/settings/types';
import { ensureOutsideWorkspaceAccessApproved, type OutsideWorkspaceAwareToolName } from '../file/outsideWorkspaceAccess';
import { getDiffManager } from '../../core/services/diffManager';
import { resolveDiffOutcome } from '../file/diff/resolveDiffOutcome';
import type { SearchFileHost } from './fileHost';

/** 原扩展只在此处使用 VS Code，搜索与替换算法由两个宿主共用。 */
export const vscodeFileHost: SearchFileHost = {
  getAllWorkspaces, getWorkspaceRoot, parseWorkspacePath, resolveFileToolPathWithInfo,
  toRelativePath: (file, prefix) => toRelativePath(file as vscode.Uri, prefix),
  joinPath: (root, file) => vscode.Uri.joinPath(root as vscode.Uri, file), file: absolute => vscode.Uri.file(absolute),
  stat: async file => vscode.workspace.fs.stat(file as vscode.Uri),
  readFile: async file => vscode.workspace.fs.readFile(file as vscode.Uri),
  findFiles: async (root, pattern, exclude, limit) => vscode.workspace.findFiles(new vscode.RelativePattern(root as vscode.Uri, pattern), exclude, limit),
  countLines: (file, relative) => countTextFileLines(file as vscode.Uri, relative),
  findExcludePatterns: () => getGlobalSettingsManager()?.getFindFilesConfig().excludePatterns,
  searchConfig: () => getGlobalSettingsManager()?.getSearchInFilesConfig() ?? DEFAULT_SEARCH_IN_FILES_CONFIG,
  checkAccess: (tool, args, context) => ensureOutsideWorkspaceAccessApproved(tool as OutsideWorkspaceAwareToolName, args, context),
  review: async input => {
    const pending = await getDiffManager().createPendingDiff(input.filePath, input.absolutePath, input.originalContent, input.newContent,
      input.blocks, undefined, input.toolId, { conversationId: input.conversationId, checkpointReady: input.checkpointReady, lockHolder: input.lockHolder });
    return resolveDiffOutcome({ pendingDiffId: pending.id, abortSignal: input.abortSignal,
      originalContent: input.originalContent, newContent: input.newContent, filePath: input.filePath, actionLabel: 'Replace' });
  },
};
