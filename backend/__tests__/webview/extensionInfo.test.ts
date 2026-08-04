/**
 * getExtensionVersion 公共工具单元测试
 *
 * 验证 ChatViewProvider / SettingsHandlers 共用的版本读取逻辑：
 * 正常读取 package.json version；缺失 / 无 version 字段 / 损坏时回退 '0.0.0'。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getExtensionVersion } from '../../../webview/utils/extensionInfo';

describe('getExtensionVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graycode-ext-info-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('读取 package.json 中的版本号', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'graycode', version: '1.2.3' }));
    expect(getExtensionVersion(tmpDir)).toBe('1.2.3');
  });

  it('package.json 缺失时回退 0.0.0', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getExtensionVersion(tmpDir)).toBe('0.0.0');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('package.json 无 version 字段时回退 0.0.0', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'graycode' }));
    expect(getExtensionVersion(tmpDir)).toBe('0.0.0');
  });

  it('package.json 损坏时回退 0.0.0', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getExtensionVersion(tmpDir)).toBe('0.0.0');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
