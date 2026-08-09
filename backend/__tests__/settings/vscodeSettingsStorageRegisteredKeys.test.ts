/**
 * VSCodeSettingsStorage 配置键注册校验
 *
 * 背景：VS Code 的 `workspace.getConfiguration().update()` 对**未在 package.json
 * `contributes.configuration.properties` 中声明的键**会直接 reject（"is not a registered
 * configuration"）。VSCodeSettingsStorage.save() 用 Promise.all 并发写所有变更键——
 * 已声明键（如 toolsConfig）先成功落盘、未声明键（如曾缺失的 checkForUpdates）抛错，
 * 表现为「保存报失败但数据实际已写入」（保存提示词误报失败的根因）。
 *
 * 本测试锁定：ALL_CONFIG_KEYS 中的每个键都必须已在 package.json 注册，防止再次出现
 * 「往 SYNCABLE_KEYS 加键忘声明」导致所有设置保存失败的回归。
 */

import * as path from 'path';
import * as fs from 'fs';
import { ALL_CONFIG_KEYS } from '../../modules/settings/VSCodeSettingsStorage';

const PACKAGE_JSON_PATH = path.resolve(__dirname, '../../../package.json');

describe('VSCodeSettingsStorage 配置键注册校验', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    const registered = new Set<string>(
        Object.keys(pkg?.contributes?.configuration?.properties ?? {})
    );

    it('package.json 声明了 graycode.checkForUpdates（保存失败的根因键）', () => {
        expect(registered.has('graycode.checkForUpdates')).toBe(true);
    });

    it('ALL_CONFIG_KEYS 中的每个键都已在 package.json 注册', () => {
        const missing = ALL_CONFIG_KEYS.filter(key => !registered.has(`graycode.${key}`));
        expect(missing).toEqual([]);
    });

    it('注册表包含全部 syncable + machine 键', () => {
        // 防止 ALL_CONFIG_KEYS 被误改（少一个键会导致该键永不同步）
        expect(ALL_CONFIG_KEYS).toEqual([
            'toolsConfig',
            'ui',
            'toolsEnabled',
            'toolAutoExec',
            'maxToolIterations',
            'defaultToolMode',
            'activeChannelId',
            'lastReadAnnouncementVersion',
            'checkForUpdates',
            'updateChannel',
            'proxy',
            'storagePath'
        ]);
    });
});
