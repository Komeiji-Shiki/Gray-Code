/**
 * 测试共享 fixture：checkpoint 系列 builder（makeRecord / createTempDirectory / createTempWorkspace）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（模块化重构第六批）：
 * - createTempDirectory 原在 8 个 checkpoint 测试中重复定义（完全同构）。
 * - createTempWorkspace 原在 3 个测试中重复定义（仅前缀常量不同，统一为默认前缀）。
 * - makeRecord 原在 6 个测试中重复定义（默认字段各有出入：toolName/phase/timestamp/
 *   fileCount/contentHash/backupDir 推导规则），统一为「id 可选 + backupDir 默认取 id」；
 *   所有消费方断言只依赖显式传入的字段，不依赖被收敛的默认值差异。
 * - 消费方通过 `import { makeRecord, createTempDirectory, createTempWorkspace } from '../__fixtures__/checkpointFixtures'` 引入。
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';

/**
 * 构造一条测试 CheckpointRecord。
 * 仅 id 为语义锚点：backupDir 默认取 overrides.id；显式传 backupDir 时以其为准。
 */
export function makeRecord(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
    return {
        conversationId: 'conv-1',
        messageIndex: 0,
        toolName: 'test',
        phase: 'before',
        timestamp: 1000,
        backupDir: overrides.backupDir ?? overrides.id ?? 'cp-1',
        fileCount: 1,
        contentHash: 'hash',
        type: 'full',
        id: overrides.id ?? 'cp-1',
        ...overrides,
    };
}

/** 创建临时目录（os.tmpdir 下按 prefix 建随机后缀目录）。 */
export async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 创建临时「工作区」目录（语义别名，默认前缀可覆盖）。 */
export async function createTempWorkspace(prefix = 'limcode-checkpoint-'): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
