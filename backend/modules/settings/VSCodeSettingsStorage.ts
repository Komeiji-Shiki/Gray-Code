/**
 * GrayCode - VS Code Settings 存储实现
 *
 * 将 GrayCode 的“设置类配置”存入 VS Code Settings（workspace.getConfiguration），
 * 从而支持 Settings Sync。
 *
 * - 可同步配置：使用默认 scope（会参与 Settings Sync）
 * - 机器相关配置：在 package.json 中声明 scope: "machine"（不会参与 Settings Sync）
 *
 * 同时提供从旧版 settings/settings.json（globalStorage 下）的一次性迁移。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

// 从 SettingsCore 导入避免与 SettingsManager 形成循环依赖（与 storage.ts 口径一致；
// SettingsStorage 接口定义在 SettingsCore.ts，SettingsManager 仅 re-export 该类型）
import type { SettingsStorage } from './SettingsCore';
import type { GlobalSettings } from './types';
import { t } from '../../i18n';
import { deepEqual } from '../../core/deepEqual';

export interface VSCodeSettingsStorageOptions {
    /**
     * 旧版基于文件的 settings 目录（例如：context.globalStorageUri.fsPath/settings）
     *
     * 用于升级迁移。
     */
    legacySettingsDir?: string;

    /** 是否尝试从旧文件迁移（默认 true） */
    enableLegacyMigration?: boolean;

    /** 迁移成功后是否将旧文件重命名为 .bak（默认 true） */
    backupLegacyFile?: boolean;
}

const GRAYCODE_CONFIG_SECTION = 'graycode';

// 这些 key 参与 Settings Sync（默认 scope）
const SYNCABLE_KEYS = [
    'toolsConfig',
    'ui',
    'toolsEnabled',
    'toolAutoExec',
    'maxToolIterations',
    'defaultToolMode',
    'activeChannelId',
    'lastReadAnnouncementVersion',
    'checkForUpdates',
    'updateChannel'
] as const;

// 这些 key 应在 package.json 中声明 scope: "machine"
const MACHINE_KEYS = ['proxy', 'storagePath'] as const;

type SyncableKey = typeof SYNCABLE_KEYS[number];
type MachineKey = typeof MACHINE_KEYS[number];

type ConfigKey = SyncableKey | MachineKey;

/** save 时需要同步的全部配置键（syncable + machine） */
export const ALL_CONFIG_KEYS: readonly ConfigKey[] = [...SYNCABLE_KEYS, ...MACHINE_KEYS];

// 深比较使用 core/deepEqual（与 SettingsCore.notifySystemPromptChangeIfNeeded 共用同一实现），
// 用于 save 时判断某键是否真的变化，避免无谓的 config.update 与 Settings Sync。

/**
 * 深拷贝配置值（快照用）。
 *
 * 缺陷修复：save() 的快照此前直接保存活对象引用——保存成功后对同一对象的任何
 * 原地变更（如 `settings.toolAutoExec[tool] = x`、`settings.toolsConfig[k] = v`）
 * 都会被 deepEqual 的 `a === b` 引用短路误判为「无变化」而跳过写盘，
 * 表现为「自动执行 / 工具策略等嵌套配置重启后丢失」。快照必须与活对象解耦。
 */
function deepCloneValue(value: unknown): unknown {
    if (value === undefined) return undefined;
    try {
        return structuredClone(value);
    } catch {
        // 非常规对象（函数等）回退 JSON 往返；快照仅用于 diff，丢失原型可接受
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }
}

export class VSCodeSettingsStorage implements SettingsStorage {
    private options: Required<VSCodeSettingsStorageOptions>;

    /** 上次成功保存/加载的配置快照（键 → 值），save 时据此只写变更的键 */
    private lastSavedSnapshot: Record<string, unknown> = {};

