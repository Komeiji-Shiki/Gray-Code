import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopWindowState, restoreWindowBounds } from '../../../apps/desktop/src/windowState';

test('拔除副屏和高缩放后，窗口回到当前逻辑工作区内', () => {
  const state = { format: 1, bounds: { x: 2200, y: 800, width: 1560, height: 980 }, maximized: true };
  expect(restoreWindowBounds(state, [{ x: 0, y: 0, width: 960, height: 600 }])).toEqual({
    bounds: { x: 0, y: 0, width: 960, height: 600 }, minWidth: 960, minHeight: 600, maximized: true,
  });
  const result = restoreWindowBounds({ ...state, bounds: { x: -1800, y: 40, width: 1400, height: 800 } }, [
    { x: 0, y: 0, width: 1920, height: 1040 }, { x: -1920, y: 0, width: 1920, height: 1040 },
  ]);
  expect(result.bounds.x).toBe(-1800);
});
test('损坏或非有限的偏好不传入窗口构造器', () => {
  const result = restoreWindowBounds({ format: 1, bounds: { x: NaN, y: 0, width: -1, height: 30 }, maximized: true }, []);
  expect(result.bounds).toEqual({ x: 180, y: 50, width: 1560, height: 980 }); expect(result.maximized).toBe(false);
});
test('连续拖动合并为最后一次偏好，关闭前可等待写入；损坏文件不阻止启动', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-window-'));
  const filename = path.join(directory, 'window.json'), report = jest.fn();
  try {
    const state = new DesktopWindowState(filename, report); await state.load();
    for (let i = 0; i < 100; i++) state.remember({ x: i, y: 20, width: 1300, height: 800 }, i === 99);
    await state.flush(); const saved = JSON.parse(await readFile(filename, 'utf8'));
    expect(saved.bounds.x).toBe(99); expect(saved.maximized).toBe(true);
    const restored = new DesktopWindowState(filename, report); await restored.load(); expect(restored.value).toEqual(saved);
    await writeFile(filename, '{'); await new DesktopWindowState(filename, report).load(); expect(report).toHaveBeenCalledTimes(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
