/**
 * portableHome.test.ts - 便携版「外层目录找回」回归测试
 *
 * 覆盖：缓存目录形态判定、指针读取（缺失/损坏/不存在目录）、
 * 指针刷新、PORTABLE_EXECUTABLE_DIR 回填（含已存在时不覆盖）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PORTABLE_HOME_MARKER,
  isPortableCacheDir,
  readPortableHomeFromCache,
  persistPortableHomePointer,
  backfillPortableExecutableDir
} from '../../../electron-app/src/portable-home';

describe('isPortableCacheDir', () => {
  it('存在 gc-cache-key 标记的目录判定为便携解压缓存', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-portable-test-'));
    try {
      expect(isPortableCacheDir(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      expect(isPortableCacheDir(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readPortableHomeFromCache', () => {
  it('读取指针文件返回规范化的外层目录', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-home-test-'));
    try {
      fs.writeFileSync(path.join(cacheDir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      fs.writeFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), homeDir, 'utf8');
      expect(readPortableHomeFromCache(cacheDir)).toBe(path.resolve(homeDir));
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('非缓存目录 / 无指针 / 空指针 / 指针指向不存在的目录 → undefined', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    try {
      expect(readPortableHomeFromCache(cacheDir)).toBeUndefined();

      fs.writeFileSync(path.join(cacheDir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      expect(readPortableHomeFromCache(cacheDir)).toBeUndefined();

      fs.writeFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), '   \n', 'utf8');
      expect(readPortableHomeFromCache(cacheDir)).toBeUndefined();

      fs.writeFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), path.join(os.tmpdir(), 'gc-not-exists-xyz'), 'utf8');
      expect(readPortableHomeFromCache(cacheDir)).toBeUndefined();
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('指针指向文件而非目录 → undefined', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    const filePath = path.join(cacheDir, 'some-file.txt');
    try {
      fs.writeFileSync(path.join(cacheDir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      fs.writeFileSync(filePath, 'x', 'utf8');
      fs.writeFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), filePath, 'utf8');
      expect(readPortableHomeFromCache(cacheDir)).toBeUndefined();
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('persistPortableHomePointer', () => {
  it('写入指针文件（规范化路径）', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-home-test-'));
    try {
      fs.writeFileSync(path.join(cacheDir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      persistPortableHomePointer(cacheDir, homeDir + path.sep + '.');
      expect(fs.readFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), 'utf8')).toBe(path.resolve(homeDir));
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('非缓存目录或空 home 不写入', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    try {
      persistPortableHomePointer(dir, 'C:\\some\\home');
      expect(fs.existsSync(path.join(dir, PORTABLE_HOME_MARKER))).toBe(false);

      fs.writeFileSync(path.join(dir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      persistPortableHomePointer(dir, '');
      expect(fs.existsSync(path.join(dir, PORTABLE_HOME_MARKER))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfillPortableExecutableDir', () => {
  it('环境变量已存在（正常经启动器启动）→ 不覆盖、返回 false', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-home-test-'));
    try {
      fs.writeFileSync(path.join(cacheDir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      fs.writeFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), homeDir, 'utf8');
      const env: Record<string, string | undefined> = { PORTABLE_EXECUTABLE_DIR: 'C:\\real-home' };
      expect(backfillPortableExecutableDir(cacheDir, env)).toBe(false);
      expect(env.PORTABLE_EXECUTABLE_DIR).toBe('C:\\real-home');
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('环境变量缺失（任务栏固定直启内层 exe）→ 从指针回填、返回 true', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-home-test-'));
    try {
      fs.writeFileSync(path.join(cacheDir, 'gc-cache-key'), 'abc\r\n', 'utf8');
      fs.writeFileSync(path.join(cacheDir, PORTABLE_HOME_MARKER), homeDir, 'utf8');
      const env: Record<string, string | undefined> = {};
      expect(backfillPortableExecutableDir(cacheDir, env)).toBe(true);
      expect(env.PORTABLE_EXECUTABLE_DIR).toBe(path.resolve(homeDir));
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('无指针/非缓存目录 → 返回 false、不写入环境变量', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cache-test-'));
    try {
      const env: Record<string, string | undefined> = {};
      expect(backfillPortableExecutableDir(dir, env)).toBe(false);
      expect(env.PORTABLE_EXECUTABLE_DIR).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
