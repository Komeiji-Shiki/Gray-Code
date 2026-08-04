/**
 * VSCodeSettingsStorage.save 只写变更键测试
 *
 * 覆盖修复：旧实现每次保存都把全部 graycode.* 键全量 config.update 一遍（含庞大的
 * toolsConfig），触发多次写入与 Settings Sync；修复后与上次快照逐键深比较，
 * 只写真正变更的键，全部未变更时不产生任何 config.update。
 */

import * as vscode from 'vscode';
import { VSCodeSettingsStorage } from '../../modules/settings/VSCodeSettingsStorage';

interface FakeConfig {
    _stored: Map<string, unknown>;
    get: jest.Mock;
    inspect: jest.Mock;
    update: jest.Mock;
}

function makeConfig(initial: Record<string, unknown> = {}): FakeConfig {
    const stored = new Map<string, unknown>(Object.entries(initial));
    return {
        _stored: stored,
        get: jest.fn((key: string) => stored.get(key)),
        inspect: jest.fn((key: string) => {
            if (!stored.has(key)) {
                return undefined;
            }
            return { globalValue: stored.get(key), workspaceValue: undefined, workspaceFolderValue: undefined };
        }),
        update: jest.fn(async (key: string, value: unknown) => {
            stored.set(key, value);
        })
    };
}

describe('VSCodeSettingsStorage.save 只写变更键', () => {
    let config: FakeConfig;

    beforeEach(() => {
        config = makeConfig();
        (vscode.workspace as any).getConfiguration = jest.fn(() => config);
    });

    it('首次保存只写有值的键（快照为空时未定义键不写）', async () => {
        const storage = new VSCodeSettingsStorage();

        await storage.save({ toolsEnabled: {}, maxToolIterations: 10 } as any);

        // 快照为空：只有值非 undefined 的键算"变更"；其余键不触发 config.update
        expect(config.update).toHaveBeenCalledTimes(2);
        expect(config.update).toHaveBeenCalledWith('toolsEnabled', {}, vscode.ConfigurationTarget.Global);
        expect(config.update).toHaveBeenCalledWith('maxToolIterations', 10, vscode.ConfigurationTarget.Global);
    });

    it('第二次保存只写变更的键', async () => {
        const storage = new VSCodeSettingsStorage();
        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, ui: { theme: 'dark' } } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, maxToolIterations: 20, ui: { theme: 'dark' } } as any);

        expect(config.update).toHaveBeenCalledTimes(1);
        expect(config.update).toHaveBeenCalledWith('maxToolIterations', 20, vscode.ConfigurationTarget.Global);
    });

    it('toolsConfig 深相等（新对象同内容）时不重复写', async () => {
        const storage = new VSCodeSettingsStorage();
        const toolsConfig = { write_file: { maxSizeKB: 100 } };
        await storage.save({ toolsEnabled: {}, toolsConfig } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, toolsConfig: { ...toolsConfig } } as any);

        expect(config.update).not.toHaveBeenCalled();
    });

    it('toolsConfig 内容变化时只写该键', async () => {
        const storage = new VSCodeSettingsStorage();
        await storage.save({ toolsEnabled: {}, toolsConfig: { write_file: { maxSizeKB: 100 } } } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, toolsConfig: { write_file: { maxSizeKB: 200 } } } as any);

        expect(config.update).toHaveBeenCalledTimes(1);
        expect(config.update).toHaveBeenCalledWith(
            'toolsConfig',
            { write_file: { maxSizeKB: 200 } },
            vscode.ConfigurationTarget.Global
        );
    });

    it('load 后以加载值为基线，未变的键不再写', async () => {
        const loadedConfig = makeConfig({ maxToolIterations: 10, toolsEnabled: {} });
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const storage = new VSCodeSettingsStorage();

        const loaded = await storage.load();
        expect(loaded).not.toBeNull();

        loadedConfig.update.mockClear();
        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, ui: { theme: 'dark' } } as any);

        // maxToolIterations/toolsEnabled 与加载值相同 → 只写 ui
        expect(loadedConfig.update).toHaveBeenCalledTimes(1);
        expect(loadedConfig.update).toHaveBeenCalledWith('ui', { theme: 'dark' }, vscode.ConfigurationTarget.Global);
    });

    it('键从有值变为 undefined 时仍写（删除语义保留）', async () => {
        const storage = new VSCodeSettingsStorage();
        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, activeChannelId: 'ch1' } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, activeChannelId: undefined } as any);

        expect(config.update).toHaveBeenCalledTimes(1);
        expect(config.update).toHaveBeenCalledWith('activeChannelId', undefined, vscode.ConfigurationTarget.Global);
    });
});
