/** 将浏览器工具中的组合键转换为固定的 Chromium 键盘事件字段。 */
export function browserKey(value: string): { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string } {
  const parts = value.split('+'), name = parts.pop()!;
  const modifiersByName: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
  let modifiers = 0;
  for (const part of parts) {
    const flag = modifiersByName[part.toLowerCase()];
    if (!flag) throw new Error('不支持的组合键修饰符：' + part);
    modifiers |= flag;
  }
  const named: Record<string, [string, number, string?]> = {
    Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
    Delete: ['Delete', 46], Insert: ['Insert', 45], Space: ['Space', 32, ' '],
  };
  const special = named[name];
  let key = name, code: string, windowsVirtualKeyCode: number, text: string | undefined;
  if (special) { [code, windowsVirtualKeyCode, text] = special; if (name === 'Space') key = ' '; }
  else if (/^[a-z0-9]$/i.test(name)) {
    key = modifiers & 8 ? name.toUpperCase() : name.toLowerCase();
    code = /^[0-9]$/.test(name) ? 'Digit' + name : 'Key' + name.toUpperCase();
    windowsVirtualKeyCode = name.toUpperCase().charCodeAt(0); text = key;
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(name)) { code = name; windowsVirtualKeyCode = 111 + Number(name.slice(1)); }
  else throw new Error('不支持的按键：' + value);
  return { key, code, windowsVirtualKeyCode, modifiers, ...(text && !(modifiers & 7) ? { text } : {}) };
}
