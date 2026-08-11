/**
 * 维护诊断命令（MIG-05 接线）。
 *
 * 注册 `graycode.runIntegrityCheck`：手动运行存档完整性检查（历史 / 存档 / 分支），
 * 结果输出到 VSCode 输出通道（outputChannel），只报告不修复。
 *
 * - 纯手动诊断：不在任何自动路径中执行；
 * - 参数可选：支持 { conversationIds: string[] } 或字符串数组，限定扫描的会话；
 *   缺省扫描 conversations 目录下全部会话；
 * - 依赖经 deps 注入（组合根 backend/bootstrap 构造），便于单测注入 fake。
 */

import * as vscode from 'vscode';
import { runIntegrityCheck, type IntegrityReport } from './integrityCheck';
import type { BranchPathConsistencyResult } from '../../modules/conversation/branch/BranchService';

/** 完整性检查命令 ID（package.json contributes.commands 同步声明，命令面板可发现） */
export const INTEGRITY_CHECK_COMMAND_ID = 'graycode.runIntegrityCheck';

/** 诊断输出通道的最小接口（运行时为 vscode.OutputChannel，测试注入 fake） */
export interface IntegrityCheckOutputChannel {
    appendLine(line: string): void;
}

export interface RegisterMaintenanceCommandsDeps {
    /** StoragePathManager.getEffectiveDataPath()——conversations 目录的父目录 */
    getStoragePath(): string;
    /** CheckpointManager.checkpointsDir——存档备份目录 */
    getCheckpointsDir(): string;
    /** 分支-主历史校验提供者（建议 BranchService.validateActivePathMatchesHistory 包装）；缺省退回内置轻量比较 */
    getBranchValidator?(): ((conversationId: string) => Promise<BranchPathConsistencyResult>) | undefined;
    /** 结果输出通道 */
    outputChannel: IntegrityCheckOutputChannel;
}

/**
 * 从命令参数中提取 conversationIds（可选）。
 * 支持 `{ conversationIds: string[] }` 对象或字符串数组；其余输入返回 undefined（全量扫描）。
 * 非法元素（非字符串）静默过滤；过滤后为空同样返回 undefined。
 */
export function extractConversationIds(args: unknown): string[] | undefined {
    let candidate: unknown;
    if (Array.isArray(args)) {
        candidate = args;
    } else if (args && typeof args === 'object') {
        candidate = (args as { conversationIds?: unknown }).conversationIds;
    } else {
        return undefined;
    }
    if (!Array.isArray(candidate)) {
        return undefined;
    }
    const ids = candidate.filter((item): item is string => typeof item === 'string');
    return ids.length > 0 ? ids : undefined;
}

/** 将结构化报告格式化为输出通道的行（导出以便单测断言） */
export function formatIntegrityReport(report: IntegrityReport, conversationIds?: string[]): string[] {
    const lines: string[] = [];
    lines.push('=== GrayCode 存档完整性检查 ===');
    lines.push(`时间: ${new Date(report.generatedAt).toLocaleString()}`);
    lines.push(`数据目录: ${report.baseDir}`);
    lines.push(`检查点目录: ${report.checkpointsDir}`);
    lines.push(`会话: ${conversationIds ? conversationIds.join(', ') : '全部'}`);
    const summary = report.summary;
    lines.push(
        `汇总: 共 ${summary.totalIssues} 个问题（${summary.errors} error / ${summary.warnings} warning）` +
        ` | history: ${summary.byScope.history} | checkpoint: ${summary.byScope.checkpoint} | branch: ${summary.byScope.branch}`
    );
    const sections: Array<[string, IntegrityReport['history']]> = [
        ['history', report.history],
        ['checkpoint', report.checkpoint],
        ['branch', report.branch],
    ];
    for (const [scope, section] of sections) {
        if (section.checked === 0 && section.issues.length === 0) {
            continue;
        }
        lines.push(`[${scope}] 检查 ${section.checked} 项，问题 ${section.issues.length} 个`);
        for (const issue of section.issues) {
            const subject = issue.conversationId
                ? issue.checkpointId
                    ? `${issue.conversationId}/${issue.checkpointId}`
                    : issue.conversationId
                : issue.checkpointId ?? '-';
            const detail = issue.detail ? ` (${JSON.stringify(issue.detail)})` : '';
            lines.push(`  - [${issue.severity}] ${issue.code} ${subject}: ${issue.message}${detail}`);
        }
    }
    lines.push(
        summary.totalIssues === 0
            ? '结果: 未发现问题'
            : `结果: 发现 ${summary.errors} 个 error / ${summary.warnings} 个 warning，请人工核查（本命令只报告，不修复）`
    );
    return lines;
}

/**
 * 注册维护诊断命令。
 *
 * @param deps 运行时依赖（组合根注入）；命令体 try/catch 包裹，检查失败只写输出通道，不崩溃。
 * @returns 命令注册 Disposable（调用方挂到 context.subscriptions 或自行管理清理）
 */
export function registerMaintenanceCommands(deps: RegisterMaintenanceCommandsDeps): vscode.Disposable {
    return vscode.commands.registerCommand(INTEGRITY_CHECK_COMMAND_ID, async (args?: unknown) => {
        const conversationIds = extractConversationIds(args);
        try {
            const report = await runIntegrityCheck({
                baseDir: deps.getStoragePath(),
                checkpointsDir: deps.getCheckpointsDir(),
                conversationIds,
                branchValidator: deps.getBranchValidator?.(),
            });
            for (const line of formatIntegrityReport(report, conversationIds)) {
                deps.outputChannel.appendLine(line);
            }
        } catch (error) {
            deps.outputChannel.appendLine(
                `[integrity-check] 检查失败: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    });
}
