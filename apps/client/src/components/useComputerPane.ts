import { computed, onUnmounted, ref, watch } from 'vue';
import type { ComputerAction, ComputerElement, ComputerObservation, ComputerOperation, ComputerWindows } from '@graycode/contracts';
import { rpc as call } from '../api';
import { computerState, refreshComputerStatus } from '../computer';

export function useComputerPane(visible: () => boolean) {
  const inventory = ref<ComputerWindows>();
  const selectedWindow = ref('');
  const observation = ref<ComputerObservation>();
  const selectedElement = ref('');
  const filter = ref('');
  const text = ref('');
  const key = ref('Control+A');
  const error = ref('');
  const notice = ref('');
  const busy = ref(false);
  const history = ref<ComputerOperation[]>([]);
  const tab = ref<'screen' | 'controls' | 'history'>('screen');
  const pointerMode = ref<'inspect' | 'click' | 'double' | 'right' | 'drag'>('inspect');
  const imageSize = ref(1280);
  const actualSize = ref(false);
  let epoch = 0;
  let disposed = false;
  let refreshOnIdle = false;
  let gesture: { id: string; pointerId: number; x: number; y: number } | undefined;
  const windows = computed(() => inventory.value?.windows.filter(value => !filter.value || `${value.title} ${value.executable}`.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())) ?? []);
  const element = computed(() => observation.value?.elements.find(value => value.id === selectedElement.value));
  const elements = computed(() => observation.value?.elements.filter(value => !value.offscreen) ?? []);
  const status = computed(() => computerState.status);
  const imageUrl = computed(() => {
    const capture = observation.value?.screenshot;
    return capture ? `data:${capture.mimeType};base64,${capture.data}` : '';
  });
  const patternActions = computed(() => {
    const patterns = element.value?.patterns ?? [];
    return ([['Invoke', 'invoke', '点击控件'], ['Value', 'setValue', '填写内容'], ['SelectionItem', 'select', '选中'], ['Toggle', 'toggle', '切换'], ['ExpandCollapse', 'expand', '展开'], ['ExpandCollapse', 'collapse', '收起']] as const)
      .filter(([pattern]) => patterns.includes(pattern));
  });
  function invalidate() {
    epoch++; observation.value = undefined; selectedElement.value = ''; gesture = undefined;
  }
  async function perform(work: () => Promise<unknown>) {
    if (busy.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try { await work(); } catch (cause) { if (!disposed) error.value = (cause as Error).message; }
    finally {
      if (!disposed) await refreshComputerStatus();
      busy.value = false;
      if (refreshOnIdle && !disposed && visible()) { refreshOnIdle = false; void perform(refreshView); }
    }
  }
  async function readWindows() {
    const value = await call('computer.windows'); if (disposed) return;
    inventory.value = value;
    if (selectedWindow.value && !value.windows.some(item => item.id === selectedWindow.value)) {
      selectedWindow.value = ''; invalidate(); notice.value = '原窗口已关闭，请重新选择。';
    }
  }
  async function observe() {
    if (!selectedWindow.value) return;
    // 刷新失败后不保留可以继续点击的旧图。
    invalidate(); const current = epoch;
    const value = await call('computer.observe', {
      windowId: selectedWindow.value, screenshot: status.value?.screenshotAvailable !== false,
      frameOnly: tab.value !== 'controls', width: imageSize.value, height: imageSize.value,
    });
    if (current !== epoch || disposed || !visible()) return;
    observation.value = value; selectedElement.value = ''; gesture = undefined;
  }
  async function chooseWindow(id: string) {
    invalidate(); selectedWindow.value = id; pointerMode.value = 'inspect';
    if (tab.value === 'history') tab.value = 'screen';
    await observe();
  }
  async function chooseTab(value: typeof tab.value) {
    tab.value = value;
    if (value === 'history') history.value = await call('computer.recent');
    else if (value === 'controls' || !observation.value) await observe();
  }
  async function action(args: Omit<ComputerAction, 'observationId'>) {
    const current = observation.value;
    if (!current) throw new Error('请先刷新窗口画面。');
    await call('computer.acquire', { windowIds: [current.window.id] });
    let failure: unknown;
    try {
      if (!disposed && visible() && observation.value?.id === current.id) {
        await call('computer.action', { ...args, observationId: current.id, operationId: crypto.randomUUID() });
        notice.value = '操作已完成。';
      }
    } catch (cause) { failure = cause; } finally {
      // 动作会消费观察记录；释放失败时也不能继续使用旧画面操作。
      invalidate();
      try { await call('computer.release'); }
      catch (cause) { failure ??= new Error(`${notice.value || ''}释放控制权失败：${(cause as Error).message}`); }
    }
    if (failure) throw failure;
    if (!disposed && visible()) {
      try { await observe(); }
      catch (cause) { throw new Error(`操作已完成，但刷新画面失败：${(cause as Error).message}。请刷新后检查结果。`); }
    }
  }
  function chooseElement(value: ComputerElement) { selectedElement.value = value.id; }
  function point(event: PointerEvent) {
    const rect = (event.currentTarget as HTMLImageElement).getBoundingClientRect(), capture = observation.value?.screenshot;
    if (!capture || !rect.width || !rect.height) return;
    return { x: Math.max(0, Math.min(capture.width - 1, Math.floor((event.clientX - rect.x) * capture.width / rect.width))),
      y: Math.max(0, Math.min(capture.height - 1, Math.floor((event.clientY - rect.y) * capture.height / rect.height))) };
  }
  function pointerDown(event: PointerEvent) {
    if (pointerMode.value === 'inspect' || busy.value || event.button !== 0) return;
    const start = point(event); if (!start || !observation.value) return;
    gesture = { ...start, id: observation.value.id, pointerId: event.pointerId };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); event.preventDefault();
  }
  function cancelPointer() { gesture = undefined; }
  function pointerUp(event: PointerEvent) {
    const start = gesture; gesture = undefined;
    if (busy.value || pointerMode.value === 'inspect' || !start || start.pointerId !== event.pointerId || start.id !== observation.value?.id) return;
    const end = point(event); if (!end) return;
    if (pointerMode.value === 'drag') void perform(() => action({ action: 'drag', coordinateSpace: 'image', x: start.x, y: start.y, toX: end.x, toY: end.y }));
    else void perform(() => action({ action: 'click', coordinateSpace: 'image', ...end, button: pointerMode.value === 'right' ? 'right' : 'left', clickCount: pointerMode.value === 'double' ? 2 : 1 }));
  }
  async function refreshView() { await refreshComputerStatus(); await readWindows(); if (selectedWindow.value && visible()) await observe(); }
  watch(visible, value => {
    if (value) { if (busy.value) refreshOnIdle = true; else void perform(refreshView); }
    else { refreshOnIdle = false; invalidate(); pointerMode.value = 'inspect'; }
  }, { immediate: true });
  onUnmounted(() => { disposed = true; invalidate(); });
  return { inventory, selectedWindow, observation, selectedElement, filter, text, key, error, notice, busy, history, tab,
    pointerMode, imageSize, actualSize, windows, element, elements, status, imageUrl, patternActions,
    perform, readWindows, observe, chooseWindow, chooseTab, action, chooseElement, pointerDown, pointerUp, cancelPointer };
}
