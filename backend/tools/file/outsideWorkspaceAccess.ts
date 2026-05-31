import type { ToolContext } from '../types';
import type { SettingsManager } from '../../modules/settings';
import {
    DEFAULT_APPLY_DIFF_CONFIG,
    DEFAULT_READ_FILE_CONFIG,
    DEFAULT_WRITE_FILE_CONFIG,
    type ApplyDiffToolConfig,
    type OutsideWorkspaceReadAccess,
    type OutsideWorkspaceWriteAccess
} from '../../modules/settings';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { resolveFileToolPathWithInfo } from '../utils';

export type OutsideWorkspaceAccessAction = 'read' | 'write';
export type OutsideWorkspaceAwareToolName = 'read_file' | 'write_file' | 'apply_diff';

export interface OutsideWorkspaceAccessCheck {
    isOutsideWorkspace: boolean;
    policy: OutsideWorkspaceReadAccess | OutsideWorkspaceWriteAccess;
    requiresConfirmation: boolean;
    denied: boolean;
    paths: string[];
    error?: string;
}

const READ_POLICIES = new Set<OutsideWorkspaceReadAccess>(['deny', 'ask', 'allow']);
const WRITE_POLICIES = new Set<OutsideWorkspaceWriteAccess>(['deny', 'ask']);

function getSettingsManager(settingsManager?: SettingsManager): SettingsManager | null {
    return settingsManager || getGlobalSettingsManager();
}

function getReadPolicy(settingsManager?: SettingsManager): OutsideWorkspaceReadAccess {
    const configured = getSettingsManager(settingsManager)?.getReadFileConfig()?.outsideWorkspaceAccess;
    return configured && READ_POLICIES.has(configured)
        ? configured
        : DEFAULT_READ_FILE_CONFIG.outsideWorkspaceAccess;
}

function getWritePolicy(toolName: OutsideWorkspaceAwareToolName, settingsManager?: SettingsManager): OutsideWorkspaceWriteAccess {
    const manager = getSettingsManager(settingsManager);
    const configured = toolName === 'apply_diff'
        ? manager?.getApplyDiffConfig()?.outsideWorkspaceAccess
        : manager?.getWriteFileConfig()?.outsideWorkspaceAccess;

    const fallback = toolName === 'apply_diff'
        ? DEFAULT_APPLY_DIFF_CONFIG.outsideWorkspaceAccess
        : DEFAULT_WRITE_FILE_CONFIG.outsideWorkspaceAccess;

    return configured && WRITE_POLICIES.has(configured)
        ? configured
        : fallback;
}

function getPolicy(toolName: OutsideWorkspaceAwareToolName, settingsManager?: SettingsManager): OutsideWorkspaceReadAccess | OutsideWorkspaceWriteAccess {
    return toolName === 'read_file'
        ? getReadPolicy(settingsManager)
        : getWritePolicy(toolName, settingsManager);
}

function extractCandidatePaths(toolName: OutsideWorkspaceAwareToolName, args: Record<string, unknown> | undefined): string[] {
    if (!args || typeof args !== 'object') {
        return [];
    }

    if (toolName === 'read_file' || toolName === 'write_file') {
        const singlePath = (args as any).path;
        if (typeof singlePath === 'string' && singlePath.trim().length > 0) {
            return [singlePath];
        }

        const files = (args as any).files;
        if (!Array.isArray(files)) {
            return [];
        }

        return files
            .map(item => item?.path)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    }

    const singlePath = (args as any).path;
    return typeof singlePath === 'string' && singlePath.trim().length > 0 ? [singlePath] : [];
}

function getDeniedBySettingsMessage(toolName: OutsideWorkspaceAwareToolName, filePaths: string[]): string {
    const action = toolName === 'read_file' ? 'Reading' : 'Writing';
    const target = filePaths.length > 0 ? filePaths.join(', ') : 'outside-workspace path';
    return `${action} files outside the workspace is disabled in settings for ${toolName}: ${target}`;
}

function getRequiresConfirmationMessage(toolName: OutsideWorkspaceAwareToolName, filePaths: string[]): string {
    const action = toolName === 'read_file' ? 'read' : 'write';
    const target = filePaths.length > 0 ? filePaths.join(', ') : 'outside-workspace path';
    return `${toolName} needs user confirmation before it can ${action} outside-workspace files: ${target}`;
}

