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

/**
 * 修改原因：delete_file/create_directory/insert_code/delete_code 同样通过
 * resolveUri 接受绝对路径，但之前完全不受工作区外策略管控——
 * “禁止工作区外写入”设置对它们形同虚设（例如 delete_file 传绝对路径可直接删除工作区外文件）。
 * 修改方式：将四个写类工具纳入策略覆盖，写策略复用 write_file 的配置（apply_diff 用自己的）。
 *
 * search_in_files：path 参数可以是目录/文件绝对路径，解析后可能落在工作区外；
 * 纳入策略覆盖后按模式区分——search 只读沿用读策略（deny/ask/allow），
 * replace 写入沿用写策略（deny/ask），与 read_file/write_file 行为一致。
 */
export type OutsideWorkspaceAwareToolName =
    | 'read_file'
    | 'list_files'
    | 'write_file'
    | 'apply_diff'
    | 'delete_file'
    | 'create_directory'
    | 'insert_code'
    | 'delete_code'
    | 'search_in_files'
    | 'get_symbols'
    | 'goto_definition'
    | 'find_references';

const OUTSIDE_WORKSPACE_AWARE_TOOLS = new Set<string>([
    'read_file',
    'list_files',
    'write_file',
    'apply_diff',
    'delete_file',
    'create_directory',
    'insert_code',
    'delete_code',
    'search_in_files',
    'get_symbols',
    'goto_definition',
    'find_references'
]);

/** 只读类工具名（读策略 deny/ask/allow 与「Reading/read」文案） */
const READ_ONLY_OUTSIDE_WORKSPACE_TOOLS = new Set<string>([
    'read_file',
    'list_files',
    'get_symbols',
    'goto_definition',
    'find_references'
]);

/** 自身带 diff 审阅确认层的写类工具 */
const DIFF_REVIEW_WRITE_TOOLS = new Set<string>(['write_file', 'apply_diff', 'insert_code', 'delete_code', 'search_in_files']);

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

function getPolicy(
    toolName: OutsideWorkspaceAwareToolName,
    settingsManager?: SettingsManager,
    args?: Record<string, unknown>
): OutsideWorkspaceReadAccess | OutsideWorkspaceWriteAccess {
    // 只读工具（list_files / LSP 三工具）与 read_file 一样沿用读策略（deny/ask/allow）
    if (READ_ONLY_OUTSIDE_WORKSPACE_TOOLS.has(toolName)) {
        return getReadPolicy(settingsManager);
    }

    // search_in_files 读写模式混合：search 只读沿用读策略，replace 写入沿用写策略
    if (toolName === 'search_in_files') {
        return args?.mode === 'replace'
            ? getWritePolicy(toolName, settingsManager)
            : getReadPolicy(settingsManager);
    }

    return getWritePolicy(toolName, settingsManager);
}

