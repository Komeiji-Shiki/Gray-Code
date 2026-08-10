/**
 * VSCodeSettingsStorage machine 作用域键读写校验
 *
 * 背景：远程控制（remoteControl）加入 MACHINE_KEYS 后曾出现「save 写入但
 * readSettingsFromVSCode 不读回」的断链——桌面端重启后开关/端口全部丢失。
 * 本测试锁定 machine 键（proxy/storagePath/remoteControl）的读回路径，
 * 防止新增 machine 键时漏读。
 */

import { VSCodeSettingsStorage } from '../../modules/settings/VSCodeSettingsStorage';

function createStorage(): VSCodeSettingsStorage {
  return new VSCodeSettingsStorage({ legacySettingsDir: undefined } as any);
}

/** 构造最小可用 WorkspaceConfiguration mock */
function createConfig(values: Record<string, unknown>): any {
  return {
    get: (key: string) => values[key],
    inspect: (key: string) => ({ key, globalValue: values[key] }),
    update: jest.fn().mockResolvedValue(undefined)
  };
}

describe('VSCodeSettingsStorage machine 作用域键读取', () => {
  it('readSettingsFromVSCode 读回 remoteControl（与 proxy/storagePath 同级）', () => {
    const storage = createStorage();
    const config = createConfig({
      proxy: { enabled: true, url: 'http://127.0.0.1:7890' },
      storagePath: { customDataPath: 'D:\\data' },
      remoteControl: { enabled: true, port: 19999 }
    });

    const loaded = (storage as any).readSettingsFromVSCode(config, {
      includeSyncable: true,
      includeMachine: true
    });

    expect(loaded.remoteControl).toEqual({ enabled: true, port: 19999 });
    expect(loaded.proxy).toEqual({ enabled: true, url: 'http://127.0.0.1:7890' });
    expect(loaded.storagePath).toEqual({ customDataPath: 'D:\\data' });
  });

  it('未配置 remoteControl 时读取为 undefined（合并默认值兜底）', () => {
    const storage = createStorage();
    const config = createConfig({});
    const loaded = (storage as any).readSettingsFromVSCode(config, {
      includeSyncable: true,
      includeMachine: true
    });
    expect(loaded.remoteControl).toBeUndefined();
    expect(loaded.proxy).toBeUndefined();
  });
});
