/**
 * 维护诊断命令接线单测（MIG-05）。
 *
 * 覆盖：
 * - graycode.runIntegrityCheck 命令注册（id / 返回 Disposable）
 * - 命令体全量扫描：结果写入输出通道（真实 runIntegrityCheck + 临时目录）
 * - conversationIds 参数透传（数组 / { conversationIds } 对象两种形态）
 * - 检查失败：错误写入输出通道，不崩溃
 * - extractConversationIds / formatIntegrityReport 纯函数
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    INTEGRITY_CHECK_COMMAND_ID,
    extractConversationIds,
    formatIntegrityReport,
    registerMaintenanceCommands,
    type IntegrityCheckOutputChannel,
} from '../../tools/maintenance/commands';
import type { IntegrityReport } from '../../tools/maintenance/integrityCheck';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import { createEmptyBranchGraph, insertNode } from '../../modules/conversation/branch/BranchGraph';
import type { ConversationBranchNode } from '../../modules/conversation/branch/types';

// ==================== vscode mock 补齐 ====================
// backend/__tests__/__mocks__/vscode.ts 只 mock 了 commands.executeCommand，
// registerCommand 在测试内补齐并捕获 handler（mock 模块按测试文件隔离，不污染其他套件）。
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
(vscode as any).commands.registerCommand = jest.fn(
    (id: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(id, handler);
        return { dispose: jest.fn() };
    }
);

// ==================== 测试数据构建 ====================

async function createTempDirectory(prefix: string): Promise<string> {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 写入一个合法的 segmented index + 段文件（每条消息一个 id） */
async function writeSegmentedHistory(
    baseDir: string,
    conversationId: string,
    messageCount: number,
    options: { overrideTotalMessages?: number } = {}
): Promise<void> {
    const convDir = path.join(baseDir, 'conversations', conversationId);
    const historyDir = path.join(convDir, 'history');
    await fsp.mkdir(historyDir, { recursive: true });

    const lines: string[] = [];
    for (let i = 0; i < messageCount; i++) {
        const role = i % 2 === 0 ? 'user' : 'model';
        lines.push(JSON.stringify({ id: `m${i}`, role, parts: [{ text: `msg-${i}` }], timestamp: 1000 + i }));
    }
    const file = '000000.ndjson';
    await fsp.writeFile(path.join(historyDir, file), lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');

    const index = {
        version: 1,
        segmentSize: 200,
        totalMessages: options.overrideTotalMessages ?? messageCount,
        segments: [{ file, startIndex: 0, endIndex: messageCount - 1, count: messageCount }],
    };
    await fsp.writeFile(path.join(convDir, 'history.index.json'), JSON.stringify(index, null, 2), 'utf8');
}

/** 构造一个分支图节点 */
function branchNode(id: string, parentId: string | null): ConversationBranchNode {
    return {
        id,
        parentId,
        role: 'user',
        parts: [{ text: id }],
        kind: 'normal',
        createdAt: 1000,
    };
}

/** 写入一个分支图（与主历史 m0..mN 对齐：root=m0, child=m1, ...） */
async function writeBranchGraph(baseDir: string, conversationId: string, historyIds: string[]): Promise<void> {
    const repo = new BranchGraphRepository(baseDir);
    let graph = createEmptyBranchGraph();
    historyIds.forEach((id, index) => {
        graph = insertNode(graph, branchNode(id, index === 0 ? null : historyIds[index - 1]));
    });
    await repo.save(conversationId, graph);
}

/** 构造一个最小输出通道 fake */
function createFakeOutputChannel(): IntegrityCheckOutputChannel & { lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        appendLine: (line: string) => {
            lines.push(line);
        },
    };
}

// ==================== 用例 ====================

