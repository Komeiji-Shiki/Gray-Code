/**
 * 文件系统大小写敏感性探测测试
 *
 * 覆盖：
 * - win32 恒为大小写不敏感（不探测）
 * - 真实目录探测：变体路径与原路径解析到同一文件 → 不敏感；否则敏感
 * - 样本路径不存在时保守判定为敏感（无法确认不敏感）
 * - 探测样本缺失时回退平台默认（win32 不敏感 / darwin 不敏感 / 其他敏感）
 * - 进程级共享口径：有效样本探测一次后固定，后续调用不再重探
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  probePathCaseSensitivity,
  detectFsCaseSensitivity,
  getFsCaseSensitivity,
} from '../../../webview/utils/fsCaseSensitivity';

const realPlatform = process.platform;

/** 切换路径中最后一个字母的大小写（与实现一致的变体构造，仅用于断言） */
function toggleLastLetter(p: string): string {
  for (let i = p.length - 1; i >= 0; i--) {
    const ch = p[i];
    const toggled = ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : '';
    if (toggled) {
      return p.slice(0, i) + toggled + p.slice(i + 1);
    }
  }
  return p;
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('detectFsCaseSensitivity（平台短路）', () => {
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('win32 恒为大小写不敏感（不做任何探测）', () => {
    withPlatform('win32', () => {
      expect(detectFsCaseSensitivity(undefined)).toBe(false);
      // 即使样本路径不存在也不走探测，直接不敏感
      expect(detectFsCaseSensitivity('Z:\\no\\such\\dir\\123')).toBe(false);
    });
  });

  it('无样本路径时回退平台默认：darwin 不敏感、linux 敏感', () => {
    withPlatform('darwin', () => {
      expect(detectFsCaseSensitivity(undefined)).toBe(false);
    });
    withPlatform('linux', () => {
      expect(detectFsCaseSensitivity(undefined)).toBe(true);
    });
  });
});

describe('probePathCaseSensitivity / detectFsCaseSensitivity（真实目录探测）', () => {
  it('探测结果与“变体路径是否解析到同一文件”一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'CaseProbe'));
    try {
      const result = detectFsCaseSensitivity(dir);
      const variant = toggleLastLetter(dir);
      // 变体存在且与原路径同一 inode → 大小写不敏感；否则敏感
      let variantResolvesSameFile = false;
      if (fs.existsSync(variant)) {
        const a = fs.statSync(dir);
        const b = fs.statSync(variant);
        variantResolvesSameFile = a.dev === b.dev && a.ino === b.ino;
      }
      expect(result).toBe(!variantResolvesSameFile);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全数字路径（无字母可切换）返回 undefined（回退平台默认）', () => {
    const result = probePathCaseSensitivity('/123/456/789');
    expect(result).toBeUndefined();
  });

  if (realPlatform !== 'win32') {
    it('样本路径不存在时保守判定为大小写敏感（无法确认不敏感）', () => {
      expect(detectFsCaseSensitivity('/no/such/dir/abc')).toBe(true);
    });
  }
});

describe('getFsCaseSensitivity（进程级共享口径）', () => {
  it('空样本返回平台默认且不缓存：后续有效样本仍会重新探测', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'CaseProbeCache'));
    try {
      // 先以空样本调用（不缓存），再用真实目录调用——应完成探测
      getFsCaseSensitivity(undefined);
      const probed = getFsCaseSensitivity(dir);
      expect(typeof probed).toBe('boolean');
      // 真实目录探测结果与该目录的变体存在性一致（win32 下恒为 false）
      const variant = toggleLastLetter(dir);
      if (realPlatform === 'win32') {
        expect(probed).toBe(false);
      } else {
        expect(probed).toBe(!(fs.existsSync(variant) && fs.statSync(variant).ino === fs.statSync(dir).ino));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('有效样本探测一次后口径固定（后续调用一致，不再回退平台默认）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'CaseProbeFixed'));
    try {
      const first = getFsCaseSensitivity(dir);
      // 已探测：后续无样本/不同样本调用必须返回同一口径
      expect(getFsCaseSensitivity(undefined)).toBe(first);
      expect(getFsCaseSensitivity('/another/sample/path')).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
