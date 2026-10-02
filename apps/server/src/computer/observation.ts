import type { ComputerObservation, ComputerWindow, ComputerWindows } from '@graycode/contracts';

export interface ComputerWindowFilter { processId?: number; processName?: string; title?: string; compact?: boolean }

/** 可执行文件名，不含目录，用于筛选和精简列表。 */
export function processNameOf(window: Pick<ComputerWindow, 'executable'>) {
  const executable = window.executable ?? '';
  return executable ? executable.slice(Math.max(executable.lastIndexOf('\\'), executable.lastIndexOf('/')) + 1) : undefined;
}

/** 只筛选和精简发给模型的窗口列表；界面仍通过 computer.windows 读取完整字段。 */
export function windowsForModel(value: ComputerWindows, filter: ComputerWindowFilter = {}) {
  const processName = filter.processName?.trim().toLowerCase().replace(/\.exe$/, '');
  const title = filter.title?.trim().toLowerCase();
  const filtered = !!(filter.processId !== undefined || processName || title);
  const windows = value.windows.filter(window => (filter.processId === undefined || window.processId === filter.processId)
    && (!processName || processNameOf(window)?.toLowerCase().replace(/\.exe$/, '') === processName)
    && (!title || window.title.toLowerCase().includes(title)));
  const counts = filtered ? { matchedCount: windows.length, totalCount: value.windows.length } : {};
  if (filter.compact === false) return { ...value, windows, ...counts };
  return { capturedAt: value.capturedAt, coordinateSystem: value.coordinateSystem, ...counts,
    windows: windows.map(window => {
      const name = processNameOf(window);
      return { id: window.id, title: window.title, ...(name ? { processName: name } : {}), processId: window.processId, className: window.className,
        ...(window.minimized ? { minimized: true } : {}), ...(window.foreground ? { foreground: true } : {}),
        ...(window.ownerId && window.ownerId !== '0' ? { ownerId: window.ownerId } : {}), bounds: window.bounds };
    }),
    displays: value.displays.map(display => ({ id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, ...(display.primary ? { primary: true } : {}) })) };
}

/** 只精简发给模型的副本；内部完整观察继续用于元素、进程和坐标校验。 */
export function observationForModel(value: ComputerObservation, compact = true) {
  const { screenshot, ...source } = value;
  const observation = { ...source, ...(screenshot ? { coordinateSpace: 'image' as const } : {}) };
  const capture = screenshot ? { ...screenshot, data: undefined } : undefined;
  if (!compact) return { ...observation, ...(capture ? { screenshot: capture } : {}) };
  const { commandLine, captureBounds, ...window } = observation.window;
  return { ...observation, window,
    elementDefaults: { enabled: true, offscreen: false, password: false, focused: false },
    elements: observation.elements.map(element => ({
      id: element.id, ...(element.parentId ? { parentId: element.parentId } : {}), type: element.type,
      ...(element.name ? { name: element.name } : {}), ...(element.automationId ? { automationId: element.automationId } : {}),
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(!element.enabled ? { enabled: false } : {}), ...(element.offscreen ? { offscreen: true } : {}),
      ...(element.password ? { password: true } : {}), ...(element.focused ? { focused: true } : {}),
      ...(element.patterns.length ? { patterns: element.patterns } : {}), bounds: element.bounds,
    })), ...(capture ? { screenshot: capture } : {}) };
}
