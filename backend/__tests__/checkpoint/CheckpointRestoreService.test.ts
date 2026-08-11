/**
 * CheckpointRestoreService 测试（CP-PATH-1 / CP-PERF-3）
 *
 * 覆盖：
 * - getIncrementalChain：id → 记录 Map 索引构建增量链（乱序输入、断裂链、长链）
 * - restoreLegacyCheckpointViaEngine：越界 backupDir 拒绝扫描并返回失败结果
 *   （绝不把 path.join(checkpointsDir, backupDir) 交给 readdir/stat/哈希遍历）
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CheckpointRestoreService } from '../../modules/checkpoint/CheckpointRestoreService';
import type { SettingsManager } from '../../modules/settings/SettingsManager';
import type { ConversationManager } from '../../modules/conversation/ConversationManager';
import type { CheckpointManifestRepository } from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointQueryService } from '../../modules/checkpoint/CheckpointQueryService';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import { makeRecord } from '../__fixtures__/checkpointFixtures';

/** 只测链构建/越界守卫，不触碰恢复引擎：其余依赖用空桩 */
function createService(checkpointsDir: string): CheckpointRestoreService {
    return new CheckpointRestoreService(
        checkpointsDir,
        { getCheckpointConfig: jest.fn() } as unknown as SettingsManager,
        {} as unknown as CheckpointManifestRepository,
        {} as unknown as CheckpointQueryService,
        {} as unknown as ConversationManager
    );
}

describe('CheckpointRestoreService', () => {
    describe('getIncrementalChain', () => {
        test('按 id 索引构建链：乱序输入仍得到 base → target 的正确顺序', () => {
            const service = createService(path.join(os.tmpdir(), 'limcode-cp-restore-test'));
            const full = makeRecord({ id: 'cp-a', type: 'full', timestamp: 1000 });
            const inc1 = makeRecord({ id: 'cp-b', type: 'incremental', baseCheckpointId: 'cp-a', timestamp: 2000 });
            const inc2 = makeRecord({ id: 'cp-c', type: 'incremental', baseCheckpointId: 'cp-b', timestamp: 3000 });
            const checkpoints = [inc2, full, inc1]; // 乱序：验证按 id 索引而非数组顺序

            const { chain, broken } = (service as any).getIncrementalChain(checkpoints, inc2);
            expect(chain.map(c => c.id)).toEqual(['cp-a', 'cp-b', 'cp-c']);
            expect(broken).toBe(false);
        });

        test('base 缺失时标记 broken（链停留在最后一个可解析节点）', () => {
            const service = createService(path.join(os.tmpdir(), 'limcode-cp-restore-test'));
            const inc = makeRecord({ id: 'cp-x', type: 'incremental', baseCheckpointId: 'cp-missing', timestamp: 1000 });

            const { chain, broken } = (service as any).getIncrementalChain([inc], inc);
            expect(chain.map(c => c.id)).toEqual(['cp-x']);
            expect(broken).toBe(true);
        });

        test('长链（5000 跳）完整解析，无 O(n²) 退化（Map 每跳 O(1)）', () => {
            const service = createService(path.join(os.tmpdir(), 'limcode-cp-restore-test'));
            const N = 5000;
            const records: CheckpointRecord[] = [];
            for (let i = 0; i < N; i++) {
                records.push(makeRecord({
                    id: `cp-${i}`,
                    type: 'incremental',
                    baseCheckpointId: `cp-${i + 1}`,
                    timestamp: i
                }));
            }
            records.push(makeRecord({ id: `cp-${N}`, type: 'full', timestamp: N }));

            const target = records[0];
            const { chain, broken } = (service as any).getIncrementalChain(records, target);
            expect(chain).toHaveLength(N + 1);
            expect(chain[0].id).toBe(`cp-${N}`);
            expect(chain[N].id).toBe('cp-0');
            expect(broken).toBe(false);
        });
    });

    describe('restoreLegacyCheckpointViaEngine', () => {
        test('CP-PATH-1: 越界 backupDir 拒绝扫描并返回失败结果（外部目录不被触碰）', async () => {
            const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-restore-path-'));
            try {
                const checkpointsDir = path.join(storageRoot, 'checkpoints');
                await fs.mkdir(checkpointsDir, { recursive: true });
                // 存档目录外的“受害者”目录：若扫描发生将读取到 secret.txt
                const victimDir = path.join(storageRoot, 'victim');
                await fs.mkdir(victimDir, { recursive: true });
                const victimFile = path.join(victimDir, 'secret.txt');
                await fs.writeFile(victimFile, 'secret-data', 'utf-8');

                const service = createService(checkpointsDir);
                // legacy 存档（无 fileHashes）→ 本方法会对备份目录做递归扫描
                const evilCp = makeRecord({
                    id: 'cp-evil',
                    backupDir: `..${path.sep}victim`,
                    type: 'full'
                });

                const result = await service.restoreLegacyCheckpointViaEngine(evilCp, [], [], 0);

                expect(result.success).toBe(false);
                expect(result.error).toContain('unsafe backupDir');
                // 受害者文件未被读取/修改
                await expect(fs.readFile(victimFile, 'utf-8')).resolves.toBe('secret-data');
            } finally {
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });
    });
});
