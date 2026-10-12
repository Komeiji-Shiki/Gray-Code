export const SHELL_SHORTCUTS_MESSAGE = 'graycode.shellShortcuts';
export const SHELL_SHORTCUT_MESSAGE = 'graycode.shellShortcut';

export interface ShellShortcutBinding {
  command: string;
  key: string;
  primary?: boolean;
  shift?: boolean;
  accelerator: string;
}

// 外壳与原生菜单共用键位表，菜单只显示由外壳分派的快捷键。
export const shellShortcuts = {
  newConversation: { key: 'n', primary: true, accelerator: 'CmdOrCtrl+N' },
  toggleSidebar: { key: 'b', primary: true, accelerator: 'CmdOrCtrl+B' },
  projectSearch: { key: 'f', primary: true, shift: true, accelerator: 'CmdOrCtrl+Shift+F' },
  'debug.continue': { key: 'f5', accelerator: 'F5' },
  'debug.stop': { key: 'f5', shift: true, accelerator: 'Shift+F5' },
  'debug.next': { key: 'f10', accelerator: 'F10' },
  'debug.stepIn': { key: 'f11', accelerator: 'F11' },
  'debug.stepOut': { key: 'f11', shift: true, accelerator: 'Shift+F11' },
} satisfies Record<string, Omit<ShellShortcutBinding, 'command'>>;

interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** iframe 只匹配外壳下发的组合，不维护第二份键位表。 */
export function matchShellShortcut(event: ShortcutKeyEvent, bindings: readonly ShellShortcutBinding[]): ShellShortcutBinding | undefined {
  if (event.altKey) return;
  return bindings.find(binding => event.key.toLowerCase() === binding.key
    && (event.ctrlKey || event.metaKey) === !!binding.primary && event.shiftKey === !!binding.shift);
}
