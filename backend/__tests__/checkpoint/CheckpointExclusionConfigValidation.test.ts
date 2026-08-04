/**
 * Checkpoint 排除配置保存校验测试（L-4 / EX-12 残余）。
 *
 * 覆盖：
 * - enabledProfiles 未知 profile id 拒绝保存
 * - enabledProfiles 已知 profile id 正常保存
 * - maxFileSizeBytes 非有限数值（NaN / 字符串）拒绝保存
 */
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';
import type { CheckpointConfig } from '../../modules/settings/types';

async function createSettingsManager(): Promise<SettingsManager> {
    const settingsManager = new SettingsManager(new MemorySettingsStorage());
    await settingsManager.initialize();
    return settingsManager;
}

describe('Checkpoint exclusion config validation (L-4)', () => {
    test('rejects unknown enabledProfiles ids', async () => {
        const sm = await createSettingsManager();
        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: { logs: true, unknownProfile: true },
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        })).rejects.toThrow();
    });

    test('rejects non-object enabledProfiles', async () => {
        const sm = await createSettingsManager();
        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: 'all' as unknown as Record<string, boolean>,
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        })).rejects.toThrow();
    });

    test('accepts known profile ids (partial override)', async () => {
        const sm = await createSettingsManager();
        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: { logs: false },
                maxFileSizeBytes: 50 * 1024 * 1024,
                customPatterns: ['*.tmp']
            }
        })).resolves.toBeUndefined();
    });

    test('rejects non-finite maxFileSizeBytes (NaN / string)', async () => {
        const sm = await createSettingsManager();
        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: {},
                maxFileSizeBytes: Number.NaN,
                customPatterns: []
            }
        })).rejects.toThrow();

        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: {},
                maxFileSizeBytes: '50' as unknown as number,
                customPatterns: []
            }
        })).rejects.toThrow();
    });

    test('normalizes negative maxFileSizeBytes to 0 (unlimited)', async () => {
        const sm = await createSettingsManager();
        await sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: {},
                maxFileSizeBytes: -5,
                customPatterns: []
            }
        });
        expect(sm.getCheckpointConfig().exclusion?.maxFileSizeBytes).toBe(0);
    });

    test('EX-12-1: rejects non-boolean enabledProfiles values ("false" string / null)', async () => {
        const sm = await createSettingsManager();
        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: { logs: 'false' as unknown as boolean },
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        })).rejects.toThrow();

        await expect(sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: { logs: null as unknown as boolean },
                maxFileSizeBytes: 0,
                customPatterns: []
            }
        })).rejects.toThrow();
    });

    test('EX-12-1: rejects non-string-array beforeTools / afterTools and non-boolean enabled', async () => {
        const sm = await createSettingsManager();
        const base = {
            enabled: true,
            beforeTools: [] as string[],
            afterTools: [] as string[],
            maxCheckpoints: -1,
            exclusion: { enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] }
        };

        await expect(sm.updateCheckpointConfig({ ...base, beforeTools: 'apply_diff' as unknown as string[] })).rejects.toThrow();
        await expect(sm.updateCheckpointConfig({ ...base, beforeTools: ['apply_diff', 42] as unknown as string[] })).rejects.toThrow();
        await expect(sm.updateCheckpointConfig({ ...base, afterTools: 'write_file' as unknown as string[] })).rejects.toThrow();
        await expect(sm.updateCheckpointConfig({ ...base, enabled: 'yes' as unknown as boolean })).rejects.toThrow();

        // 合法字符串数组 / 布尔仍可保存
        await expect(sm.updateCheckpointConfig({ ...base, beforeTools: ['apply_diff'], afterTools: ['write_file'], enabled: false }))
            .resolves.toBeUndefined();
    });

    test('EX-12-1: rejects invalid maxCheckpoints but keeps -1 (unlimited) valid', async () => {
        const sm = await createSettingsManager();
        const base = {
            enabled: true,
            beforeTools: [] as string[],
            afterTools: [] as string[],
            exclusion: { enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] }
        };

        for (const value of [Number.NaN, Infinity, 1.5, -2, '10' as unknown as number]) {
            await expect(sm.updateCheckpointConfig({ ...base, maxCheckpoints: value })).rejects.toThrow();
        }

        // -1 = 无上限哨兵（默认配置与前端沿用），必须保持可保存；0 同样合法
        await expect(sm.updateCheckpointConfig({ ...base, maxCheckpoints: -1 })).resolves.toBeUndefined();
        await expect(sm.updateCheckpointConfig({ ...base, maxCheckpoints: 0 })).resolves.toBeUndefined();
    });

    test('EX-CFG-1: partial exclusion update deep-merges and preserves saved profilePatterns', async () => {
        const sm = await createSettingsManager();
        await sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: { logs: false },
                maxFileSizeBytes: 10 * 1024 * 1024,
                customPatterns: ['*.tmp'],
                profilePatterns: { logs: ['app-*.log'] }
            }
        });

        // 只发送部分 exclusion 负载（仅 enabledProfiles）：不得覆盖已保存的 profilePatterns / maxFileSizeBytes / customPatterns
        await sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: { logs: true, caches: false }
            } as unknown as CheckpointConfig['exclusion']
        });

        const saved = sm.getCheckpointConfig();
        expect(saved.exclusion?.profilePatterns?.logs).toEqual(['app-*.log']);
        expect(saved.exclusion?.maxFileSizeBytes).toBe(10 * 1024 * 1024);
        expect(saved.exclusion?.customPatterns).toEqual(['*.tmp']);
        expect(saved.exclusion?.enabledProfiles?.logs).toBe(true);
        expect(saved.exclusion?.enabledProfiles?.caches).toBe(false);
    });

    test('EX-CFG-1: messageCheckpoint partial update deep-merges nested fields', async () => {
        const sm = await createSettingsManager();
        await sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            messageCheckpoint: {
                beforeMessages: ['user'],
                afterMessages: ['model'],
                modelOuterLayerOnly: false,
                mergeUnchangedCheckpoints: true
            }
        });

        // 只更新 messageCheckpoint 的部分字段：其余嵌套字段必须保留
        await sm.updateCheckpointConfig({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            maxCheckpoints: -1,
            messageCheckpoint: { afterMessages: ['user', 'model'] } as unknown as CheckpointConfig['messageCheckpoint']
        });

        const saved = sm.getCheckpointConfig();
        expect(saved.messageCheckpoint?.beforeMessages).toEqual(['user']);
        expect(saved.messageCheckpoint?.afterMessages).toEqual(['user', 'model']);
        expect(saved.messageCheckpoint?.modelOuterLayerOnly).toBe(false);
        expect(saved.messageCheckpoint?.mergeUnchangedCheckpoints).toBe(true);
    });

    test('EX-CFG-2: negative maxFileSizeBytes normalization does not mutate caller object', async () => {
        const sm = await createSettingsManager();
        const payload = {
            enabled: true,
            beforeTools: [] as string[],
            afterTools: [] as string[],
            maxCheckpoints: -1,
            exclusion: {
                enabledProfiles: {} as Record<string, boolean>,
                maxFileSizeBytes: -5,
                customPatterns: [] as string[]
            }
        };
        await sm.updateCheckpointConfig(payload);
        // 调用方对象保持原值，未被改写
        expect(payload.exclusion.maxFileSizeBytes).toBe(-5);
        // 落盘值为归一化后的 0
        expect(sm.getCheckpointConfig().exclusion?.maxFileSizeBytes).toBe(0);
    });

    test('EX-12-2: rejects blanket custom patterns that exclude the entire workspace', async () => {
        const sm = await createSettingsManager();
        for (const pattern of ['*', '**', '/**', '/*', '!*', '!**']) {
            await expect(sm.updateCheckpointConfig({
                enabled: true,
                beforeTools: [],
                afterTools: [],
                maxCheckpoints: -1,
                exclusion: {
                    enabledProfiles: {},
                    maxFileSizeBytes: 0,
                    customPatterns: [pattern]
                }
            })).rejects.toThrow();
        }
    });
});
