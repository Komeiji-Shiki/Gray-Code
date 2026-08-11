/**
 * create_design 工具
 *
 * 目标：把设计文档写入 .graycode/design/**.md（或 multi-root: workspace/.graycode/design/**.md）。
 * 注意：这是“生成设计”工具，不负责创建 plan 或执行代码。
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { slugify } from '../shared/slugify';
import { DESIGN_PATH_SCOPE_LABEL, buildPathRejectedError } from '../shared/pathPolicy';
import { ensureParentDir, isDesignModePathAllowedWithMultiRoot } from './pathUtils';
import { syncProgressFromDesignArtifact } from '../progress/autoSync';

export interface CreateDesignArgs {
  title?: string;
  overview?: string;
  design: string;
  path?: string;
}

export function createCreateDesignToolDeclaration(): ToolDeclaration {
  return {
    name: 'create_design',
    description:
      'Create a design document (markdown) and write it under .graycode/design/**.md. This tool only creates the design; it does NOT create a plan or implement code.',
    category: 'design',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional design title (used for default filename)' },
        overview: { type: 'string', description: 'Optional one-line overview' },
        design: { type: 'string', description: 'Design content in markdown' },
        path: {
          type: 'string',
          description:
            'Optional output path. Must be under .graycode/design/**.md (or multi-root: workspace/.graycode/design/**.md).'
        }
      },
      required: ['design']
    }
  };
}

export function createCreateDesignTool(): Tool {
  return {
    declaration: createCreateDesignToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> => {
      const args = rawArgs as unknown as CreateDesignArgs;
      const design = typeof args.design === 'string' ? args.design : '';
      if (!design.trim()) {
        return { success: false, error: 'design is required and must be a non-empty string' };
      }

      const title = typeof args.title === 'string' ? args.title : '';
      const defaultPath = `.graycode/design/${slugify(title || 'design', `design-${Date.now()}`)}.md`;
      const outPath = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : defaultPath;

      if (!isDesignModePathAllowedWithMultiRoot(outPath)) {
        return { success: false, error: buildPathRejectedError('design', DESIGN_PATH_SCOPE_LABEL, outPath) };
      }

      const { uri, error } = resolveUriWithInfo(outPath, context?.activeWorkspaceUri);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      // 写入前探测目标文件存在性：create_design 不应静默覆盖既有设计文档
      try {
        await vscode.workspace.fs.readFile(uri);
        return {
          success: false,
          error: `Design document already exists at ${outPath}. Use update_design to revise it instead of overwriting.`
        };
      } catch (e: any) {
        // 目标不存在（或不可读）：继续创建；写入失败由下方 try/catch 返回错误
      }

      try {
        await ensureParentDir(uri.fsPath);

        const content = normalizeLineEndingsToLF(design);
        const bytes = new TextEncoder().encode(content);
        await vscode.workspace.fs.writeFile(uri, bytes);
        const progressWarnings = await syncProgressFromDesignArtifact({
          designPath: outPath,
          title: title || undefined
        });

        return {
          success: true,
          requiresUserConfirmation: true,
          data: {
            path: outPath,
            content,
            ...(progressWarnings.length > 0 ? { warnings: progressWarnings } : {})
          }
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerCreateDesign(): Tool {
  return createCreateDesignTool();
}
