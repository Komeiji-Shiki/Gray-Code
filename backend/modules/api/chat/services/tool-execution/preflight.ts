/**
 * GrayCode - 工具执行服务：plan 模式写路径策略 / checkpoint 绑定 / 策略过滤
 *
 * ToolExecutionService.ts 职责拆分（第二批）的 PreflightCore 基类。
 * 继承链：ToolExecutionService → ExecutionCore → ResultCore → PreflightCore → MailboxCore。
 *
 * 本文件承载：
 * - plan 模式写路径策略（validatePlanModeWriteFileArgs / isPlanModeWriteFilePathAllowed）
 * - 工具策略过滤（getToolRejectionReason：toolsEnabled / mode allowlist / search replace 越权 / 工作区外）
 * - 确认判定（toolNeedsConfirmation / getToolsNeedingConfirmation）
 * - checkpoint 绑定（bindWorkspaceCheckpointBestEffort，BCP-02）
 *
 * 逻辑与拆分前逐字一致；仅可见性从 private 调整为 protected（跨继承类调用所需，
 * 编译期属性，零运行时影响）。
 */
import { Logger } from '../../../../../core/logger';
import { getGlobalBranchService } from '../../../../conversation/branch/BranchService';
import type { SettingsManager } from '../../../../settings/SettingsManager';
import type { ResolvedPromptModeSnapshot } from '../../../../settings/types';
import { isPlanPathAllowed, isSearchInFilesReplaceForbidden } from '../../../../settings/modeToolsPolicy';
import { getAllWorkspaces } from '../../../../../tools/utils';
import {
    getOutsideWorkspaceRejectionReason,
    toolCallNeedsOutsideWorkspaceConfirmation
} from '../../../../../tools/file/outsideWorkspaceAccess';
import { isDiffReviewToolCall } from '../diffReviewTools';
import type { FunctionCallInfo } from '../../utils';
import { MailboxCore } from './mailbox';

/**
 * plan 模式写路径策略 / checkpoint 绑定 / 策略过滤基类
 */
export class PreflightCore extends MailboxCore {
    protected settingsManager?: SettingsManager;
    protected readonly log = Logger.get('ToolExec');

    /**
     * BCP-02：工具执行存档创建成功后，把存档 id fire-and-forget 绑定到分支节点。
     *
     * - 不阻塞工具循环（调用点以 void 丢弃返回值；失败仅 log.warn——绑定是派生态，
     *   存档记录与主历史才是真源，与 TREE-05 appendHistoryToGraph 同哲学）；
     * - 未注入 BranchService（getGlobalBranchService 未注册，如测试环境）或 nodeId 缺省
     *   （before 存档位置尚无消息等）时直接跳过；
     * - 锁序：createCheckpoint 持工作区存档锁，绑定走会话写锁——绝不在此处 await 绑定
     *   （会形成「存档锁 → 会话锁」的嵌套等待，R1 死锁风险）。
     */
    protected bindWorkspaceCheckpointBestEffort(
        conversationId: string,
        nodeId: string | undefined,
        checkpointId: string
    ): void {
        const branchService = getGlobalBranchService();
        if (!branchService || !nodeId || !checkpointId) {
            return;
        }
        void branchService.bindWorkspaceCheckpoint(conversationId, nodeId, checkpointId).catch(error => {
            this.log.warn('bind_workspace_checkpoint_failed', {
                conversationId,
                nodeId,
                checkpointId,
                error: (error as Error)?.message ?? String(error),
            });
        });
    }

    /**
     * 检查工具是否需要用户确认
     *
     * 使用统一的工具自动执行配置来判断
     * 如果工具被配置为自动执行（autoExec = true），则不需要确认
     * 如果工具被配置为需要确认（autoExec = false），则需要用户确认
     *
     * @param toolName 工具名称
     * @returns 是否需要确认
     */
    toolNeedsConfirmation(toolName: string, args?: Record<string, unknown>, promptModeSnapshot?: ResolvedPromptModeSnapshot): boolean {
        // 如果工具在当前模式被禁用（mode allowlist / Plan write_file 路径限制 / toolsEnabled），则不等待确认
        if (this.getToolRejectionReason(toolName, args, promptModeSnapshot) !== null) {
            return false;
        }

        if (!this.settingsManager) {
            return false;
        }

        if (toolCallNeedsOutsideWorkspaceConfirmation(toolName, args, this.settingsManager)) {
            return true;
        }

        // diff 审阅类调用（write_file/apply_diff/insert_code/delete_code/search_in_files replace）
        // 不走聊天确认：diff 机制本身就是它们的确认层——
        // autoSave 关闭时用户在 diff 视图中手动确认；autoSave 开启时用户已明确选择自动应用。
        // 确认行为的唯一数据源是 apply_diff 工具设置，避免“两个设置页都要配置”的困惑。
        if (isDiffReviewToolCall(toolName, args)) {
            return false;
        }

        // 使用统一的自动执行配置
        // isToolAutoExec 返回 true 表示自动执行，不需要确认
        // isToolAutoExec 返回 false 表示需要确认
        return !this.settingsManager.isToolAutoExec(toolName);
    }

