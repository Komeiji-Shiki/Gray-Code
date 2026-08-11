/**
 * SettingsCore.updateSettings 深合并测试
 *
 * 覆盖修复：旧实现为浅合并，传入嵌套部分对象（如 { toolsConfig: {...} }）会整体替换
 * 该键并抹掉同层其它配置；修复后为纯对象深合并（数组与原始值仍直接覆盖），
 * 与 getToolsConfigEntry 的深合并行为保持一致。
 */

import { SettingsCore } from '../../modules/settings/SettingsCore';
import { MemorySettingsStorage } from '../../modules/settings/storage';

function makeCore(): SettingsCore {
    return new SettingsCore(new MemorySettingsStorage());
}

describe('SettingsCore.updateSettings 深合并', () => {
    test('嵌套部分对象保留同层其它配置', async () => {
        const core = makeCore();
        (core.settings as any).toolsConfig = {
            write_file: { maxSizeKB: 1024, allowBinary: true },
            read_file: { maxLines: 100 }
        };
        (core.settings as any).ui = { theme: 'dark', language: 'zh-CN' };

        await core.updateSettings({ toolsConfig: { write_file: { maxSizeKB: 2048 } } } as any);

        const tc = (core.settings as any).toolsConfig;
        expect(tc.write_file.maxSizeKB).toBe(2048);       // 传入字段生效
        expect(tc.write_file.allowBinary).toBe(true);      // 同层其它字段保留
        expect(tc.read_file.maxLines).toBe(100);           // 其它键保留
        expect((core.settings as any).ui.theme).toBe('dark'); // 未涉及的顶层键不受影响
    });

    test('数组直接替换而非合并', async () => {
        const core = makeCore();
        (core.settings as any).toolsConfig = { mytool: { names: ['a', 'b'] } };

        await core.updateSettings({ toolsConfig: { mytool: { names: ['c'] } } } as any);

        expect((core.settings as any).toolsConfig.mytool.names).toEqual(['c']);
    });

    test('顶层标量更新仍直接覆盖', async () => {
        const core = makeCore();
        core.settings.maxToolIterations = 10;

        await core.updateSettings({ maxToolIterations: 20 });

        expect(core.settings.maxToolIterations).toBe(20);
    });

    test('proxy 部分更新保留已有字段', async () => {
        const core = makeCore();
        (core.settings as any).proxy = { enabled: true, url: 'http://127.0.0.1:7890' };

        await core.updateSettings({ proxy: { url: 'http://127.0.0.1:1080' } } as any);

        expect((core.settings as any).proxy.enabled).toBe(true);
        expect((core.settings as any).proxy.url).toBe('http://127.0.0.1:1080');
    });

    test('存储中保存的也是合并后的完整设置', async () => {
        const storage = new MemorySettingsStorage();
        const core = new SettingsCore(storage);
        (core.settings as any).toolsConfig = { write_file: { maxSizeKB: 1024, allowBinary: true } };

        await core.updateSettings({ toolsConfig: { write_file: { maxSizeKB: 512 } } } as any);

        const stored = await storage.load();
        expect((stored as any).toolsConfig.write_file.maxSizeKB).toBe(512);
        expect((stored as any).toolsConfig.write_file.allowBinary).toBe(true);
    });
});
