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

function makeConfig(initial: Record<string, unknown> = {}, workspaceInitial: Record<string, unknown> = {}): FakeConfig {
    const stored = new Map<string, unknown>(Object.entries(initial));
    const workspaceStored = new Map<string, unknown>(Object.entries(workspaceInitial));
    return {
        _stored: stored,
        // get 保留 workspace 兜底语义（与 vscode 合并值口径一致）；load 已改用 inspect 优先 Global
        get: jest.fn((key: string) => stored.get(key) ?? workspaceStored.get(key)),
        inspect: jest.fn((key: string) => {
            if (!stored.has(key) && !workspaceStored.has(key)) {
                return undefined;
            }
            return {
                globalValue: stored.get(key),
                workspaceValue: workspaceStored.get(key),
                workspaceFolderValue: undefined
            };
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

    test('首次保存只写有值的键（快照为空时未定义键不写）', async () => {
        const storage = new VSCodeSettingsStorage();

        await storage.save({ toolsEnabled: {}, maxToolIterations: 10 } as any);

        // 快照为空：只有值非 undefined 的键算"变更"；其余键不触发 config.update
        expect(config.update).toHaveBeenCalledTimes(2);
        expect(config.update).toHaveBeenCalledWith('toolsEnabled', {}, vscode.ConfigurationTarget.Global);
        expect(config.update).toHaveBeenCalledWith('maxToolIterations', 10, vscode.ConfigurationTarget.Global);
    });

    test('第二次保存只写变更的键', async () => {
        const storage = new VSCodeSettingsStorage();
        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, ui: { theme: 'dark' } } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, maxToolIterations: 20, ui: { theme: 'dark' } } as any);

        expect(config.update).toHaveBeenCalledTimes(1);
        expect(config.update).toHaveBeenCalledWith('maxToolIterations', 20, vscode.ConfigurationTarget.Global);
    });

    test('toolsConfig 深相等（新对象同内容）时不重复写', async () => {
        const storage = new VSCodeSettingsStorage();
        const toolsConfig = { write_file: { maxSizeKB: 100 } };
        await storage.save({ toolsEnabled: {}, toolsConfig } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, toolsConfig: { ...toolsConfig } } as any);

        expect(config.update).not.toHaveBeenCalled();
    });

    test('toolsConfig 内容变化时只写该键', async () => {
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

    test('load 后以加载值为基线，未变的键不再写', async () => {
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

    test('键从有值变为 undefined 时仍写（删除语义保留）', async () => {
        const storage = new VSCodeSettingsStorage();
        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, activeChannelId: 'ch1' } as any);
        config.update.mockClear();

        await storage.save({ toolsEnabled: {}, maxToolIterations: 10, activeChannelId: undefined } as any);

        expect(config.update).toHaveBeenCalledTimes(1);
        expect(config.update).toHaveBeenCalledWith('activeChannelId', undefined, vscode.ConfigurationTarget.Global);
    });

    // ===== 回归：快照引用缺陷（自动执行 / 工具策略 / 预设条目开关重启丢失） =====
    // 旧实现把活对象引用存入 lastSavedSnapshot，保存成功后同一对象的原地变更会被
    // deepEqual 的 a===b 短路误判为「无变化」而跳过写盘。以下用例必须先 load（拿到
    // 基线），再对同一 settings 引用做两次原地变更，断言每次都触发写盘。

    test('回归：load 后原地改 toolAutoExec 两次，每次都写盘（自动执行开关持久化）', async () => {
        const loadedConfig = makeConfig({
            toolAutoExec: { delete_file: false },
            toolsEnabled: {},
            toolsConfig: {},
        });
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const storage = new VSCodeSettingsStorage();
        await storage.load();

        const settings = {
            toolsEnabled: {},
            toolAutoExec: { delete_file: false },
            toolsConfig: {},
        } as any;

        // 第一次原地变更（首次写盘成功，快照必须与活对象解耦）
        settings.toolAutoExec['execute_command'] = true;
        await storage.save(settings);
        expect(loadedConfig.update).toHaveBeenCalledTimes(1);
        expect(loadedConfig.update).toHaveBeenCalledWith(
            'toolAutoExec',
            { delete_file: false, execute_command: true },
            vscode.ConfigurationTarget.Global
        );

        // 第二次原地变更（快照若存引用，此处会被跳过 → 丢失）
        loadedConfig.update.mockClear();
        settings.toolAutoExec['write_file'] = true;
        await storage.save(settings);
        expect(loadedConfig.update).toHaveBeenCalledTimes(1);
        expect(loadedConfig.update).toHaveBeenCalledWith(
            'toolAutoExec',
            { delete_file: false, execute_command: true, write_file: true },
            vscode.ConfigurationTarget.Global
        );
    });

    test('回归：load 后原地改 toolsConfig 嵌套（toolPolicy / promptEntries.enabled），每次写盘', async () => {
        const initialToolsConfig = {
            system_prompt: {
                modes: {
                    code: { id: 'code', toolPolicy: ['read_file'] },
                },
            },
        };
        const loadedConfig = makeConfig({ toolsConfig: initialToolsConfig, toolsEnabled: {} });
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const storage = new VSCodeSettingsStorage();
        await storage.load();

        const settings = {
            toolsEnabled: {},
            toolsConfig: {
                system_prompt: {
                    modes: {
                        code: { id: 'code', toolPolicy: ['read_file'] },
                    },
                },
            },
        } as any;

        // 原地改工具策略
        settings.toolsConfig.system_prompt.modes.code.toolPolicy = ['read_file', 'write_file'];
        await storage.save(settings);
        expect(loadedConfig.update).toHaveBeenCalledTimes(1);

        // 原地改预设条目开关（同一引用再改一次）
        loadedConfig.update.mockClear();
        settings.toolsConfig.system_prompt.modes.code.promptEntries = [
            { id: 'e1', name: 'P1', type: 'prompt', enabled: false, role: 'system', content: 'x', order: 0 },
        ];
        await storage.save(settings);
        expect(loadedConfig.update).toHaveBeenCalledTimes(1);
        expect(loadedConfig.update).toHaveBeenCalledWith(
            'toolsConfig',
            settings.toolsConfig,
            vscode.ConfigurationTarget.Global
        );
    });

    test('回归：重启模拟——新实例 load 读回原地变更后的最新值', async () => {
        const loadedConfig = makeConfig({
            toolAutoExec: { delete_file: false, execute_command: true },
            toolsEnabled: {},
            toolsConfig: {},
        });
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const storage = new VSCodeSettingsStorage();
        await storage.load();

        const settings = { toolsEnabled: {}, toolAutoExec: { delete_file: false, execute_command: true }, toolsConfig: {} } as any;
        settings.toolAutoExec['write_file'] = true;
        await storage.save(settings);

        // 模拟重启：新 storage 实例 + 同一持久化配置源（fake config 的存储已被 update 更新），
        // 必须读回 write_file: true
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const restarted = new VSCodeSettingsStorage();
        const loaded = await restarted.load();
        expect((loaded as any).toolAutoExec).toEqual({
            delete_file: false,
            execute_command: true,
            write_file: true,
        });
    });

    // ===== 回归：workspace 级旧 graycode.* 不吞设置页修改（save 写 Global，load 优先 Global） =====

    test('workspace 有旧值 + 用户已改 Global：load 读回 Global 而非 workspace 旧值', async () => {
        // 场景：.vscode/settings.json 有旧 graycode.toolsConfig；用户在设置页修改后 save 写入
        // Global（新旧值不同）。load 若读合并值会取 workspace 旧值，修改“看起来丢失”；
        // 修复后读优先 Global，设置页修改一定生效。
        const workspaceOld = { write_file: { maxSizeKB: 100 } };
        const globalNew = { write_file: { maxSizeKB: 999 } };
        const loadedConfig = makeConfig(
            { toolsConfig: globalNew, toolsEnabled: {} },
            { toolsConfig: workspaceOld }
        );
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const storage = new VSCodeSettingsStorage();

        const loaded = await storage.load();

        expect((loaded as any).toolsConfig).toEqual(globalNew);
    });

    test('Global 未设置时 workspace 值仍作为 fallback 生效', async () => {
        const workspaceValue = { write_file: { maxSizeKB: 100 } };
        const loadedConfig = makeConfig({ toolsEnabled: {} }, { toolsConfig: workspaceValue });
        (vscode.workspace as any).getConfiguration = jest.fn(() => loadedConfig);
        const storage = new VSCodeSettingsStorage();

        const loaded = await storage.load();

        expect((loaded as any).toolsConfig).toEqual(workspaceValue);
    });
});
