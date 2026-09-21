import type { ComputerObservation } from '@graycode/contracts';

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
