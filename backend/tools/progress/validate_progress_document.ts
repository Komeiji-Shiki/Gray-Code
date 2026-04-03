/**
 * validate_progress_document 工具
 *
 * 目标：只读校验 progress 文档的格式与基础不变量。
 */

import * as vscode from 'vscode';
import type { Tool, ToolDeclaration, ToolResult } from '../types';
import { normalizeLineEndingsToLF, resolveUriWithInfo } from '../utils';
import { isProgressModePathAllowedWithMultiRoot } from './pathUtils';
import { buildProgressValidationSummary } from './documentLayout';
import { projectProgressToolResultData } from './resultProjection';

export interface ValidateProgressDocumentArgs {
  path: string;
}

export function createValidateProgressDocumentToolDeclaration(): ToolDeclaration {
  return {
    name: 'validate_progress_document',
    strict: true,
    description:
      'Validate the fixed progress document at .limcode/progress.md without modifying it. Reports metadata health, section ordering, and basic invariants.',
    category: 'progress',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Target progress document path. Must be .limcode/progress.md (or multi-root: workspace/.limcode/progress.md).'
        }
      },
      required: ['path']
    }
  };
}

export function createValidateProgressDocumentTool(): Tool {
  return {
    declaration: createValidateProgressDocumentToolDeclaration(),
    handler: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = rawArgs as unknown as ValidateProgressDocumentArgs;
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';

      if (!targetPath) {
        return { success: false, error: 'path is required and must be a non-empty string' };
      }
      if (!isProgressModePathAllowedWithMultiRoot(targetPath)) {
        return { success: false, error: `Invalid progress path. Only ".limcode/progress.md" is allowed. Rejected path: ${targetPath}` };
      }

      const { uri, error } = resolveUriWithInfo(targetPath);
      if (!uri) {
        return { success: false, error: error || 'No workspace folder open' };
      }

      try {
        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const content = normalizeLineEndingsToLF(new TextDecoder().decode(contentBytes));
        const progressValidation = buildProgressValidationSummary(content);

        return {
          success: true,
          data: {
            path: targetPath,
            ...(progressValidation.metadata
              ? projectProgressToolResultData({
                path: targetPath,
                metadata: progressValidation.metadata,
                delta: {
                  type: 'validated',
                  changedFields: []
                }
              })
              : {
                path: targetPath,
                progressDelta: {
                  type: 'validated',
                  changedFields: []
                }
              }
            ),
            progressValidation,
            formatVersion: progressValidation.formatVersion,
            isValid: progressValidation.isValid,
            issueCount: progressValidation.issueCount,
            errorCount: progressValidation.errorCount,
            warningCount: progressValidation.warningCount,
            issues: progressValidation.issues,
          }
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  };
}

export function registerValidateProgressDocument(): Tool {
  return createValidateProgressDocumentTool();
}