describe('registerMaintenanceCommands (MIG-05)', () => {
    beforeEach(() => {
        registeredCommands.clear();
        jest.clearAllMocks();
    });

    test('registers graycode.runIntegrityCheck and returns a disposable', () => {
        const outputChannel = createFakeOutputChannel();
        const disposable = registerMaintenanceCommands({
            getStoragePath: () => '/tmp',
            getCheckpointsDir: () => '/tmp/checkpoints',
            outputChannel,
        });
        expect(registeredCommands.has(INTEGRITY_CHECK_COMMAND_ID)).toBe(true);
        expect(typeof disposable.dispose).toBe('function');
    });

    test('full scan writes summary report to output channel', async () => {
        const baseDir = await createTempDirectory('graycode-integrity-cmd-');
        try {
            await writeSegmentedHistory(baseDir, 'conv-a', 3);
            const outputChannel = createFakeOutputChannel();
            const disposable = registerMaintenanceCommands({
                getStoragePath: () => baseDir,
                getCheckpointsDir: () => path.join(baseDir, 'checkpoints'),
                outputChannel,
            });
            const handler = registeredCommands.get(INTEGRITY_CHECK_COMMAND_ID)!;
            await handler();

            const all = outputChannel.lines.join('\n');
            expect(all).toContain('=== GrayCode 存档完整性检查 ===');
            expect(all).toContain(`数据目录: ${baseDir}`);
            expect(all).toContain('汇总: 共 0 个问题（0 error / 0 warning）');
            expect(all).toContain('结果: 未发现问题');
            disposable.dispose();
        } finally {
            await fsp.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('conversationIds option restricts the scan', async () => {
        const baseDir = await createTempDirectory('graycode-integrity-cmd-');
        try {
            await writeSegmentedHistory(baseDir, 'conv-a', 3);
            // conv-b 的 index totalMessages 与段 Σcount 不一致 → history error
            await writeSegmentedHistory(baseDir, 'conv-b', 3, { overrideTotalMessages: 99 });
            const outputChannel = createFakeOutputChannel();
            registerMaintenanceCommands({
                getStoragePath: () => baseDir,
                getCheckpointsDir: () => path.join(baseDir, 'checkpoints'),
                outputChannel,
            });
            const handler = registeredCommands.get(INTEGRITY_CHECK_COMMAND_ID)!;

            // 全量：能看到 conv-b 的问题
            await handler();
            expect(outputChannel.lines.join('\n')).toContain('HISTORY_SEGMENT_COUNT_MISMATCH');
            expect(outputChannel.lines.join('\n')).toContain('conv-b');

            // 限定 conv-a：conv-b 的问题不再出现
            outputChannel.lines.length = 0;
            await handler({ conversationIds: ['conv-a'] });
            const limited = outputChannel.lines.join('\n');
            expect(limited).toContain('会话: conv-a');
            expect(limited).not.toContain('HISTORY_SEGMENT_COUNT_MISMATCH');
            expect(limited).not.toContain('conv-b');

            // 数组形态参数同样生效
            outputChannel.lines.length = 0;
            await handler(['conv-a']);
            expect(outputChannel.lines.join('\n')).not.toContain('HISTORY_SEGMENT_COUNT_MISMATCH');
        } finally {
            await fsp.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('check failure is written to output channel without throwing', async () => {
        const outputChannel = createFakeOutputChannel();
        registerMaintenanceCommands({
            getStoragePath: () => {
                throw new Error('storage path unavailable');
            },
            getCheckpointsDir: () => path.join('/tmp', 'checkpoints'),
            outputChannel,
        });
        const handler = registeredCommands.get(INTEGRITY_CHECK_COMMAND_ID)!;

        await expect(handler()).resolves.toBeUndefined();
        expect(outputChannel.lines.join('\n')).toContain('[integrity-check] 检查失败: storage path unavailable');
    });

    test('branchValidator is forwarded when provided', async () => {
        const baseDir = await createTempDirectory('graycode-integrity-cmd-');
        try {
            await writeSegmentedHistory(baseDir, 'conv-a', 2);
            await writeBranchGraph(baseDir, 'conv-a', ['m0', 'm1']);
            const outputChannel = createFakeOutputChannel();
            const branchValidator = jest.fn(async () => ({
                valid: true,
                issues: [],
                graphMissing: false,
                historyIds: [],
                activePathIds: [],
            }));
            registerMaintenanceCommands({
                getStoragePath: () => baseDir,
                getCheckpointsDir: () => path.join(baseDir, 'checkpoints'),
                getBranchValidator: () => branchValidator,
                outputChannel,
            });
            const handler = registeredCommands.get(INTEGRITY_CHECK_COMMAND_ID)!;
            await handler();
            expect(branchValidator).toHaveBeenCalledWith('conv-a');
        } finally {
            await fsp.rm(baseDir, { recursive: true, force: true });
        }
    });
});

describe('extractConversationIds', () => {
    test('accepts array and object forms, rejects others', () => {
        expect(extractConversationIds(['a', 'b'])).toEqual(['a', 'b']);
        expect(extractConversationIds({ conversationIds: ['a'] })).toEqual(['a']);
        expect(extractConversationIds(undefined)).toBeUndefined();
        expect(extractConversationIds('a')).toBeUndefined();
        expect(extractConversationIds({})).toBeUndefined();
        expect(extractConversationIds({ conversationIds: 'a' })).toBeUndefined();
        expect(extractConversationIds(['a', 42, null])).toEqual(['a']);
        expect(extractConversationIds([])).toBeUndefined();
        expect(extractConversationIds({ conversationIds: [] })).toBeUndefined();
    });
});

describe('formatIntegrityReport', () => {
    test('formats summary and issue lines', () => {
        const report: IntegrityReport = {
            generatedAt: 1_700_000_000_000,
            baseDir: '/data',
            checkpointsDir: '/data/checkpoints',
            summary: {
                totalIssues: 2,
                errors: 1,
                warnings: 1,
                byScope: { history: 1, checkpoint: 0, branch: 1 },
            },
            history: {
                checked: 1,
                byCode: { HISTORY_SEGMENT_COUNT_MISMATCH: 1 },
                issues: [
                    {
                        scope: 'history',
                        severity: 'error',
                        conversationId: 'conv-a',
                        code: 'HISTORY_SEGMENT_COUNT_MISMATCH',
                        message: 'Σsegments.count 与 totalMessages 不一致',
                        detail: { expected: 3, actual: 2 },
                    },
                ],
            },
            checkpoint: { checked: 0, byCode: {}, issues: [] },
            branch: {
                checked: 1,
                byCode: { BRANCH_PATH_MISMATCH: 1 },
                issues: [
                    {
                        scope: 'branch',
                        severity: 'warning',
                        conversationId: 'conv-b',
                        code: 'BRANCH_PATH_MISMATCH',
                        message: '活跃路径与主历史不一致',
                    },
                ],
            },
        };
        const lines = formatIntegrityReport(report, ['conv-a']);
        const all = lines.join('\n');
        expect(all).toContain('会话: conv-a');
        expect(all).toContain('汇总: 共 2 个问题（1 error / 1 warning）');
        expect(all).toContain('[history] 检查 1 项，问题 1 个');
        expect(all).toContain('- [error] HISTORY_SEGMENT_COUNT_MISMATCH conv-a: Σsegments.count 与 totalMessages 不一致');
        expect(all).toContain('结果: 发现 1 个 error / 1 个 warning，请人工核查');
        // 空 section 不输出
        expect(all).not.toContain('[checkpoint]');
    });
});