    /**
     * save 串行队列：save() 对 lastSavedSnapshot 的「读旧快照 → 写盘 → 更新快照」
     * 无互斥，并发 save 会让先完成的 save 用旧快照覆盖后写入的键，或快照与磁盘不一致。
     * 整段入队串行执行（参考 SettingsCore.serializeMutation 的链式队列）。
     */
    private saveQueue: Promise<void> = Promise.resolve();

    constructor(options: VSCodeSettingsStorageOptions = {}) {
        this.options = {
            legacySettingsDir: options.legacySettingsDir!,
            enableLegacyMigration: options.enableLegacyMigration ?? true,
            backupLegacyFile: options.backupLegacyFile ?? true
        };
    }

    async load(): Promise<GlobalSettings | null> {
        const config = vscode.workspace.getConfiguration(GRAYCODE_CONFIG_SECTION);

        const hasAnySyncable = this.hasAnyUserValue(config, SYNCABLE_KEYS);
        const hasAnyMachine = this.hasAnyUserValue(config, MACHINE_KEYS);

        // 如果没有任何（可同步）配置，优先尝试从旧文件迁移
        if (!hasAnySyncable && this.options.enableLegacyMigration) {
            const migrated = await this.tryMigrateFromLegacyFile(config, hasAnyMachine);
            if (migrated) {
                return migrated;
            }
        }

        // 如果用户没有设置过任何 graycode.*（包括 machine），返回 null 让 SettingsManager 使用默认值
        if (!hasAnySyncable && !hasAnyMachine) {
            return null;
        }

        const settings = this.readSettingsFromVSCode(config, {
            includeSyncable: true,
            includeMachine: true
        });
        // 以实际加载值为快照基线：外部编辑 / Settings Sync 拉取的值不会被后续未变更键覆盖
        this.lastSavedSnapshot = this.buildSnapshot(settings);
        return settings;
    }

