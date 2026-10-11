import { browserKey } from './keys';

const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS' }); };

/** 派发前校验纯参数，让调用方准确区分未执行与执行后结果未知。 */
export function validateActionArguments(args: Record<string, unknown>): void {
  const action = args.action;
  if (['navigate', 'back', 'forward', 'reload'].includes(String(action))) {
    if (action === 'navigate' && (typeof args.url !== 'string' || !args.url.trim())) invalid('navigate 需要 url 指定页面地址。');
    return;
  }
  if (!['click', 'hover', 'scroll', 'drag', 'type', 'fill', 'select', 'check', 'press', 'dialog'].includes(String(action))) invalid('不支持的页面操作。');
  if (args.ref !== undefined && (typeof args.ref !== 'string' || !args.ref)) invalid('ref 必须是页面返回的元素引用。');
  if (['fill', 'select', 'check'].includes(String(action)) && !args.ref) invalid(`${action} 需要目标控件的 ref。`);
  if (['type', 'fill'].includes(String(action)) && typeof args.text !== 'string') invalid('请提供需要输入的文本。');
  if (action === 'select') {
    const choices = args.values ?? args.labels;
    if ((args.values !== undefined) === (args.labels !== undefined) || !Array.isArray(choices) || choices.some(value => typeof value !== 'string'))
      invalid('select 需要 values 或 labels 字符串数组，两者只能提供一个。');
  }
  if (action === 'check' && typeof args.checked !== 'boolean') invalid('check 需要 checked 指定目标状态。');
  if (action === 'press') {
    if (typeof args.key !== 'string' || !args.key) invalid('press 需要 key 指定按键。');
    try { browserKey(String(args.key)); } catch (error) { invalid((error as Error).message); }
  }
  if (args.button !== undefined && !['left', 'middle', 'right'].includes(String(args.button))) invalid('不支持的鼠标按键。');
  if (args.clickCount !== undefined && args.clickCount !== 1 && args.clickCount !== 2) invalid('clickCount 只能是 1 或 2。');
  if (action === 'check' && (args.button !== undefined && args.button !== 'left' || args.clickCount !== undefined && args.clickCount !== 1)) invalid('check 仅使用一次左键点击。');
  if (action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(String(args.direction))) invalid('请提供滚动方向。');
    if (args.distance !== undefined && (typeof args.distance !== 'number' || !Number.isFinite(args.distance) || args.distance <= 0)) invalid('滚动距离必须是正数。');
  }
  const coordinates = action === 'drag' || !args.ref && (action === 'click' || action === 'hover' || action === 'scroll' && (args.x !== undefined || args.y !== undefined));
  if (coordinates) for (const key of action === 'drag' ? ['x', 'y', 'toX', 'toY'] : ['x', 'y']) {
    if (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || Number(args[key]) < 0) invalid(`${key} 必须是截图范围内的非负坐标。`);
  }
  if (action === 'drag' && args.durationMs !== undefined && (typeof args.durationMs !== 'number' || !Number.isFinite(args.durationMs) || args.durationMs < 0)) invalid('拖动时间必须是非负数。');
  if (action === 'dialog') {
    if (typeof args.accept !== 'boolean') invalid('dialog 需要 accept 指定接受或取消。');
    if (args.promptText !== undefined && typeof args.promptText !== 'string') invalid('promptText 必须是字符串。');
  }
}

export interface BrowserDialog { type: string; message: string; defaultPrompt?: string; url?: string }
export interface BrowserFileChooser { ref?: string; multiple: boolean; frameId?: string }
export interface BrowserInteractionState { dialog?: BrowserDialog; fileChooser?: BrowserFileChooser }

/** 固定读取函数避免完整文本经 CDP 传回后才在宿主截断。偏移按 JS 字符位置计算，与快照预算一致。 */
export const readElementText = `function(startChar, maxChars) {
  if (!this.isConnected) return null;
  const element = this.nodeType === 3 ? this.parentElement : this;
  const text = this.nodeType === 3 ? this.textContent :
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? String(element.value ?? '') : String(element.innerText ?? element.textContent ?? '');
  return { text: text.slice(startChar, startChar + maxChars), total: text.length };
}`;

export const readElementState = `function() {
  if (!this.isConnected) return { visible: false, missing: true };
  const element = this.nodeType === 3 ? this.parentElement : this;
  if (!element) return { visible: false };
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const visible = style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) &&
    Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  const disabled = element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || !!element.closest('[inert]');
  const checked = typeof element.checked === 'boolean' ? element.indeterminate ? 'mixed' : element.checked : element.getAttribute('aria-checked');
  return { visible, enabled: !disabled, disabled, checked: checked === true || checked === 'true' ? true : checked === false || checked === 'false' ? false : undefined };
}`;
