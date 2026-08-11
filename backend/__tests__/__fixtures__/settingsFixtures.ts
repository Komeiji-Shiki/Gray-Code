/**
 * 测试共享 fixture：settings 系列 mock（createMemorySettingsStorage / createSettingsManager）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（清理测试代码残留）：
 * - settingsImportExport / promptAssemblyMode / reviewModeConfig / progressToolModeConfig
 *   四个测试此前各复制一份 MemorySettingsStorage 实现且行为略异：
 *   · settingsImportExport / promptAssemblyMode：save 回写内部 value（后者 value 私有）；
 *   · reviewModeConfig / progressToolModeConfig：loaded 只读、save 空操作。
 *   归一为「save 回写 + value 公开」：readonly 形状的测试只构造不保存，归一后行为不变；
 *   公开 value 兼容 settingsImportExport 对 storage.value 的直接改写断言。
 * - createSettingsManager 承接 settingsImportExport / promptAssemblyMode 各自的
 *   createManager 工厂（一个带初始配置、一个不带），形状差异由调用方保留。
 */
import type { SettingsStorage } from '../../modules/settings/SettingsManager';
import type { GlobalSettings } from '../../modules/settings/types';
import { SettingsManager } from '../../modules/settings/SettingsManager';

export function createMemorySettingsStorage(loaded: any = null): SettingsStorage & { value: any } {
    const storage: SettingsStorage & { value: any } = {
        value: loaded,
        async load() {
            return storage.value;
        },
        async save(settings: GlobalSettings) {
            storage.value = settings;
        }
    };
    return storage;
}

export function createSettingsManager(loaded?: any): SettingsManager {
    return new SettingsManager(createMemorySettingsStorage(loaded));
}