function getApplyDiffConfig(settingsManager?: SettingsManager): Readonly<ApplyDiffToolConfig> {
    return getSettingsManager(settingsManager)?.getApplyDiffConfig() || DEFAULT_APPLY_DIFF_CONFIG;
}

/**
 * write_file / apply_diff 本身会创建 Diff 预览并等待用户接受/拒绝。
 *
 * 当处于“手动审阅”模式（autoSave=false）时，这个 Diff 审阅已经覆盖了
 * outside-workspace ask 策略需要的访问确认，因此不再叠加一层工作区外权限确认。
 * 通用工具确认（autoExec=false）仍按原规则生效，保持和工作区内写入一致。
 *
 * 如果启用了自动应用（autoSave=true），仍保留工作区外权限确认，
 * 防止工作区外文件被静默写入。
 */
export function isOutsideWorkspaceWriteCoveredByManualDiffReview(toolName: string, settingsManager?: SettingsManager): boolean {
    if (toolName !== 'write_file' && toolName !== 'apply_diff') {
        return false;
    }
    return getApplyDiffConfig(settingsManager).autoSave !== true;
}

export function getOutsideWorkspaceAccessCheck(
    toolName: OutsideWorkspaceAwareToolName,
    args: Record<string, unknown> | undefined,
    settingsManager?: SettingsManager
): OutsideWorkspaceAccessCheck {
    const candidatePaths = extractCandidatePaths(toolName, args);
    const outsidePaths = candidatePaths
        .map(filePath => resolveFileToolPathWithInfo(filePath))
        .filter(resolved => resolved.isOutsideWorkspace)
        .map(resolved => resolved.displayPath);

    const policy = getPolicy(toolName, settingsManager);
    const isOutsideWorkspace = outsidePaths.length > 0;

    if (!isOutsideWorkspace) {
        return {
            isOutsideWorkspace: false,
            policy,
            requiresConfirmation: false,
            denied: false,
            paths: []
        };
    }

    if (policy === 'deny') {
        return {
            isOutsideWorkspace: true,
            policy,
            requiresConfirmation: false,
            denied: true,
            paths: outsidePaths,
            error: getDeniedBySettingsMessage(toolName, outsidePaths)
        };
    }

    if (policy === 'ask' && isOutsideWorkspaceWriteCoveredByManualDiffReview(toolName, settingsManager)) {
        return {
            isOutsideWorkspace: true,
            policy,
            requiresConfirmation: false,
            denied: false,
            paths: outsidePaths
        };
    }

    if (policy === 'ask') {
        return {
            isOutsideWorkspace: true,
            policy,
            requiresConfirmation: true,
            denied: false,
            paths: outsidePaths
        };
    }

    return {
        isOutsideWorkspace: true,
        policy,
        requiresConfirmation: false,
        denied: false,
        paths: outsidePaths
    };
}

export function toolCallNeedsOutsideWorkspaceConfirmation(
    toolName: string,
    args: Record<string, unknown> | undefined,
    settingsManager?: SettingsManager
): boolean {
    if (!isOutsideWorkspaceAwareTool(toolName)) {
        return false;
    }
    return getOutsideWorkspaceAccessCheck(toolName, args, settingsManager).requiresConfirmation;
}

export function getOutsideWorkspaceRejectionReason(
    toolName: string,
    args: Record<string, unknown> | undefined,
    settingsManager?: SettingsManager
): string | null {
    if (!isOutsideWorkspaceAwareTool(toolName)) {
        return null;
    }
    const check = getOutsideWorkspaceAccessCheck(toolName, args, settingsManager);
    return check.denied ? check.error || getDeniedBySettingsMessage(toolName, check.paths) : null;
}

export function ensureOutsideWorkspaceAccessApproved(
    toolName: OutsideWorkspaceAwareToolName,
    args: Record<string, unknown> | undefined,
    context?: ToolContext
): string | null {
    const check = getOutsideWorkspaceAccessCheck(toolName, args);
    if (check.denied) {
        return check.error || getDeniedBySettingsMessage(toolName, check.paths);
    }

    if (check.requiresConfirmation && context?.approvedByToolConfirmation !== true) {
        return getRequiresConfirmationMessage(toolName, check.paths);
    }

    return null;
}

export function isOutsideWorkspaceAwareTool(toolName: string): toolName is OutsideWorkspaceAwareToolName {
    return toolName === 'read_file' || toolName === 'write_file' || toolName === 'apply_diff';
}
