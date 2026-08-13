/**
 * update_design 工具
 *
 * 目标：正式回写既有 design 文档。
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { parseArgs } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { DESIGN_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/pathPolicy';
import { ensureParentDir, isDesignModePathAllowedWithMultiRoot } from './pathUtils';
import { syncProgressFromDesignArtifact } from '../progress/autoSync';

export interface UpdateDesignArgs {
  path: string;
  design: string;
  title?: string;
  overview?: string;
  changeSummary?: string;
}

export function createUpdateDesignToolDeclaration(): ToolDeclaration {
  return {
    name: 'update_design',
    description:
      'Update an existing design document (markdown) under .graycode/design/**.md. Use this when the user wants to revise the current design instead of creating a new one.',
    category: 'design',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Target existing design document path under .graycode/design/**.md.'
        },
        title: { type: 'string', description: 'Optional updated design title.' },
        overview: { type: 'string', description: 'Optional updated one-line overview.' },
        design: { type: 'string', description: 'Updated design content in markdown.' },
        changeSummary: {
          type: 'string',
          description: 'Optional short summary of what changed in this design revision.'
        }
      },
      required: ['path', 'design']
    }
  };
}

export function createUpdateDesignTool(): Tool {
  return {
    declaration: createUpdateDesignToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = parseArgs<UpdateDesignArgs>(rawArgs);
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      const design = typeof args.design === 'string' ? args.design : '';
      const changeSummary = typeof args.changeSummary === 'string' ? args.changeSummary.trim() : '';

      if (!targetPath) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }

      if (!design.trim()) {
        return { success: false, error: 'design is required and must be a non-empty string' };
      }

      if (!isDesignModePathAllowedWithMultiRoot(targetPath)) {
        return { success: false, error: buildPathRejectedError('design', DESIGN_PATH_SCOPE_LABEL, targetPath) };
      }

      const { uri, error } = resolveUriWithInfo(targetPath);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        await vscode.workspace.fs.readFile(uri);
      } catch (e: any) {
        // 参照 create_progress：区分「文档不存在」与其它读取错误（发现 17）。
        // 只有 ENOENT/FileNotFound 才按不存在处理（保留原始消息，与旧行为一致）；
        // EACCES/IO 等异常给出明确错误。
        const readMessage = String(e?.message || '');
        const readCode = String(e?.code || '');
        const isNotFound = readCode === 'ENOENT' || readCode === 'FileNotFound'
          || /enoent|not exist|file not found|FileNotFound/i.test(readMessage);
        if (isNotFound) {
          return { success: false, error: e?.message || `Design document does not exist: ${targetPath}` };
        }
        return {
          success: false,
          error: `Failed to read existing design document: ${readMessage || targetPath}`
        };
      }

      try {
        await ensureParentDir(uri.fsPath);

        const content = normalizeLineEndingsToLF(design);
        const bytes = new TextEncoder().encode(content);
        await vscode.workspace.fs.writeFile(uri, bytes);
        const progressWarnings = await syncProgressFromDesignArtifact({
          designPath: targetPath,
          title: typeof args.title === 'string' ? args.title : undefined
        });

        return {
          success: true,
          requiresUserConfirmation: true,
          data: {
            path: targetPath,
            content,
            changeSummary: changeSummary || undefined,
            ...(progressWarnings.length > 0 ? { warnings: progressWarnings } : {})
          }
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerUpdateDesign(): Tool {
  return createUpdateDesignTool();
}