    /**
     * 从函数调用列表中筛选出需要确认的工具
     *
     * @param calls 函数调用列表
     * @returns 需要确认的函数调用列表
     */
    getToolsNeedingConfirmation(calls: FunctionCallInfo[], promptModeSnapshot?: ResolvedPromptModeSnapshot): FunctionCallInfo[] {
        return calls.filter(call => this.toolNeedsConfirmation(call.name, call.args, promptModeSnapshot));
    }

    /**
     * 获取工具在当前模式下的拒绝原因（若允许则返回 null）
     *
     * 强制策略：
     * - 全局 toolsEnabled（SettingsManager.isToolEnabled）
     * - 当前模式 allowlist（mode.toolPolicy 仅当为非空数组时启用过滤）
     * - Plan 模式 write_file 仅允许写入 .graycode/plans/**.md（多工作区支持 workspaceName/.graycode/plans/**.md）
     */
    protected getToolRejectionReason(toolName: string, args?: Record<string, unknown>, promptModeSnapshot?: ResolvedPromptModeSnapshot): string | null {
        // 1) 全局 toolsEnabled
        if (this.settingsManager && this.settingsManager.isToolEnabled(toolName) === false) {
            return `Tool "${toolName}" is disabled by settings (toolsEnabled).`;
        }

        // 2) 当前请求模式 allowlist（仅当 toolPolicy 为非空数组时启用过滤）
        const allowlist = Array.isArray(promptModeSnapshot?.toolPolicy) && promptModeSnapshot.toolPolicy.length > 0
            ? promptModeSnapshot.toolPolicy
            : undefined;
        if (allowlist && !allowlist.includes(toolName)) {
            return `Tool "${toolName}" is not allowed in mode "${promptModeSnapshot?.id ?? 'unknown'}".`;
        }

        // 3) 受限模式禁止 search_in_files 的 replace 模式（读模式借搜索工具写文件的权限漏洞）。
        //    允许列表含 search_in_files 但未授予任何通用写工具（write_file/apply_diff 等）时，
        //    replace 模式等价于越权写文件，一律拒绝；search 只读模式不受影响。
        if (toolName === 'search_in_files' && (args as any)?.mode === 'replace' && isSearchInFilesReplaceForbidden(allowlist)) {
            return `search_in_files with mode "replace" is not allowed in mode "${promptModeSnapshot?.id ?? 'unknown'}": this mode only permits read-only search. Use mode "search" instead.`;
        }

        // 4) Plan 模式 write_file 受控例外：只允许写入 .graycode/plans/**.md
        if (promptModeSnapshot?.id === 'plan' && toolName === 'write_file') {
            const validation = this.validatePlanModeWriteFileArgs(args);
            if (validation.ok === false) {
                return validation.error;
            }
        }

        const outsideWorkspaceRejection = getOutsideWorkspaceRejectionReason(toolName, args, this.settingsManager);
        if (outsideWorkspaceRejection) {
            return outsideWorkspaceRejection;
        }

        return null;
    }

    private validatePlanModeWriteFileArgs(
        args?: Record<string, unknown>
    ): { ok: true } | { ok: false; error: string } {
        // write_file 的 schema 只有单文件 path 形式；旧的 files[] 数组分支是死代码
        //（schema 校验会先拒绝无 path 的调用），这里保持与 schema 一致的单一路径。
        const rawPath = (args as any)?.path;
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
            return { ok: false, error: 'In plan mode, write_file requires a non-empty "path" string.' };
        }
        if (!this.isPlanModeWriteFilePathAllowed(rawPath)) {
            return {
                ok: false,
                error: `In plan mode, write_file is only allowed to write ".graycode/plans/**.md". Rejected path: ${rawPath}`
            };
        }
        return { ok: true };
    }

    private isPlanModeWriteFilePathAllowed(path: string): boolean {
        // 先尝试单工作区格式：.graycode/plans/...
        if (isPlanPathAllowed(path)) {
            return true;
        }

        // 多工作区：允许 workspaceName/.graycode/plans/...
        let isMultiRoot = false;
        try {
            isMultiRoot = getAllWorkspaces().length > 1;
        } catch {
            isMultiRoot = false;
        }

        if (!isMultiRoot) {
            return false;
        }

        const normalized = path.replace(/\\/g, '/');
        const slashIndex = normalized.indexOf('/');
        if (slashIndex <= 0) {
            return false;
        }
        const withoutWorkspacePrefix = normalized.substring(slashIndex + 1);
        return isPlanPathAllowed(withoutWorkspacePrefix);
    }
}

