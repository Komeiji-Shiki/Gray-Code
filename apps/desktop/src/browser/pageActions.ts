import { browserKey } from './keys';

const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS' }); };

/** 参数类型和范围已由工具 schema 校验；这里只检查 schema 表达不了的按动作组合，在派发前区分"未执行"。 */
export function validateActionArguments(args: Record<string, unknown>): void {
  const action = String(args.action);
  if (action === 'navigate' && (typeof args.url !== 'string' || !args.url.trim())) invalid('navigate 需要 url 指定页面地址。');
  if (['fill', 'select', 'check'].includes(action) && !args.ref) invalid(`${action} 需要目标控件的 ref。`);
  if (['type', 'fill'].includes(action) && typeof args.text !== 'string') invalid('请提供需要输入的文本。');
  if (action === 'select' && (args.values !== undefined) === (args.labels !== undefined)) invalid('select 需要 values 或 labels，两者只能提供一个。');
  if (action === 'check' && typeof args.checked !== 'boolean') invalid('check 需要 checked 指定目标状态。');
  if (action === 'check' && (args.button !== undefined && args.button !== 'left' || args.clickCount !== undefined && args.clickCount !== 1)) invalid('check 仅使用一次左键点击。');
  if (action === 'press') {
    if (typeof args.key !== 'string' || !args.key) invalid('press 需要 key 指定按键。');
    try { browserKey(String(args.key)); } catch (error) { invalid((error as Error).message); }
  }
  if (action === 'scroll' && args.direction === undefined) invalid('请提供滚动方向。');
  const coordinates = action === 'drag' ? ['x', 'y', 'toX', 'toY']
    : !args.ref && (action === 'click' || action === 'hover' || action === 'scroll' && (args.x !== undefined || args.y !== undefined)) ? ['x', 'y'] : [];
  for (const key of coordinates) if (args[key] === undefined) invalid(`${action} 需要 ref，或截图坐标 ${coordinates.join('、')}。`);
  if (action === 'dialog' && typeof args.accept !== 'boolean') invalid('dialog 需要 accept 指定接受或取消。');
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
