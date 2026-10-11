const named: Record<string, [string, number, string?]> = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  Delete: ['Delete', 46], Insert: ['Insert', 45], Space: ['Space', 32, ' '],
};
// 模型常写的简称与 DOM key 名称不同，统一映射到上表的正式名称。
const aliases: Record<string, string> = {
  esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown', spacebar: 'Space', ' ': 'Space',
};
/** US 键盘上的标点：[未按 Shift 的字符, Shift 字符, code, Windows 虚拟键码]。 */
const punctuation: Array<[string, string, string, number]> = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187], ['[', '{', 'BracketLeft', 219],
  [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220], [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222],
  [',', '<', 'Comma', 188], ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
];
const shiftedDigits = ')!@#$%^&*(';

/** 将浏览器工具中的组合键转换为固定的 Chromium 键盘事件字段。 */
export function browserKey(value: string): { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string } {
  // 末尾的 + 是按键本身（如 Control++），不是分隔符。
  const parts = value === '+' ? ['+'] : value.endsWith('+') ? [...value.slice(0, -2).split('+'), '+'] : value.split('+');
  const raw = parts.pop()!.trim() || ' ';
  const modifiersByName: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, win: 4, shift: 8 };
  let modifiers = 0;
  for (const part of parts) {
    const flag = modifiersByName[part.trim().toLowerCase()];
    if (!flag) throw new Error('不支持的组合键修饰符：' + part);
    modifiers |= flag;
  }
  const name = aliases[raw.toLowerCase()] ?? Object.keys(named).find(key => key.toLowerCase() === raw.toLowerCase()) ?? raw;
  const special = named[name];
  const symbol = punctuation.find(([plain, shifted]) => plain === name || shifted === name);
  const shiftedDigit = shiftedDigits.indexOf(name);
  let key = name, code: string, windowsVirtualKeyCode: number, text: string | undefined;
  if (special) { [code, windowsVirtualKeyCode, text] = special; if (name === 'Space') key = ' '; }
  else if (/^[a-z0-9]$/i.test(name)) {
    key = modifiers & 8 ? name.toUpperCase() : name.toLowerCase();
    code = /^[0-9]$/.test(name) ? 'Digit' + name : 'Key' + name.toUpperCase();
    windowsVirtualKeyCode = name.toUpperCase().charCodeAt(0); text = key;
  } else if (symbol) {
    if (name === symbol[1]) modifiers |= 8;
    key = modifiers & 8 ? symbol[1] : symbol[0]; [, , code, windowsVirtualKeyCode] = symbol; text = key;
  } else if (shiftedDigit >= 0) {
    modifiers |= 8; key = name; code = 'Digit' + shiftedDigit; windowsVirtualKeyCode = 48 + shiftedDigit; text = key;
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(name)) { key = name.toUpperCase(); code = key; windowsVirtualKeyCode = 111 + Number(name.slice(1)); }
  else throw new Error('不支持的按键：' + value);
  return { key, code, windowsVirtualKeyCode, modifiers, ...(text && !(modifiers & 7) ? { text } : {}) };
}
