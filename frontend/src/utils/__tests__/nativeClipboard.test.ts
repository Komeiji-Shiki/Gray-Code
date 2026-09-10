import { afterEach, expect, test, vi } from 'vitest';
import { copyToClipboard } from '../format';

const originalHost = window.__GRAYCODE_HOST;
const originalClipboard = navigator.clipboard;
afterEach(() => {
  window.__GRAYCODE_HOST = originalHost;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
});

test('桌面原生复制不受浏览器剪贴板权限拒绝影响', async () => {
  const nativeCopy = vi.fn().mockResolvedValue(undefined);
  const browserCopy = vi.fn().mockRejectedValue(new Error('Write permission denied'));
  window.__GRAYCODE_HOST = { postMessage() {}, getState() {}, setState() {}, writeClipboardText: nativeCopy };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: browserCopy } });
  expect(await copyToClipboard('fixture-token')).toBe(true);
  expect(nativeCopy).toHaveBeenCalledWith('fixture-token'); expect(browserCopy).not.toHaveBeenCalled();
});
