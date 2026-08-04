/**
 * Checkpoint 排除配置保存校验测试（L-4 / EX-12 残余）。
 *
 * 覆盖：
 * - enabledProfiles 未知 profile id 拒绝保存
 * - enabledProfiles 已知 profile id 正常保存
 * - maxFileSizeBytes 非有限数值（NaN / 字符串）拒绝保存
 */
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';

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
});