    /** 从设置对象提取全部配置键的快照（值做深拷贝，与活对象解耦，见 deepCloneValue） */
    private buildSnapshot(settings: GlobalSettings): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};
        const source = settings as unknown as Record<string, unknown>;
        for (const key of ALL_CONFIG_KEYS) {
            snapshot[key] = deepCloneValue(source[key]);
        }
        return snapshot;
    }

    async save(settings: GlobalSettings): Promise<void> {
        const run = this.saveQueue.then(async () => {
            const config = vscode.workspace.getConfiguration(GRAYCODE_CONFIG_SECTION);

            try {
                // 修改原因：旧实现每次保存都把全部 graycode.* 键全量 config.update 一遍，
                // 包括庞大的 toolsConfig，触发多次写入与 Settings Sync 全量同步。
                // 修改方式：与上次快照（上次保存/加载的结果）逐键深比较，只写变更的键；
                // 全部未变更时不产生任何 config.update。
                // 已知边界（有意保留）：首次保存时 lastSavedSnapshot 为空快照，所有有值的键
                // （含与 DEFAULT_GLOBAL_SETTINGS 相同的默认值，如默认 toolsConfig、checkForUpdates
                // 等）都会被判为「变更」写入磁盘——即「首次 save 固化默认值」。这是有意行为：
                // 读取路径 initialize/reloadAndNotify 用 DEFAULT_GLOBAL_SETTINGS 深合并兜底，
                // 固化值与内存默认值一致、功能等价；代价是扩展升级修改默认值后，已固化键不会
                // 自动跟随新默认值（用户值优先语义）。若未来要过滤「与默认值全等」的键，需在
                // SettingsCore 保存路径统一处理并与 deepMergeConfig 语义对齐，此处不做。
                const updates: PromiseLike<void>[] = [];
                const nextSnapshot: Record<string, unknown> = {};
                const source = settings as unknown as Record<string, unknown>;

                for (const key of ALL_CONFIG_KEYS) {
                    const value = source[key];
                    if (deepEqual(value, this.lastSavedSnapshot[key])) {
                        // 未变更：快照沿用上次的深拷贝（已与活对象解耦），避免全量 structuredClone
                        nextSnapshot[key] = this.lastSavedSnapshot[key];
                        continue;
                    }
                    // 仅对变更键做深拷贝快照：与活对象解耦，后续原地变更才能被 deepEqual 检出
                    nextSnapshot[key] = deepCloneValue(value);
                    updates.push(config.update(key, value, this.resolveSaveTarget(config, key)));
                }

                // 仍使用 Promise.all 并行写入，减小更新期间处于不一致状态的时间窗口
                await Promise.all(updates);

                // 写入成功后才更新快照；部分失败时不记录，下次保存会重试全部变更键
                this.lastSavedSnapshot = nextSnapshot;
            } catch (error) {
                console.error('[VSCodeSettingsStorage] Failed to save settings:', error);
                throw new Error(`${t('modules.settings.errors.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        // 链尾吞掉本次错误（调用方仍从 run 拿到真实结果），防止单次失败阻塞后续写
        this.saveQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /**
     * save 写入目标层级：工作区（含 folder）层已有用户显式值时跟随写入 Workspace 层
     * （.vscode/settings.json / .code-workspace），否则写 Global。
     *
     * 读侧保持 VS Code 合并值语义（workspaceFolder > workspace > global）：工作区显式配置
     * 优先是 VS Code 惯例，不能因 save 只写 Global 而破坏。若 save 一律写 Global 而读合并值，
     * 工作区中的旧 graycode.* 键会永久吞掉设置页修改；跟随已有层级写入后，设置页修改落在
     * 最高优先级层、读回必然生效，workspace 显式配置的覆盖语义也保留（无 workspace 值时
     * 仍写 Global）。
     * 已知边界：多根工作区仅 folder 层有值时写 Workspace 层无法覆盖 folder 值（冷门组合，
     * 保持与 VS Code 层级语义一致，不额外处理）。
     */
    private resolveSaveTarget(config: vscode.WorkspaceConfiguration, key: string): vscode.ConfigurationTarget {
        const inspected = config.inspect(key);
        if (inspected && (inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined)) {
            return vscode.ConfigurationTarget.Workspace;
        }
        return vscode.ConfigurationTarget.Global;
    }

    private readSettingsFromVSCode(
        config: vscode.WorkspaceConfiguration,
        opts: { includeSyncable: boolean; includeMachine: boolean }
    ): GlobalSettings {
        // 注意：这里返回的是“部分 settings”。
        // SettingsManager.initialize() 会与 DEFAULT_GLOBAL_SETTINGS 做合并。
        const settings: Partial<GlobalSettings> = {};

        if (opts.includeSyncable) {
            settings.toolsConfig = config.get('toolsConfig');
            settings.ui = config.get('ui');
            settings.toolsEnabled = config.get('toolsEnabled');
            settings.toolAutoExec = config.get('toolAutoExec');
            settings.maxToolIterations = config.get('maxToolIterations');

            const defaultToolMode = config.get<string>('defaultToolMode');
            if (defaultToolMode === 'function_call' || defaultToolMode === 'xml' || defaultToolMode === 'json') {
                settings.defaultToolMode = defaultToolMode;
            }

            const activeChannelId = config.get<string>('activeChannelId');
            settings.activeChannelId = activeChannelId && activeChannelId.trim() ? activeChannelId : undefined;

            const lastReadAnnouncementVersion = config.get<string>('lastReadAnnouncementVersion');
            settings.lastReadAnnouncementVersion = lastReadAnnouncementVersion && lastReadAnnouncementVersion.trim()
                ? lastReadAnnouncementVersion
                : undefined;

            const checkForUpdates = config.get<boolean>('checkForUpdates');
            if (typeof checkForUpdates === 'boolean') {
                settings.checkForUpdates = checkForUpdates;
            }

            const updateChannel = config.get<string>('updateChannel');
            if (updateChannel === 'stable' || updateChannel === 'nightly') {
                settings.updateChannel = updateChannel;
            }
        }

        if (opts.includeMachine) {
            settings.proxy = config.get('proxy');
            settings.storagePath = config.get('storagePath');
        }

        // toolsEnabled 在类型上是必填字段（但这里可能为 undefined），兜底给空对象
        return {
            toolsEnabled: settings.toolsEnabled ?? {},
            lastUpdated: Date.now(),
            ...(settings as any)
        };
    }

    private hasAnyUserValue<T extends readonly ConfigKey[]>(
        config: vscode.WorkspaceConfiguration,
        keys: T
    ): boolean {
        for (const key of keys) {
            const inspected = config.inspect(key);
            if (!inspected) {
                continue;
            }

            // 只要用户在任意层级设置过（global/workspace/workspaceFolder），就认为“有值”
            if (
                inspected.globalValue !== undefined ||
                inspected.workspaceValue !== undefined ||
                inspected.workspaceFolderValue !== undefined
            ) {
                return true;
            }
        }
        return false;
    }

    private async tryMigrateFromLegacyFile(
        config: vscode.WorkspaceConfiguration,
        preserveExistingMachineValues: boolean
    ): Promise<GlobalSettings | null> {
        if (!this.options.legacySettingsDir) {
            return null;
        }

        const legacyFile = path.join(this.options.legacySettingsDir, 'settings.json');

        let legacyContent: string;
        try {
            legacyContent = await fs.readFile(legacyFile, 'utf-8');
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return null;
            }
            console.error('[VSCodeSettingsStorage] Failed to read legacy settings file:', error);
            // 向用户显示警告，给予手动恢复的机会
            vscode.window.showWarningMessage(
                `GrayCode: 读取旧版设置文件失败，配置可能无法迁移。请检查文件: ${legacyFile}`
            );
            return null;
        }

        let legacySettings: GlobalSettings;
        try {
            legacySettings = JSON.parse(legacyContent);
        } catch (error) {
            console.error('[VSCodeSettingsStorage] Failed to parse legacy settings file:', error);
            // 向用户显示警告
            vscode.window.showWarningMessage(
                `GrayCode: 解析旧版设置文件失败(JSON Error)，配置可能无法迁移。请检查文件: ${legacyFile}`
            );
            return null;
        }

        // 如果用户已经设置过 machine 配置，迁移时不覆盖（例如 proxy 不同机器端口不同）
        if (preserveExistingMachineValues) {
            const current = this.readSettingsFromVSCode(config, { includeSyncable: false, includeMachine: true });
            legacySettings = {
                ...legacySettings,
                proxy: current.proxy ?? legacySettings.proxy,
                storagePath: current.storagePath ?? legacySettings.storagePath
            };
        }

        // 写入 VS Code Settings
        await this.save(legacySettings);

        // 迁移成功后备份旧文件，避免重复迁移/歧义
        if (this.options.backupLegacyFile) {
            await this.backupLegacySettingsFileSafely(legacyFile);
        }

        console.log('[VSCodeSettingsStorage] Migrated legacy settings to VS Code Settings:', legacyFile);
        return legacySettings;
    }

    private async backupLegacySettingsFileSafely(legacyFile: string): Promise<void> {
        const bakFile = legacyFile + '.bak';

        try {
            // 如果已经存在备份，则不重复备份
            try {
                await fs.access(bakFile);
                return;
            } catch {
                // ignore
            }

            await fs.rename(legacyFile, bakFile);
        } catch (error) {
            // rename 在跨设备或权限受限时可能失败：退化为 copy + 保留原文件
            try {
                const content = await fs.readFile(legacyFile);
                await fs.writeFile(bakFile, content);
            } catch (e) {
                console.warn('[VSCodeSettingsStorage] Failed to backup legacy settings file:', e);
            }
        }
    }
}

