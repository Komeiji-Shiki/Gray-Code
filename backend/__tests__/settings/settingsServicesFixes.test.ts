/**
 * 设置模块回归测试：
 * 1. ProxySettingsService.updateProxySettings：不再强制默认 enabled:true
 * 2. FileSettingsStorage.load：损坏 JSON 抛错（含文件路径），不静默归零
 * 3. PromptSettingsService.savePromptMode：校验 mode.id 非空字符串
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SettingsCore } from '../../modules/settings/SettingsCore';
import { ProxySettingsService } from '../../modules/settings/ProxySettingsService';
import { FileSettingsStorage, MemorySettingsStorage } from '../../modules/settings/storage';
import { PromptSettingsService } from '../../modules/settings/PromptSettingsService';

describe('ProxySettingsService.updateProxySettings', () => {
    test('首次只设置 URL 不会隐式启用代理', async () => {
        const core = new SettingsCore(new MemorySettingsStorage());
        const svc = new ProxySettingsService(core);

        await svc.setProxyUrl('http://127.0.0.1:7890');

        expect(core.settings.proxy?.enabled).toBe(false);
        expect(core.settings.proxy?.url).toBe('http://127.0.0.1:7890');
        expect(svc.getEffectiveProxyUrl()).toBeUndefined();
    });

    test('已启用后更新 URL 保留 enabled 状态', async () => {
        const core = new SettingsCore(new MemorySettingsStorage());
        const svc = new ProxySettingsService(core);

        await svc.setProxyEnabled(true);
        await svc.setProxyUrl('http://127.0.0.1:7890');

        expect(core.settings.proxy?.enabled).toBe(true);
        expect(svc.getEffectiveProxyUrl()).toBe('http://127.0.0.1:7890');
    });

    test('显式传入 enabled 时以传入值为准', async () => {
        const core = new SettingsCore(new MemorySettingsStorage());
        const svc = new ProxySettingsService(core);

        await svc.updateProxySettings({ enabled: true, url: 'http://x' });
        expect(core.settings.proxy?.enabled).toBe(true);

        await svc.updateProxySettings({ enabled: false });
        expect(core.settings.proxy?.enabled).toBe(false);
        expect(core.settings.proxy?.url).toBe('http://x');
    });
});

describe('FileSettingsStorage.load', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-load-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('文件不存在返回 null（全新安装）', async () => {
        const storage = new FileSettingsStorage(dir);
        await expect(storage.load()).resolves.toBeNull();
    });

    test('有效 JSON 正常解析', async () => {
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lastUpdated: 123 }));
        const storage = new FileSettingsStorage(dir);
        await expect(storage.load()).resolves.toEqual({ lastUpdated: 123 });
    });

    test('损坏 JSON 抛错并包含文件路径，坏文件不被覆盖', async () => {
        const filePath = path.join(dir, 'settings.json');
        fs.writeFileSync(filePath, '{broken json');
        const storage = new FileSettingsStorage(dir);

        await expect(storage.load()).rejects.toThrow(filePath);
        // 坏文件保持原样，不会静默归零后被保存覆盖
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('{broken json');
    });
});

describe('PromptSettingsService.savePromptMode', () => {
    function createService(): { core: SettingsCore; svc: PromptSettingsService } {
        const core = new SettingsCore(new MemorySettingsStorage());
        return { core, svc: new PromptSettingsService(core) };
    }

    const validModeBase = {
        name: 'X',
        template: 't',
        dynamicTemplateEnabled: false,
        dynamicTemplate: '',
    };

    test('空/纯空白/缺失 id 拒绝保存并抛错', async () => {
        const { svc } = createService();
        await expect(svc.savePromptMode({ id: '', ...validModeBase } as any)).rejects.toThrow('Mode id is required');
        await expect(svc.savePromptMode({ id: '   ', ...validModeBase } as any)).rejects.toThrow('Mode id is required');
        await expect(svc.savePromptMode({ ...validModeBase } as any)).rejects.toThrow('Mode id is required');

        // 不写入 "undefined" 键的模式
        const config = svc.getSystemPromptConfig();
        expect(config.modes?.['undefined']).toBeUndefined();
    });

    test('合法 id 正常保存', async () => {
        const { svc } = createService();
        await svc.savePromptMode({ id: 'custom', ...validModeBase } as any);

        const config = svc.getSystemPromptConfig();
        expect(config.modes?.['custom']).toBeDefined();
        expect(config.modes?.['custom']?.name).toBe('X');
        expect(config.modes?.['undefined']).toBeUndefined();
    });
});
