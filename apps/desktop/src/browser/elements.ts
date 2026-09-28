// 这些固定函数只接收值参数，不接受模型提供的脚本或选择器。
export const prepareTextInput = `function(text) {
  if (!this.isConnected || this.matches(':disabled') || this.readOnly || this.closest('[inert]')) return 'not-editable';
  const view = this.ownerDocument.defaultView;
  if (this instanceof view.HTMLInputElement || this instanceof view.HTMLTextAreaElement) {
    if (this instanceof view.HTMLInputElement && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(this.type)) return 'not-editable';
    this.focus();
    if (this instanceof view.HTMLInputElement && ['number', 'date', 'datetime-local', 'month', 'time', 'week', 'range', 'color'].includes(this.type)) {
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set;
      const previous = this.value;
      setter.call(this, text);
      if (this.value !== text) { setter.call(this, previous); return 'invalid-value'; }
      this.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
      this.dispatchEvent(new view.Event('change', { bubbles: true }));
      return 'filled';
    }
    this.select(); return 'selected';
  }
  if (this.isContentEditable) {
    this.focus(); const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
    const selection = view.getSelection(); selection.removeAllRanges(); selection.addRange(range); return 'selected';
  }
  return 'not-editable';
}`;

export const selectElement = `function(values, labels) {
  const view = this.ownerDocument.defaultView;
  if (!(this instanceof view.HTMLSelectElement)) return '此元素不是原生下拉框；自定义菜单请使用 click、press 或 hover。';
  if (!this.isConnected || this.matches(':disabled') || this.closest('[inert]')) return '此下拉框当前不可用。';
  const requested = values === undefined ? labels : values;
  if (!this.multiple && requested.length !== 1) return '单选下拉框需要且只能选择一个选项。';
  const selected = [];
  for (const value of requested) {
    const matches = Array.from(this.options).filter(option => (values === undefined ? option.label : option.value) === value);
    if (matches.length !== 1) return '选项不存在或不唯一，请重新读取下拉框并使用准确的值或标签。';
    if (matches[0].matches(':disabled')) return '所选选项当前不可用。';
    selected.push(matches[0]);
  }
  if (Array.from(this.options).every(option => option.selected === selected.includes(option))) return null;
  this.focus();
  for (const option of this.options) option.selected = selected.includes(option);
  this.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new view.Event('change', { bubbles: true }));
  return null;
}`;

export const checkedState = `function() {
  if (!this.isConnected || this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true' || this.closest('[inert]')) return { error: '此选项当前不可用。' };
  const view = this.ownerDocument.defaultView;
  if (this instanceof view.HTMLInputElement && ['checkbox', 'radio'].includes(this.type))
    return { checked: this.indeterminate ? 'mixed' : this.checked, radio: this.type === 'radio' };
  if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(this.getAttribute('role')))
    return { checked: this.getAttribute('aria-checked'), radio: this.getAttribute('role').includes('radio') };
  return { error: '此元素不是复选框、单选框或开关。' };
}`;

// 命中检测逐层穿过 Shadow DOM，同时检查外部遮挡；使用可见部分，避免大元素中心在屏幕外。
export const pointInElement = `function(allowDisabled) {
  if (!this.isConnected || (!allowDisabled && (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true')) || this.closest('[inert]')) return null;
  const view = this.ownerDocument.defaultView;
  const rects = Array.from(this.getClientRects());
  for (let index = 0; index < rects.length; index++) {
    const r = rects[index], left = Math.max(0, r.left), right = Math.min(view.innerWidth, r.right);
    const top = Math.max(0, r.top), bottom = Math.min(view.innerHeight, r.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
      let target = this, clear = true;
      while (target) {
        const root = target.getRootNode(), hit = root.elementFromPoint(x, y);
        if (hit !== target && !target.contains(hit)) { clear = false; break; }
        target = root.host;
      }
      if (clear) return { index, u: (x - r.left) / r.width, v: (y - r.top) / r.height };
    }
  }
  return null;
}`;