function extractNonEmptyStrings(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function extractCandidatePaths(toolName: OutsideWorkspaceAwareToolName, args: Record<string, unknown> | undefined): string[] {
    if (!args || typeof args !== 'object') {
        return [];
    }

    // delete_file/create_directory/list_files：paths 字符串数组（list_files 另兼容单 path）
    if (toolName === 'delete_file' || toolName === 'create_directory' || toolName === 'list_files') {
        const fromArray = extractNonEmptyStrings(args.paths);
        if (fromArray.length > 0) {
            return fromArray;
        }
        const single = args.path;
        return typeof single === 'string' && single.trim().length > 0 ? [single] : [];
    }

    // insert_code/delete_code：files[].path
    if (toolName === 'insert_code' || toolName === 'delete_code') {
        const files = args.files;
        if (!Array.isArray(files)) {
            return [];
        }
        return files
            .map(item => item?.path)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    }

    // get_symbols：paths 字符串数组（批量符号查询）
    if (toolName === 'get_symbols') {
        return extractNonEmptyStrings(args.paths);
    }

    if (toolName === 'read_file' || toolName === 'write_file') {
        const singlePath = args.path;
        if (typeof singlePath === 'string' && singlePath.trim().length > 0) {
            return [singlePath];
        }

        // read_file 的规范 schema 是顶层 path（单文件）与 files（批量）数组；
        // 这里再兼容历史/第三方客户端可能传入的 paths 数组形式，
        // 避免 paths 形式的工作区外读取绕过策略检查
        const fromPathsArray = extractNonEmptyStrings(args.paths);
        if (fromPathsArray.length > 0) {
            return fromPathsArray;
        }

        const files = args.files;
        if (!Array.isArray(files)) {
            return [];
        }

        return files
            .map(item => item?.path)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    }

    const singlePath = args.path;
    return typeof singlePath === 'string' && singlePath.trim().length > 0 ? [singlePath] : [];
}

function getDeniedBySettingsMessage(toolName: OutsideWorkspaceAwareToolName, filePaths: string[], displayName?: string): string {
    const name = displayName ?? toolName;
    const action = READ_ONLY_OUTSIDE_WORKSPACE_TOOLS.has(toolName) ? 'Reading' : 'Writing';
    const target = filePaths.length > 0 ? filePaths.join(', ') : 'outside-workspace path';
    return `${action} files outside the workspace is disabled in settings for ${name}: ${target}`;
}

function getRequiresConfirmationMessage(toolName: OutsideWorkspaceAwareToolName, filePaths: string[], displayName?: string): string {
    const name = displayName ?? toolName;
    const action = READ_ONLY_OUTSIDE_WORKSPACE_TOOLS.has(toolName) ? 'read' : 'write';
    const target = filePaths.length > 0 ? filePaths.join(', ') : 'outside-workspace path';
    return `${name} needs user confirmation before it can ${action} outside-workspace files: ${target}`;
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
    if (!DIFF_REVIEW_WRITE_TOOLS.has(toolName)) {
        return false;
    }
    return getApplyDiffConfig(settingsManager).autoSave !== true;
}

/**
 * 判断工具调用是否被手动 diff 审阅覆盖（此时 ask 策略无需再叠加聊天确认）。
 * search_in_files 只有 replace 模式走 diff 审阅（search 模式是只读的，永远需要按读策略确认）。
 */
function isDiffReviewCoveredForCall(
    toolName: OutsideWorkspaceAwareToolName,
    args: Record<string, unknown> | undefined,
    settingsManager?: SettingsManager
): boolean {
    if (!DIFF_REVIEW_WRITE_TOOLS.has(toolName)) {
        return false;
    }
    if (toolName === 'search_in_files' && args?.mode !== 'replace') {
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

    const policy = getPolicy(toolName, settingsManager, args);
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

    if (policy === 'ask' && isDiffReviewCoveredForCall(toolName, args, settingsManager)) {
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

/**
 * 入口兜底检查：deny 直接报错；ask 且未获服务层确认时报确认文案。
 *
 * @param displayName 错误文案中展示的工具名。media 工具借用 read_file/write_file 策略
 *        （图片工具借用读写策略是设计决定），传真实工具名让用户看到正确的错误文案。
 */
export function ensureOutsideWorkspaceAccessApproved(
    toolName: OutsideWorkspaceAwareToolName,
    args: Record<string, unknown> | undefined,
    context?: ToolContext,
    displayName?: string
): string | null {
    const check = getOutsideWorkspaceAccessCheck(toolName, args);
    if (check.denied) {
        return check.error || getDeniedBySettingsMessage(toolName, check.paths, displayName);
    }

    if (check.requiresConfirmation && context?.approvedByToolConfirmation !== true) {
        return getRequiresConfirmationMessage(toolName, check.paths, displayName);
    }

    return null;
}

export function isOutsideWorkspaceAwareTool(toolName: string): toolName is OutsideWorkspaceAwareToolName {
    return OUTSIDE_WORKSPACE_AWARE_TOOLS.has(toolName);
}
